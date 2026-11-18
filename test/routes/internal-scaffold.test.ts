import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import {
  createInternalPtyHarness,
  createInternalChildProcessHarness,
  createBundleSyncHarness,
  mockScaffoldGenerateModule,
  createInternalAgentEnv,
  INTERNAL_TEST_TOKEN,
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
vi.mock("../../src/services/scaffold-generate.js", async (importOriginal) =>
  mockScaffoldGenerateModule(await importOriginal()),
);
const { runGenerationTurnInScratchWorktree } =
  await import("../../src/services/scaffold-generate.js");
const { buildApp } = await import("../../src/app.js");
const { clearAgentsCacheForTests } = await import("../../src/services/agent-detect.js");
const { gitEnv } = await import("../../src/services/git-env.js");

const TOKEN = INTERNAL_TEST_TOKEN;

describe("internal routes: scaffold proxy and generation turn", () => {
  const env = createInternalAgentEnv();
  beforeAll(() => {
    env.setup();
  });
  afterAll(() => {
    env.teardown();
  });
  beforeEach(() => {
    ptyHarness.reset();
    childProcessHarness.reset();
    bundleSyncHarness.reset();
    clearAgentsCacheForTests();
  });

  describe("scaffold read/write/commit remote-hosted proxy routes (#895)", () => {
    async function makeScaffoldRepo() {
      const { execFileSync } = await import("node:child_process");
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-895-root-"));
      const cwd = path.join(repoRoot, "real-repo");
      fs.mkdirSync(cwd, { recursive: true });
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      fs.writeFileSync(path.join(cwd, "README.md"), "# real repo\n");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      return { repoRoot, cwd };
    }

    it("POST /internal/read-files reads existing content off this host's own filesystem, and omits an absent path", async () => {
      const { repoRoot, cwd } = await makeScaffoldRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/read-files",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, paths: ["README.md", "MISSING.md"] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.files["README.md"]).toBe("# real repo\n");
      expect("MISSING.md" in body.files).toBe(false);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("requires a cwd/paths body for read-files, and rejects a cwd outside PROJECTS_ROOTS", async () => {
      const app = await buildApp();
      const missing = await app.inject({
        method: "POST",
        url: "/internal/read-files",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(missing.statusCode).toBe(400);

      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-read-files-outside-"));
      const outside = await app.inject({
        method: "POST",
        url: "/internal/read-files",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd: outsideRoots, paths: ["a"] },
      });
      expect(outside.statusCode).toBe(400);

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });

    it("POST /internal/write-files writes a file entry onto this host's own filesystem, then stages it when stage:true", async () => {
      const { repoRoot, cwd } = await makeScaffoldRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/write-files",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          cwd,
          entries: [{ path: "AGENTS.md", kind: "file", contents: "hi\n" }],
          stage: true,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, ignored: [] });
      expect(fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8")).toBe("hi\n");

      const { execFileSync } = await import("node:child_process");
      const status = execFileSync("git", ["status", "--porcelain"], { cwd, env: gitEnv() })
        .toString()
        .trim();
      expect(status).toBe("A  AGENTS.md");

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("POST /internal/write-files creates a symlink entry with its target verbatim", async () => {
      const { repoRoot, cwd } = await makeScaffoldRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/write-files",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          cwd,
          entries: [
            {
              path: path.join(".agents", "skills", "demo"),
              kind: "symlink",
              target: "../../.claude/skills/demo",
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const linkPath = path.join(cwd, ".agents", "skills", "demo");
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(linkPath)).toBe("../../.claude/skills/demo");

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("rejects a write-files entry missing its kind-specific required field", async () => {
      const { repoRoot, cwd } = await makeScaffoldRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const noContents = await app.inject({
        method: "POST",
        url: "/internal/write-files",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, entries: [{ path: "AGENTS.md", kind: "file" }] },
      });
      expect(noContents.statusCode).toBe(400);

      const noTarget = await app.inject({
        method: "POST",
        url: "/internal/write-files",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, entries: [{ path: "a-link", kind: "symlink" }] },
      });
      expect(noTarget.statusCode).toBe(400);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("requires a cwd/entries body for write-files, and rejects a cwd outside PROJECTS_ROOTS", async () => {
      const app = await buildApp();
      const missing = await app.inject({
        method: "POST",
        url: "/internal/write-files",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(missing.statusCode).toBe(400);

      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-write-files-outside-"));
      const outside = await app.inject({
        method: "POST",
        url: "/internal/write-files",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd: outsideRoots, entries: [{ path: "a", kind: "file", contents: "x" }] },
      });
      expect(outside.statusCode).toBe(400);

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });

    it("POST /internal/git-commit-wip commits uncommitted work on this host's own filesystem", async () => {
      const { repoRoot, cwd } = await makeScaffoldRepo();
      fs.writeFileSync(path.join(cwd, "AGENTS.md"), "hi\n");
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-commit-wip",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, message: "chore: scaffold Mullion integration (demo)" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ committed: true });

      const { execFileSync } = await import("node:child_process");
      const log = execFileSync("git", ["log", "--oneline", "-1"], {
        cwd,
        env: gitEnv(),
      }).toString();
      expect(log).toContain("chore: scaffold Mullion integration (demo)");

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("POST /internal/git-commit-wip is a clean no-op when there's nothing to commit", async () => {
      const { repoRoot, cwd } = await makeScaffoldRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-commit-wip",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ committed: false });

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("requires a cwd body for git-commit-wip, and rejects a cwd outside PROJECTS_ROOTS", async () => {
      const app = await buildApp();
      const missing = await app.inject({
        method: "POST",
        url: "/internal/git-commit-wip",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(missing.statusCode).toBe(400);

      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-commit-wip-outside-"));
      const outside = await app.inject({
        method: "POST",
        url: "/internal/git-commit-wip",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd: outsideRoots },
      });
      expect(outside.statusCode).toBe(400);

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });

    // Issue #1124 — mullion-reviewer, this PR's own review pass: this
    // route's siblings above (/internal/read-files, /internal/write-files)
    // are each directly exercised via app.inject() here; this one was
    // originally only reached indirectly
    // (session-lifecycle-scaffold-gate-remote.test.ts mocks
    // remote-host-client.js entirely, so it never runs this handler). These
    // tests are the actual proof that RemoteHostClient.scaffoldScan's
    // hardcoded "/internal/scaffold-scan" path string, its request/response
    // shape, and this route's registration all genuinely agree with each
    // other — a drift on either side would pass every other test in this
    // PR. Nested inside this describe block (not a sibling) because it
    // reuses makeScaffoldRepo, which is scoped here.
    describe("POST /internal/scaffold-scan (#1124)", () => {
      it("reports a committed scaffold found on this host's own filesystem", async () => {
        const { scaffoldSkillPath, scaffoldReviewerPath, scaffoldStampLine } =
          await import("../../src/services/mullion-scaffold.js");
        const { repoRoot, cwd } = await makeScaffoldRepo();
        const previousRoots = process.env.PROJECTS_ROOTS;
        process.env.PROJECTS_ROOTS = repoRoot;
        const app = await buildApp();

        const slug = "acme-widgets";
        const skillPath = path.join(cwd, scaffoldSkillPath(slug));
        const reviewerPath = path.join(cwd, scaffoldReviewerPath(slug));
        fs.mkdirSync(path.dirname(skillPath), { recursive: true });
        fs.writeFileSync(
          skillPath,
          `---\nname: ${slug}\ndescription: "x"\n---\n\n${scaffoldStampLine(slug)}\n\nBody.\n`,
        );
        fs.mkdirSync(path.dirname(reviewerPath), { recursive: true });
        fs.writeFileSync(
          reviewerPath,
          `---\nname: ${slug}-reviewer\ndescription: "x"\n---\n\n${scaffoldStampLine(slug)}\n\nBody.\n`,
        );

        const res = await app.inject({
          method: "POST",
          url: "/internal/scaffold-scan",
          headers: { authorization: `Bearer ${TOKEN}` },
          payload: { cwd },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ skillCommitted: true, reviewerCommitted: true, warnings: [] });

        process.env.PROJECTS_ROOTS = previousRoots;
        fs.rmSync(repoRoot, { recursive: true, force: true });
        await app.close();
      });

      it("reports no committed scaffold when none exists", async () => {
        const { repoRoot, cwd } = await makeScaffoldRepo();
        const previousRoots = process.env.PROJECTS_ROOTS;
        process.env.PROJECTS_ROOTS = repoRoot;
        const app = await buildApp();

        const res = await app.inject({
          method: "POST",
          url: "/internal/scaffold-scan",
          headers: { authorization: `Bearer ${TOKEN}` },
          payload: { cwd },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          skillCommitted: false,
          reviewerCommitted: false,
          warnings: [],
        });

        process.env.PROJECTS_ROOTS = previousRoots;
        fs.rmSync(repoRoot, { recursive: true, force: true });
        await app.close();
      });

      it("requires a cwd body, and rejects a cwd outside PROJECTS_ROOTS", async () => {
        const app = await buildApp();
        const missing = await app.inject({
          method: "POST",
          url: "/internal/scaffold-scan",
          headers: { authorization: `Bearer ${TOKEN}` },
          payload: {},
        });
        expect(missing.statusCode).toBe(400);

        const outsideRoots = fs.mkdtempSync(
          path.join(os.tmpdir(), "internal-scaffold-scan-outside-"),
        );
        const outside = await app.inject({
          method: "POST",
          url: "/internal/scaffold-scan",
          headers: { authorization: `Bearer ${TOKEN}` },
          payload: { cwd: outsideRoots },
        });
        expect(outside.statusCode).toBe(400);

        fs.rmSync(outsideRoots, { recursive: true, force: true });
        await app.close();
      });

      it("rejects a body with an unexpected extra property (additionalProperties: false)", async () => {
        const app = await buildApp();
        const res = await app.inject({
          method: "POST",
          url: "/internal/scaffold-scan",
          headers: { authorization: `Bearer ${TOKEN}` },
          payload: { cwd: "/tmp/whatever", slug: "not-a-real-field" },
        });
        expect(res.statusCode).toBe(400);
        await app.close();
      });
    });
  });

  describe("POST /internal/run-generation-turn (#1101)", () => {
    beforeEach(() => {
      vi.mocked(runGenerationTurnInScratchWorktree).mockReset();
    });

    it("runs a generation turn and returns { outcome: 'ok', stdout }", async () => {
      vi.mocked(runGenerationTurnInScratchWorktree).mockResolvedValue("out");
      const previousRoots = process.env.PROJECTS_ROOTS;
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "internal-gen-turn-"));
      process.env.PROJECTS_ROOTS = cwd;
      const app = await buildApp();

      const payload = {
        cwd,
        slug: "demo",
        baseRef: "origin/main",
        agentCommand: "claude",
        prompt: "do the thing",
        timeoutMs: 300_000,
      };
      const res = await app.inject({
        method: "POST",
        url: "/internal/run-generation-turn",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ outcome: "ok", sandboxed: true, canary: true, stdout: "out" });
      expect(runGenerationTurnInScratchWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          ...payload,
          sandbox: true,
          onBeforeTeardown: expect.any(Function),
        }),
      );
      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("maps each error taxonomy — unsupported agent, worktree failure, spawn failure — to its own outcome, still HTTP 200", async () => {
      const { UnsupportedGenerationAgentError, GenerationWorktreeError, GenerationSpawnError } =
        await import("../../src/services/scaffold-generate.js");
      const previousRoots = process.env.PROJECTS_ROOTS;
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "internal-gen-turn-errors-"));
      process.env.PROJECTS_ROOTS = cwd;
      const app = await buildApp();

      const body = {
        cwd,
        slug: "demo",
        baseRef: "HEAD",
        agentCommand: "claude",
        prompt: "do the thing",
        timeoutMs: 300_000,
      };

      vi.mocked(runGenerationTurnInScratchWorktree).mockRejectedValueOnce(
        new UnsupportedGenerationAgentError("pi"),
      );
      const unsupported = await app.inject({
        method: "POST",
        url: "/internal/run-generation-turn",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: body,
      });
      expect(unsupported.statusCode).toBe(200);
      expect(unsupported.json().outcome).toBe("unsupported-agent");

      vi.mocked(runGenerationTurnInScratchWorktree).mockRejectedValueOnce(
        new GenerationWorktreeError("could not create a scratch worktree"),
      );
      const worktreeFailed = await app.inject({
        method: "POST",
        url: "/internal/run-generation-turn",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: body,
      });
      expect(worktreeFailed.statusCode).toBe(200);
      expect(worktreeFailed.json().outcome).toBe("worktree-error");

      vi.mocked(runGenerationTurnInScratchWorktree).mockRejectedValueOnce(
        new GenerationSpawnError("claude", "exit code 1: boom"),
      );
      const spawnFailed = await app.inject({
        method: "POST",
        url: "/internal/run-generation-turn",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: body,
      });
      expect(spawnFailed.statusCode).toBe(200);
      expect(spawnFailed.json().outcome).toBe("spawn-error");

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("requires a cwd/slug/baseRef/agentCommand/prompt/timeoutMs body, and rejects a cwd outside PROJECTS_ROOTS", async () => {
      const app = await buildApp();
      const missing = await app.inject({
        method: "POST",
        url: "/internal/run-generation-turn",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(missing.statusCode).toBe(400);
      expect(runGenerationTurnInScratchWorktree).not.toHaveBeenCalled();

      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-gen-turn-outside-"));
      const outside = await app.inject({
        method: "POST",
        url: "/internal/run-generation-turn",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          cwd: outsideRoots,
          slug: "demo",
          baseRef: "HEAD",
          agentCommand: "claude",
          prompt: "do the thing",
          timeoutMs: 300_000,
        },
      });
      expect(outside.statusCode).toBe(400);
      expect(runGenerationTurnInScratchWorktree).not.toHaveBeenCalled();

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });

    it("rejects a timeoutMs above DEFAULT_GENERATION_TIMEOUT_MS — the client's own network timeout is fixed above that constant, not above whatever a caller sends", async () => {
      const { DEFAULT_GENERATION_TIMEOUT_MS } =
        await import("../../src/services/scaffold-generate.js");
      const previousRoots = process.env.PROJECTS_ROOTS;
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "internal-gen-turn-timeout-"));
      process.env.PROJECTS_ROOTS = cwd;
      const app = await buildApp();

      const tooLarge = await app.inject({
        method: "POST",
        url: "/internal/run-generation-turn",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          cwd,
          slug: "demo",
          baseRef: "HEAD",
          agentCommand: "claude",
          prompt: "do the thing",
          timeoutMs: DEFAULT_GENERATION_TIMEOUT_MS + 1,
        },
      });
      expect(tooLarge.statusCode).toBe(400);
      expect(runGenerationTurnInScratchWorktree).not.toHaveBeenCalled();

      vi.mocked(runGenerationTurnInScratchWorktree).mockResolvedValue("stdout");
      const atLimit = await app.inject({
        method: "POST",
        url: "/internal/run-generation-turn",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          cwd,
          slug: "demo",
          baseRef: "HEAD",
          agentCommand: "claude",
          prompt: "do the thing",
          timeoutMs: DEFAULT_GENERATION_TIMEOUT_MS,
        },
      });
      expect(atLimit.statusCode).toBe(200);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    // Issue #1133 — this handler must read ITS OWN (this agent's)
    // MULLION_SCAFFOLD_GENERATE_SANDBOX_ENABLED, never a value carried over
    // the wire from the primary (runGenerationTurnSchema has no such field
    // at all — see that schema's own comment). Setting the env var before
    // buildApp() is the same pattern this file's own MULLION_SSH_AUTH_SOCK/
    // MULLION_HOME tests already use for an agent-local config value.
    it("honors this agent's own MULLION_SCAFFOLD_GENERATE_SANDBOX_ENABLED, not a value from the request body", async () => {
      const previousRoots = process.env.PROJECTS_ROOTS;
      const previousSandboxEnabled = process.env.MULLION_SCAFFOLD_GENERATE_SANDBOX_ENABLED;
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "internal-gen-turn-sandbox-"));
      try {
        process.env.PROJECTS_ROOTS = cwd;
        process.env.MULLION_SCAFFOLD_GENERATE_SANDBOX_ENABLED = "false";
        const app = await buildApp();

        vi.mocked(runGenerationTurnInScratchWorktree).mockResolvedValue("stdout");
        const res = await app.inject({
          method: "POST",
          url: "/internal/run-generation-turn",
          headers: { authorization: `Bearer ${TOKEN}` },
          payload: {
            cwd,
            slug: "demo",
            baseRef: "HEAD",
            agentCommand: "claude",
            prompt: "do the thing",
            timeoutMs: 300_000,
          },
        });
        expect(res.statusCode).toBe(200);
        expect(runGenerationTurnInScratchWorktree).toHaveBeenCalledWith(
          expect.objectContaining({ sandbox: false }),
        );

        await app.close();
      } finally {
        process.env.PROJECTS_ROOTS = previousRoots;
        if (previousSandboxEnabled === undefined) {
          delete process.env.MULLION_SCAFFOLD_GENERATE_SANDBOX_ENABLED;
        } else {
          process.env.MULLION_SCAFFOLD_GENERATE_SANDBOX_ENABLED = previousSandboxEnabled;
        }
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});
