import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from "vitest";
import {
  createInternalPtyHarness,
  createInternalChildProcessHarness,
  createBundleSyncHarness,
  INTERNAL_TEST_TOKEN,
  PNG_BYTES,
} from "../helpers/internal-routes.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const ptyHarness = createInternalPtyHarness();
const childProcessHarness = createInternalChildProcessHarness();
const bundleSyncHarness = createBundleSyncHarness();

vi.mock("node-pty", () => ptyHarness.mockModule());
vi.mock("node:child_process", async (importOriginal) =>
  childProcessHarness.mockModule(await importOriginal()),
);
vi.mock("../../src/services/bundle-sync.js", () => bundleSyncHarness.mockModule());
const { buildApp } = await import("../../src/app.js");
const { clearAgentsCacheForTests } = await import("../../src/services/agent-detect.js");
const { execFileSync } = await import("node:child_process");
const { gitEnv } = await import("../../src/services/git-env.js");
const { SIGNATURE_HEADER, TIMESTAMP_HEADER, NONCE_HEADER, buildCanonicalString, hashBody, sign } =
  await import("../../src/services/request-signature.js");

const TOKEN = INTERNAL_TEST_TOKEN;

beforeEach(() => {
  ptyHarness.reset();
  childProcessHarness.reset();
  bundleSyncHarness.reset();
  clearAgentsCacheForTests();
});

describe("internal routes: empty MULLION_AGENT_TOKEN guard (issue #245)", () => {
  let projectsRoot: string;
  let sessionsDir: string;

  beforeAll(async () => {
    projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-empty-token-root-"));
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "internal-empty-token-sessions-"));
    process.env.MULLION_ROLE = "agent";
    process.env.PROJECTS_ROOTS = projectsRoot;
    // No MULLION_AGENT_TOKEN — mirrors an enrolled agent before (or
    // without) any successful self-registration, when app.agentSession is
    // also still undefined. Issue #3577: booting needs a stored identity;
    // port 1 fails fast (connection refused) so the plugin's fire-and-forget
    // registerWithRetry() doesn't hang the test or make a real network call.
    const { identityStatePath } = await import("../../src/services/agent-identity.js");
    process.env.SESSIONS_DIR = sessionsDir;
    fs.writeFileSync(
      identityStatePath(sessionsDir),
      JSON.stringify({ hostId: "host-1", machineCredential: "a1".repeat(32) }),
    );
    process.env.MULLION_PRIMARY_URL = "http://127.0.0.1:1";
  });

  afterAll(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    delete process.env.MULLION_ROLE;
    delete process.env.PROJECTS_ROOTS;
    delete process.env.SESSIONS_DIR;
    delete process.env.MULLION_PRIMARY_URL;
  });

  it("rejects a request with an empty Authorization Bearer value when no static token is configured", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/internal/discover",
      headers: { authorization: "Bearer " },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a request with no Authorization header at all when no static token is configured", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/internal/discover" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  // Hermes review, PR #528: the TTL must bound a leaked session credential
  // on the ACCEPTING side too — resolveCurrentCredentials/rotateSession already
  // enforce it on the issuing side, but the agent's own inbound gate
  // didn't check app.agentSession.expiresAt at all before this fix, so a
  // primary that's down (unable to renew) would leave a past-TTL session
  // id accepted here forever.
  it("rejects a request bearing a session id that matches but has already expired", async () => {
    const app = await buildApp();
    app.agentSession = {
      hostId: "host-x",
      sessionId: "expired-session-id",
      sessionSecret: "unused", // pragma: allowlist secret
      expiresAt: new Date(Date.now() - 1000),
    };
    const res = await app.inject({
      method: "GET",
      url: "/internal/discover",
      headers: { authorization: "Bearer expired-session-id" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  // Issue #249 / roadmap 7.5: a session-matched request must ALSO carry a
  // valid signature — a bare bearer token is no longer sufficient on its
  // own once a session credential is involved. See the dedicated
  // "signature verification" describe block below for the fuller set of
  // missing/stale/replayed/forged cases; this one stays focused on the
  // narrow claim its name makes.
  it("accepts a request bearing a session id that matches and has not yet expired, when properly signed", async () => {
    const app = await buildApp();
    const sessionSecret = "live-session-secret"; // pragma: allowlist secret
    app.agentSession = {
      hostId: "host-x",
      sessionId: "live-session-id",
      sessionSecret,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const timestamp = String(Date.now());
    const nonce = "nonce-live-session";
    const canonicalString = buildCanonicalString({
      method: "GET",
      requestTarget: "/internal/discover",
      timestamp,
      nonce,
      bodyHashed: true,
      bodyHash: hashBody(""),
    });
    const res = await app.inject({
      method: "GET",
      url: "/internal/discover",
      headers: {
        authorization: "Bearer live-session-id",
        [SIGNATURE_HEADER]: sign(sessionSecret, canonicalString),
        [TIMESTAMP_HEADER]: timestamp,
        [NONCE_HEADER]: nonce,
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects a request bearing a matching, unexpired session id with NO signature headers at all", async () => {
    const app = await buildApp();
    app.agentSession = {
      hostId: "host-x",
      sessionId: "live-session-id",
      sessionSecret: "live-session-secret", // pragma: allowlist secret
      expiresAt: new Date(Date.now() + 60_000),
    };
    const res = await app.inject({
      method: "GET",
      url: "/internal/discover",
      headers: { authorization: "Bearer live-session-id" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("signature verification (issue #249 / roadmap 7.5)", () => {
  let projectsRoot: string;
  const SESSION_ID = "sig-test-session-id";
  const SESSION_SECRET = "sig-test-session-secret"; // pragma: allowlist secret

  beforeAll(() => {
    projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-signature-root-"));
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = TOKEN;
    process.env.PROJECTS_ROOTS = projectsRoot;
  });

  afterAll(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
    delete process.env.MULLION_ROLE;
    delete process.env.MULLION_AGENT_TOKEN;
    delete process.env.PROJECTS_ROOTS;
  });

  async function sessionApp() {
    const app = await buildApp();
    app.agentSession = {
      hostId: "host-x",
      sessionId: SESSION_ID,
      sessionSecret: SESSION_SECRET,
      expiresAt: new Date(Date.now() + 60_000),
    };
    return app;
  }

  function signedHeaders(
    method: string,
    requestTarget: string,
    opts: { bodyHashed: boolean; body?: string; timestamp?: string; nonce?: string } = {
      bodyHashed: true,
    },
  ) {
    const timestamp = opts.timestamp ?? String(Date.now());
    const nonce = opts.nonce ?? `nonce-${Math.random()}`;
    const canonicalString = buildCanonicalString({
      method,
      requestTarget,
      timestamp,
      nonce,
      bodyHashed: opts.bodyHashed,
      bodyHash: opts.bodyHashed ? hashBody(opts.body ?? "") : "",
    });
    return {
      authorization: `Bearer ${SESSION_ID}`,
      [SIGNATURE_HEADER]: sign(SESSION_SECRET, canonicalString),
      [TIMESTAMP_HEADER]: timestamp,
      [NONCE_HEADER]: nonce,
    };
  }

  describe("static-Bearer regression", () => {
    it("a static-token request needs no signature headers and is completely unaffected", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/discover",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("a static-token request bearing garbage signature headers is unaffected too (they're simply never checked)", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/discover",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          [SIGNATURE_HEADER]: "garbage",
          [TIMESTAMP_HEADER]: "garbage",
          [NONCE_HEADER]: "garbage",
        },
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });

  // Hermes review, PR #531: AgentSession.sessionSecret is typed `string`
  // (never optional), but a primary predating #528 could still send a
  // register response whose body has no session_secret field at all,
  // making this undefined at runtime despite the type. Must fail closed
  // with a 401, NOT the same way as the documented null (static-Bearer)
  // sentinel (that would skip verification entirely — a bypass) and NOT by
  // throwing inside verify()'s crypto.createHmac (a 500).
  describe("malformed session_secret (pre-#528 primary compatibility)", () => {
    it("401s cleanly instead of 500ing when sessionSecret is undefined at runtime", async () => {
      const app = await buildApp();
      app.agentSession = {
        hostId: "host-x",
        sessionId: "no-secret-session-id",
        // Cast past the type system deliberately — this simulates a
        // primary whose JSON response omitted session_secret, which the
        // type (string, never optional) can't itself express.
        sessionSecret: undefined as unknown as string,
        expiresAt: new Date(Date.now() + 60_000),
      };
      const timestamp = String(Date.now());
      const nonce = "nonce-no-secret";
      const res = await app.inject({
        method: "GET",
        url: "/internal/discover",
        headers: {
          authorization: "Bearer no-secret-session-id",
          [SIGNATURE_HEADER]: "irrelevant-cant-be-computed-without-a-secret",
          [TIMESTAMP_HEADER]: timestamp,
          [NONCE_HEADER]: nonce,
        },
      });
      expect(res.statusCode).toBe(401);
      // Hermes review, PR #531: a distinct message from "signed request
      // required" — this request WAS properly signed (from the caller's
      // point of view); the broken state is server-side (this agent's own
      // registered session has no usable secret), and conflating the two
      // messages would mislead debugging on the one side that can't see
      // why its correctly-signed request was rejected.
      expect(res.json().message).toBe("invalid session credential");
      await app.close();
    });
  });

  describe("body-hash verification (POST /internal/sessions/:id/stash-seed)", () => {
    it("accepts a correctly-signed request whose signature covers the actual body", async () => {
      const app = await sessionApp();
      const body = JSON.stringify({ seed: "real-seed" });
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/s1/stash-seed",
        headers: {
          "content-type": "application/json",
          ...signedHeaders("POST", "/internal/sessions/s1/stash-seed", {
            bodyHashed: true,
            body,
          }),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(204);
      await app.close();
    });

    it("rejects a request whose body was tampered with after signing", async () => {
      const app = await sessionApp();
      const signedBody = JSON.stringify({ seed: "original-seed" });
      const tamperedBody = JSON.stringify({ seed: "tampered-seed" });
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/s1/stash-seed",
        headers: {
          "content-type": "application/json",
          // Signature covers `signedBody`, but the actual payload sent is
          // `tamperedBody` — the hash the agent recomputes won't match.
          ...signedHeaders("POST", "/internal/sessions/s1/stash-seed", {
            bodyHashed: true,
            body: signedBody,
          }),
        },
        payload: tamperedBody,
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("rejects a request whose method was tampered with (signature computed for GET, sent as POST)", async () => {
      const app = await sessionApp();
      const body = JSON.stringify({ seed: "x" });
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/s1/stash-seed",
        headers: {
          "content-type": "application/json",
          ...signedHeaders("GET", "/internal/sessions/s1/stash-seed", { bodyHashed: true, body }),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("rejects a replayed nonce even on a second, otherwise-identical request", async () => {
      const app = await sessionApp();
      const body = JSON.stringify({ seed: "x" });
      const headers = {
        "content-type": "application/json",
        ...signedHeaders("POST", "/internal/sessions/s1/stash-seed", { bodyHashed: true, body }),
      };
      const first = await app.inject({
        method: "POST",
        url: "/internal/sessions/s1/stash-seed",
        headers,
        payload: body,
      });
      expect(first.statusCode).toBe(204);

      const second = await app.inject({
        method: "POST",
        url: "/internal/sessions/s1/stash-seed",
        headers,
        payload: body,
      });
      expect(second.statusCode).toBe(401);
      await app.close();
    });

    it("rejects a stale timestamp even with an otherwise-correct signature", async () => {
      const app = await sessionApp();
      const body = JSON.stringify({ seed: "x" });
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/s1/stash-seed",
        headers: {
          "content-type": "application/json",
          ...signedHeaders("POST", "/internal/sessions/s1/stash-seed", {
            bodyHashed: true,
            body,
            timestamp: String(Date.now() - 60_000),
          }),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });

  describe("unsigned-body path (POST /internal/uploads)", () => {
    it("accepts an upload whose signature does NOT cover the actual image bytes", async () => {
      const app = await sessionApp();
      const cwd = fs.mkdtempSync(path.join(projectsRoot, "upload-cwd-"));
      const requestTarget = `/internal/uploads?cwd=${encodeURIComponent(cwd)}&mime=image%2Fpng`;
      const res = await app.inject({
        method: "POST",
        url: requestTarget,
        headers: {
          "content-type": "image/png",
          // bodyHashed: false — matches internal.ts's own independent
          // isUnsignedBodyPath(request.url) determination for this path;
          // the signature here covers NOTHING about the actual PNG bytes
          // below, and must still be accepted.
          ...signedHeaders("POST", requestTarget, { bodyHashed: false }),
        },
        payload: PNG_BYTES,
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });
  // Mullion-owned checkout root — POST /internal/git-clone, against a real
  // temp bare repo. The route only accepts https URLs, so a throwaway $HOME
  // gitconfig rewrites the fake https URL onto the bare repo's file path
  // (git passes through the node:child_process mock above).
  describe("POST /internal/git-clone", () => {
    const CLONE_URL = "https://example.test/o/widget.git";
    const CLONE_TOKEN = "ghp_cloneSecretToken123"; // pragma: allowlist secret
    let cloneRoot: string;
    let scratch: string;
    let bare: string;
    let prevHome: string | undefined;
    let prevRoots: string | undefined;
    let prevTrace: string | undefined;

    const sh = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf8" });

    beforeEach(() => {
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), "internal-clone-scratch-"));
      cloneRoot = path.join(scratch, "roots");
      fs.mkdirSync(cloneRoot);
      bare = path.join(scratch, "widget.git");
      const seed = path.join(scratch, "seed");
      fs.mkdirSync(seed);
      sh(seed, "init", "-q", "-b", "trunk");
      sh(seed, "commit", "-q", "--allow-empty", "-m", "i");
      sh(scratch, "clone", "-q", "--bare", seed, bare);
      fs.writeFileSync(
        path.join(scratch, ".gitconfig"),
        `[url "file://${bare}"]\n\tinsteadOf = ${CLONE_URL}\n`,
      );
      prevHome = process.env.HOME;
      prevRoots = process.env.PROJECTS_ROOTS;
      prevTrace = process.env.GIT_TRACE;
      process.env.HOME = scratch;
      process.env.PROJECTS_ROOTS = cloneRoot;
    });

    afterEach(() => {
      process.env.HOME = prevHome;
      process.env.PROJECTS_ROOTS = prevRoots;
      if (prevTrace === undefined) delete process.env.GIT_TRACE;
      else process.env.GIT_TRACE = prevTrace;
      fs.rmSync(scratch, { recursive: true, force: true });
    });

    async function clone(payload: Record<string, unknown>) {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/git-clone",
        payload,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      await app.close();
      return res;
    }

    it("clones into <first root>/<name>, then reuses the same repo on a repeat call", async () => {
      const first = await clone({ url: CLONE_URL, name: "widget" });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({
        ok: true,
        cwd: path.join(fs.realpathSync(cloneRoot), "widget"),
        defaultBranch: "trunk",
        reused: false,
      });
      expect(fs.existsSync(path.join(cloneRoot, "widget", ".git"))).toBe(true);

      const again = await clone({ url: CLONE_URL, name: "widget" });
      expect(again.json()).toMatchObject({ ok: true, reused: true, defaultBranch: "trunk" });
      expect(fs.existsSync(path.join(cloneRoot, "widget-2"))).toBe(false);
    });

    it("suffixes -2, -3 past a different repo, a non-git directory and a file", async () => {
      // widget: a different repo; widget-2: a non-empty plain directory.
      fs.mkdirSync(path.join(cloneRoot, "widget", ".git"), { recursive: true });
      fs.writeFileSync(
        path.join(cloneRoot, "widget", ".git", "config"),
        '[remote "origin"]\n\turl = https://example.test/o/other.git\n',
      );
      fs.mkdirSync(path.join(cloneRoot, "widget-2"));
      fs.writeFileSync(path.join(cloneRoot, "widget-2", "notes.txt"), "x");
      fs.writeFileSync(path.join(cloneRoot, "widget-3"), "a file");

      const res = await clone({ url: CLONE_URL, name: "widget" });
      expect(res.json()).toMatchObject({ ok: true, reused: false });
      expect(res.json().cwd).toBe(path.join(fs.realpathSync(cloneRoot), "widget-4"));
      expect(fs.readFileSync(path.join(cloneRoot, "widget-2", "notes.txt"), "utf8")).toBe("x");
    });

    it("fails with no-roots when the host has no PROJECTS_ROOTS", async () => {
      process.env.PROJECTS_ROOTS = "";
      const res = await clone({ url: CLONE_URL, name: "widget" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: false, reason: "no-roots" });
    });

    it("refuses a name that could leave the root (400) and a symlinked target (failed)", async () => {
      for (const name of ["../escape", "a/b", ".hidden", ""]) {
        expect((await clone({ url: CLONE_URL, name })).statusCode).toBe(400);
      }
      const outside = path.join(scratch, "outside");
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(cloneRoot, "widget"));
      const res = await clone({ url: CLONE_URL, name: "widget" });
      expect(res.json()).toMatchObject({ ok: false, reason: "failed" });
      expect(res.json().detail).toMatch(/outside/);
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it("only accepts https urls", async () => {
      const res = await clone({ url: "git@github.com:o/r.git", name: "widget" });
      expect(res.json()).toMatchObject({ ok: false, reason: "failed" });
    });

    it("classifies an unreachable remote and never leaks the token", async () => {
      process.env.GIT_TRACE = "1";
      const encoded = Buffer.from(`x-access-token:${CLONE_TOKEN}`).toString("base64");
      const res = await clone({
        url: "https://nonexistent.invalid/o/missing.git",
        name: "missing",
        token: CLONE_TOKEN,
      });
      expect(res.json()).toMatchObject({ ok: false, reason: "unreachable" });
      expect(res.body).not.toContain(CLONE_TOKEN);
      expect(res.body).not.toContain(encoded);
    });

    it("keeps the token out of .git/config on success", async () => {
      const res = await clone({ url: CLONE_URL, name: "widget", token: CLONE_TOKEN });
      expect(res.json()).toMatchObject({ ok: true });
      const config = fs.readFileSync(path.join(cloneRoot, "widget", ".git", "config"), "utf8");
      const encoded = Buffer.from(`x-access-token:${CLONE_TOKEN}`).toString("base64");
      expect(config).not.toContain(CLONE_TOKEN);
      expect(config).not.toContain(encoded);
      expect(config).toContain(CLONE_URL);
    });
  });
});
