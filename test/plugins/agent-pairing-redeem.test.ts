import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts, hostPairings } from "../../src/db/schema.js";
import {
  identityStatePath,
  loadAgentIdentity,
  saveAgentIdentity,
} from "../../src/services/agent-identity.js";
import { redeemPairingCode } from "../../src/services/agent-pairing-redeem.js";
import { main as runAgentPair, parseArgs, readFirstLineFromStdin } from "../../src/agent-pair.js";

const tmpDb = path.join(os.tmpdir(), `agent-pairing-redeem-${process.pid}.db`);

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition never became true");
}

const AGENT_ENV = [
  "MULLION_ROLE",
  "MULLION_PRIMARY_URL",
  "MULLION_ENROLLMENT_TOKEN",
  "MULLION_AGENT_TOKEN",
  "MULLION_AGENT_ADVERTISE_URL",
  "PROJECTS_ROOTS",
  "SESSIONS_DIR",
  "MULLION_HOME",
];

describe("headless agent pairing-code redeem (issue #3437)", () => {
  let primary: FastifyInstance;
  let sessionsDir: string;
  let statePath: string;
  const agents: FastifyInstance[] = [];

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    primary = await buildApp();
  });

  afterAll(async () => {
    await primary.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    for (const k of AGENT_ENV) delete process.env[k];
  });

  function newSessionsDir() {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pairing-sessions-"));
    statePath = identityStatePath(sessionsDir);
  }

  function stubPrimaryFetch(opts: { dropFirstPairResponse?: boolean } = {}) {
    let pairCalls = 0;
    const seenPaths: string[] = [];
    const seenRegisterBodies: Array<Record<string, unknown>> = [];

    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const target = new URL(String(url));
      seenPaths.push(target.pathname);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (target.pathname === "/api/internal/register") {
        seenRegisterBodies.push(body);
      }

      const res = await primary.inject({
        method: (init?.method ?? "GET") as "GET" | "POST",
        url: target.pathname,
        payload: init?.body ? body : undefined,
      });

      if (target.pathname === "/api/internal/pair") {
        pairCalls++;
        if (opts.dropFirstPairResponse && pairCalls === 1) {
          throw new Error("simulated network drop after primary processed pair");
        }
      }

      return new Response(res.body, {
        status: res.statusCode,
        headers: { "content-type": "application/json" },
      });
    });

    return { seenPaths, seenRegisterBodies };
  }

  async function issueCode(label = "headless-agent"): Promise<string> {
    const res = await primary.inject({
      method: "POST",
      url: "/api/host-pairings",
      payload: { label },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { code: string }).code;
  }

  async function bootAgentWithoutBootstrapToken() {
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_PRIMARY_URL = "http://primary.invalid";
    delete process.env.MULLION_ENROLLMENT_TOKEN;
    delete process.env.MULLION_AGENT_TOKEN;
    process.env.PROJECTS_ROOTS = os.tmpdir();
    process.env.SESSIONS_DIR = sessionsDir;
    const agent = await buildApp();
    agents.push(agent);
    await agent.ready();
    return agent;
  }

  afterEach(async () => {
    while (agents.length) await agents.pop()!.close();
    vi.unstubAllGlobals();
    for (const k of AGENT_ENV) delete process.env[k];
    if (sessionsDir) fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  it("redeems a pairing code into a 0600 identity file and boots/renews with no bootstrap token", async () => {
    newSessionsDir();
    const requestPath = path.join(sessionsDir, "pairing-request.json");
    let sawRequestFileBeforeCall = false;
    let requestFileMode = 0;

    const code = await issueCode("single-host");
    const hostsBefore = primary.db.select().from(hosts).all().length;

    const seenRegisterBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const target = new URL(String(url));
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (target.pathname === "/api/internal/pair" && fs.existsSync(requestPath)) {
        sawRequestFileBeforeCall = true;
        requestFileMode = fs.statSync(requestPath).mode & 0o777;
      }
      if (target.pathname === "/api/internal/register") {
        seenRegisterBodies.push(body);
      }
      const res = await primary.inject({
        method: (init?.method ?? "GET") as "GET" | "POST",
        url: target.pathname,
        payload: init?.body ? body : undefined,
      });
      return new Response(res.body, {
        status: res.statusCode,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await redeemPairingCode({
      primaryUrl: "http://primary.invalid/",
      code,
      sessionsDir,
      name: "headless-box",
    });

    expect(sawRequestFileBeforeCall).toBe(true);
    if (process.platform !== "win32") {
      expect(requestFileMode).toBe(0o600);
      expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
    }
    expect(fs.existsSync(requestPath)).toBe(false);

    const pairedIdentity = loadAgentIdentity(statePath);
    expect(pairedIdentity).not.toBeNull();
    expect(pairedIdentity!.hostId).toBe(result.hostId);

    const allHosts = primary.db.select().from(hosts).all();
    expect(allHosts).toHaveLength(hostsBefore + 1);
    const createdHost = allHosts.find((h) => h.id === result.hostId);
    expect(createdHost).toBeDefined();
    expect(createdHost?.machineCredentialEnc).toBeTruthy();

    // Agent boots with MULLION_PRIMARY_URL + identity file and NO bootstrap/manual token, and renews.
    await bootAgentWithoutBootstrapToken();
    await waitUntil(
      () => loadAgentIdentity(statePath)?.machineCredential !== pairedIdentity!.machineCredential,
    );
    const renewedIdentity = loadAgentIdentity(statePath)!;
    expect(renewedIdentity.hostId).toBe(pairedIdentity!.hostId);
    expect(renewedIdentity.machineCredential).not.toBe(pairedIdentity!.machineCredential);
    expect(seenRegisterBodies[0]).toMatchObject({
      hostId: pairedIdentity!.hostId,
      machineCredential: pairedIdentity!.machineCredential,
    });
    expect(seenRegisterBodies[0].token).toBeUndefined();
  });

  it("converges on a single host when the first redeem response is dropped and retried", async () => {
    newSessionsDir();
    const code = await issueCode("interrupted-host");
    const hostsBefore = primary.db.select().from(hosts).all().length;
    stubPrimaryFetch({ dropFirstPairResponse: true });

    await expect(
      redeemPairingCode({
        primaryUrl: "http://primary.invalid",
        code,
        sessionsDir,
      }),
    ).rejects.toThrow(/simulated network drop/);

    // First response was dropped: requestId file remains for retry, no identity file yet.
    expect(fs.existsSync(path.join(sessionsDir, "pairing-request.json"))).toBe(true);
    expect(loadAgentIdentity(statePath)).toBeNull();

    const retried = await redeemPairingCode({
      primaryUrl: "http://primary.invalid",
      code,
      sessionsDir,
    });

    expect(loadAgentIdentity(statePath)?.hostId).toBe(retried.hostId);
    expect(primary.db.select().from(hosts).all()).toHaveLength(hostsBefore + 1);
  });

  // Issue #3499 — a redirect, a stale request file and a transient failure.
  it("explains a redirect from a login gateway without leaking the code or the Location", async () => {
    newSessionsDir();
    const requestPath = path.join(sessionsDir, "pairing-request.json");
    const code = "ab".repeat(32); // pragma: allowlist secret
    const location = "https://login.example.com/?token=super-secret";
    vi.stubGlobal("fetch", async () => new Response(null, { status: 302, headers: { location } }));

    let message = "";
    try {
      await redeemPairingCode({
        primaryUrl: "http://primary.invalid",
        code,
        sessionsDir,
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toMatch(/redirect/i);
    expect(message).toContain("302");
    // Both spellings must be named: `install.sh` reads the pairing primary
    // from MULLION_AGENT_PRIMARY_URL and only falls back to MULLION_PRIMARY_URL
    // in an existing `.env`, so naming just one of them leaves a dead end.
    expect(message).toContain("MULLION_AGENT_PRIMARY_URL");
    expect(message).toContain("MULLION_PRIMARY_URL");
    // Neither the gateway's address nor the code may appear in the message.
    expect(message).not.toContain("login.example.com");
    expect(message).not.toContain("super-secret");
    expect(message).not.toContain(code);
    expect(loadAgentIdentity(statePath)).toBeNull();
    // A redirect is not a definitive rejection: the primary never processed
    // the body, so the request file stays and the retry reuses the requestId.
    expect(fs.existsSync(requestPath)).toBe(true);
  });

  it.each([400, 401])(
    "removes the stale pairing-request.json after a definitive rejection (HTTP %i)",
    async (status) => {
      newSessionsDir();
      const requestPath = path.join(sessionsDir, "pairing-request.json");
      const code = "cd".repeat(32); // pragma: allowlist secret
      vi.stubGlobal("fetch", async () => new Response("{}", { status }));

      await expect(
        redeemPairingCode({ primaryUrl: "http://primary.invalid", code, sessionsDir }),
      ).rejects.toThrow(new RegExp(`HTTP ${status}`));

      expect(fs.existsSync(requestPath)).toBe(false);
      expect(loadAgentIdentity(statePath)).toBeNull();
    },
  );

  it("keeps the request file after a transient 503 so the retry reuses the same requestId", async () => {
    newSessionsDir();
    const requestPath = path.join(sessionsDir, "pairing-request.json");
    const code = "ef".repeat(32); // pragma: allowlist secret
    const seenRequestIds: string[] = [];

    vi.stubGlobal("fetch", async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { requestId: string };
      seenRequestIds.push(body.requestId);
      if (seenRequestIds.length === 1) {
        return new Response("{}", { status: 503 });
      }
      return new Response(
        JSON.stringify({ host_id: "host-after-503", machine_credential: "12".repeat(32) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await expect(
      redeemPairingCode({ primaryUrl: "http://primary.invalid", code, sessionsDir }),
    ).rejects.toThrow(/HTTP 503/);
    // Transient: the request file survives, so the retry converges on the
    // same requestId.
    expect(fs.existsSync(requestPath)).toBe(true);

    await redeemPairingCode({ primaryUrl: "http://primary.invalid", code, sessionsDir });
    expect(seenRequestIds).toHaveLength(2);
    expect(seenRequestIds[1]).toBe(seenRequestIds[0]);
    expect(loadAgentIdentity(statePath)?.hostId).toBe("host-after-503");
  });

  it("keeps the request file after a timeout so the retry reuses the same requestId", async () => {
    newSessionsDir();
    const requestPath = path.join(sessionsDir, "pairing-request.json");
    const code = "34".repeat(32); // pragma: allowlist secret
    const seenRequestIds: string[] = [];

    vi.stubGlobal("fetch", async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { requestId: string };
      seenRequestIds.push(body.requestId);
      if (seenRequestIds.length === 1) {
        // The primary never answers: the timeout aborts the request.
        const signal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          const fail = () => reject(signal?.reason ?? new Error("aborted"));
          if (signal?.aborted) fail();
          else signal?.addEventListener("abort", fail, { once: true });
        });
      }
      return new Response(
        JSON.stringify({ host_id: "host-after-timeout", machine_credential: "56".repeat(32) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await expect(
      redeemPairingCode({
        primaryUrl: "http://primary.invalid",
        code,
        sessionsDir,
        timeoutMs: 50,
      }),
    ).rejects.toThrow();
    expect(fs.existsSync(requestPath)).toBe(true);

    await redeemPairingCode({
      primaryUrl: "http://primary.invalid",
      code,
      sessionsDir,
      timeoutMs: 50,
    });
    expect(seenRequestIds).toHaveLength(2);
    expect(seenRequestIds[1]).toBe(seenRequestIds[0]);
    expect(loadAgentIdentity(statePath)?.hostId).toBe("host-after-timeout");
  });

  it("ignores non-UUID requestId values in pairing-request.json and generates a fresh UUID", async () => {
    newSessionsDir();
    const code = await issueCode("malformed-request-id");
    const crypto = await import("node:crypto");
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    const requestPath = path.join(sessionsDir, "pairing-request.json");
    fs.writeFileSync(
      requestPath,
      JSON.stringify({ codeHash, requestId: "arbitrary-file-payload-not-a-uuid" }),
      { mode: 0o600 },
    );

    let sentRequestId: unknown;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const target = new URL(String(url));
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (target.pathname === "/api/internal/pair") {
        sentRequestId = body.requestId;
      }
      const res = await primary.inject({
        method: (init?.method ?? "GET") as "GET" | "POST",
        url: target.pathname,
        payload: init?.body ? body : undefined,
      });
      return new Response(res.body, {
        status: res.statusCode,
        headers: { "content-type": "application/json" },
      });
    });

    await redeemPairingCode({
      primaryUrl: "http://primary.invalid",
      code,
      sessionsDir,
    });

    expect(sentRequestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(sentRequestId).not.toBe("arbitrary-file-payload-not-a-uuid");
  });

  it("overwrites an existing identity file when re-pairing", async () => {
    newSessionsDir();
    await saveAgentIdentity(statePath, {
      hostId: "old-host-id",
      machineCredential: "a".repeat(64), // pragma: allowlist secret
    });
    const code = await issueCode("re-paired");
    stubPrimaryFetch();

    const result = await redeemPairingCode({
      primaryUrl: "http://primary.invalid",
      code,
      sessionsDir,
    });

    const updated = loadAgentIdentity(statePath);
    expect(updated?.hostId).toBe(result.hostId);
    expect(updated?.hostId).not.toBe("old-host-id");
  });

  it("fails clearly without echoing the code or writing an identity for used, expired, or garbage codes", async () => {
    newSessionsDir();
    stubPrimaryFetch();

    const garbageCode = "not-a-valid-pairing-code-secret-1234"; // pragma: allowlist secret
    let garbageErr = "";
    try {
      await redeemPairingCode({
        primaryUrl: "http://primary.invalid",
        code: garbageCode,
        sessionsDir,
      });
    } catch (err) {
      garbageErr = err instanceof Error ? err.message : String(err);
    }
    expect(garbageErr).toMatch(/invalid pairing code/i);
    expect(garbageErr).not.toContain(garbageCode);
    expect(loadAgentIdentity(statePath)).toBeNull();

    // Used code
    const usedCode = await issueCode("used-code");
    await redeemPairingCode({ primaryUrl: "http://primary.invalid", code: usedCode, sessionsDir });
    fs.rmSync(statePath, { force: true });

    let usedErr = "";
    try {
      await redeemPairingCode({
        primaryUrl: "http://primary.invalid",
        code: usedCode,
        sessionsDir,
      });
    } catch (err) {
      usedErr = err instanceof Error ? err.message : String(err);
    }
    expect(usedErr).toMatch(/invalid, expired, or already used/i);
    expect(usedErr).not.toContain(usedCode);
    expect(loadAgentIdentity(statePath)).toBeNull();

    // Expired code
    const expiredCode = await issueCode("expired-code");
    primary.db
      .update(hostPairings)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .run();

    let expiredErr = "";
    try {
      await redeemPairingCode({
        primaryUrl: "http://primary.invalid",
        code: expiredCode,
        sessionsDir,
      });
    } catch (err) {
      expiredErr = err instanceof Error ? err.message : String(err);
    }
    expect(expiredErr).toMatch(/invalid, expired, or already used/i);
    expect(expiredErr).not.toContain(expiredCode);
    expect(loadAgentIdentity(statePath)).toBeNull();
  });

  it("src/app.ts refuses to boot an agent with neither token nor identity file", async () => {
    newSessionsDir();
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_PRIMARY_URL = "http://primary.invalid";
    delete process.env.MULLION_ENROLLMENT_TOKEN;
    delete process.env.MULLION_AGENT_TOKEN;
    process.env.PROJECTS_ROOTS = os.tmpdir();
    process.env.SESSIONS_DIR = sessionsDir;

    await expect(buildApp()).rejects.toThrow(/refusing to boot an agent/i);
  });

  it("handles invalid primary URLs, HTTP 429/500, and malformed pairing responses", async () => {
    newSessionsDir();
    const validCode = "a".repeat(64); // pragma: allowlist secret

    await expect(
      redeemPairingCode({ primaryUrl: "not a url", code: validCode, sessionsDir }),
    ).rejects.toThrow(/Invalid primary URL/);

    await expect(
      redeemPairingCode({ primaryUrl: "ftp://primary.invalid", code: validCode, sessionsDir }),
    ).rejects.toThrow(/http:\/\/ or https:\/\//);

    vi.stubGlobal("fetch", async () => new Response("{}", { status: 429 }));
    await expect(
      redeemPairingCode({ primaryUrl: "http://primary.invalid", code: validCode, sessionsDir }),
    ).rejects.toThrow(/HTTP 429/);

    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    await expect(
      redeemPairingCode({ primaryUrl: "http://primary.invalid", code: validCode, sessionsDir }),
    ).rejects.toThrow(/HTTP 500/);

    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ host_id: "" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      redeemPairingCode({ primaryUrl: "http://primary.invalid", code: validCode, sessionsDir }),
    ).rejects.toThrow(/did not include a valid machine identity/);
  });

  it("agent-pair CLI parses args, reads the first line from stdin, and redeems a pairing code", async () => {
    newSessionsDir();
    const code = await issueCode("cli-pair");
    stubPrimaryFetch();

    expect(
      parseArgs([
        "--primary-url",
        "http://primary.invalid",
        "--sessions-dir",
        sessionsDir,
        "--name",
        "cli-host",
        "--advertise-url",
        "https://agent.example.com",
        "--hostname",
        "custom-box",
        "--platform",
        "linux",
        "--timeout",
        "5000",
      ]),
    ).toEqual({
      primaryUrl: "http://primary.invalid",
      sessionsDir,
      name: "cli-host",
      advertiseUrl: "https://agent.example.com",
      hostname: "custom-box",
      platform: "linux",
      timeoutMs: 5000,
    });

    expect(() =>
      parseArgs([
        "--primary-url",
        "http://primary.invalid",
        "--sessions-dir",
        sessionsDir,
        "--timeout",
        "0",
      ]),
    ).toThrow(/--timeout must be a positive number/);
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown or incomplete argument/);
    expect(() => parseArgs(["--sessions-dir", sessionsDir])).toThrow(/--primary-url is required/);
    expect(() => parseArgs(["--primary-url", "http://primary.invalid"])).toThrow(
      /--sessions-dir is required/,
    );

    async function* chunks(items: Array<Buffer | string>) {
      for (const item of items) yield item;
    }

    expect(
      await readFirstLineFromStdin(chunks([Buffer.from(`  ${code}  \nignored-second-line\n`)])),
    ).toBe(code);
    expect(await readFirstLineFromStdin(chunks(["single-line"]))).toBe("single-line");

    await expect(
      runAgentPair(
        ["--primary-url", "http://primary.invalid", "--sessions-dir", sessionsDir],
        chunks(["   \n"]),
      ),
    ).rejects.toThrow(/Pairing code must be provided on stdin/);

    let output = "";
    let stderrOutput = "";
    await runAgentPair(
      [
        "--primary-url",
        "http://primary.invalid",
        "--sessions-dir",
        sessionsDir,
        "--name",
        "cli-host",
        "--hostname",
        "custom-box",
        "--platform",
        "linux",
      ],
      chunks([`${code}\n`]),
      {
        write: (chunk: string | Uint8Array) => {
          output += String(chunk);
          return true;
        },
      },
      {
        write: (chunk: string | Uint8Array) => {
          stderrOutput += String(chunk);
          return true;
        },
      },
    );

    const identity = loadAgentIdentity(statePath);
    expect(identity).not.toBeNull();
    expect(output).toBe(`Paired host ${identity!.hostId}\n`);
    expect(stderrOutput).toContain("plain http://");
    const hostRow = primary.db.select().from(hosts).where(eq(hosts.id, identity!.hostId)).get();
    expect(JSON.parse(hostRow!.agentMetadata!)).toMatchObject({ hostname: "custom-box" });
    expect(hostRow?.platform).toBe("linux");

    // Loopback http:// does not emit the plain-text warning.
    const loopbackCode = await issueCode("cli-pair-loopback");
    let loopbackStderr = "";
    await runAgentPair(
      ["--primary-url", "http://127.0.0.1:3000", "--sessions-dir", sessionsDir],
      chunks([`${loopbackCode}\n`]),
      { write: () => true },
      {
        write: (chunk: string | Uint8Array) => {
          loopbackStderr += String(chunk);
          return true;
        },
      },
    );
    expect(loopbackStderr).toBe("");
  });
});
