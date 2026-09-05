import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

// Issue #895 — end-to-end proof that `/setup/preview` and `/setup/apply`
// actually work for a remote-hosted project, against two real buildApp()
// instances (same two-app harness as test/integration/multi-host.test.ts's
// own "multi-host dock-preview worktrees" describe block). `/setup/generate`
// is deliberately NOT covered here — its own 501 guard stays in place (see
// project-setup.ts's own header comment and issue #1101).
//
// Same "filesystem assertions alone can't prove the HTTP hop happened"
// caveat as multi-host.test.ts's dock-preview suite: both apps here share
// this process's own temp filesystem, so a file appearing under the agent's
// PROJECTS_ROOTS doesn't by itself prove routes/internal.ts's new
// /internal/read-files, /internal/write-files, /internal/git-file-diff, and
// /internal/git-commit-wip actually ran — this suite spies on
// RemoteHostClient.prototype's corresponding methods alongside the
// filesystem outcome, mirroring that suite's own established pattern.
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    throw new Error("not used by this suite");
  }),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((file: string, args: string[] = [], options?: unknown) => {
      // `git` is passed straight through to the real implementation — this
      // suite asserts on real git worktree/commit output, same carve-out as
      // multi-host.test.ts's own dock-preview describe block.
      if (file === "git") {
        return actual.spawn(file, args, options as ChildProcess.SpawnOptions);
      }
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      ee.stdout = new EventEmitter();
      setImmediate(() => ee.emit("close", 0));
      return ee;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");

const AGENT_TOKEN = "integration-scaffold-setup-agent-token";

async function buildAndListen(env: Record<string, string>) {
  const withSessionsDir = {
    SESSIONS_DIR: path.join(
      os.tmpdir(),
      `multi-host-scaffold-setup-sessions-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
    ),
    ...env,
  };
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(withSessionsDir)) {
    prev[key] = process.env[key];
    process.env[key] = withSessionsDir[key];
  }
  const app = await buildApp();
  for (const key of Object.keys(withSessionsDir)) {
    if (prev[key] === undefined) delete process.env[key];
    else process.env[key] = prev[key];
  }
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a real bound address");
  }
  return { app, port: address.port };
}

describe("multi-host scaffold setup (issue #895)", () => {
  let agent: Awaited<ReturnType<typeof buildAndListen>>;
  let primary: Awaited<ReturnType<typeof buildAndListen>>;
  let hostId: string;
  let projectId: number;
  let repoRoot: string;
  let cwd: string;

  beforeAll(async () => {
    const { execFileSync } = await import("node:child_process");
    const { gitEnv } = await import("../../src/services/git-env.js");
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multi-host-scaffold-setup-"));
    cwd = path.join(repoRoot, "real-repo");
    fs.mkdirSync(cwd, { recursive: true });
    const run = (args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
    run(["init", "-b", "main"]);
    run(["config", "user.email", "test@example.com"]);
    run(["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(cwd, "README.md"), "# test repo\n");
    run(["add", "-A"]);
    run(["commit", "-m", "initial", "--no-verify"]);

    agent = await buildAndListen({
      MULLION_ROLE: "agent",
      MULLION_AGENT_TOKEN: AGENT_TOKEN,
      PROJECTS_ROOTS: repoRoot,
    });
    primary = await buildAndListen({
      DATABASE_URL: `file:${path.join(os.tmpdir(), `multi-host-scaffold-setup-primary-${process.pid}-${crypto.randomBytes(4).toString("hex")}.db`)}`,
    });

    const hostRes = await primary.app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: {
        name: "integration-scaffold-setup-agent",
        baseUrl: `http://127.0.0.1:${agent.port}`,
        token: AGENT_TOKEN,
      },
    });
    hostId = hostRes.json().id;

    const projectRes = await primary.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "scaffold-setup-remote", cwd, hostId },
    });
    projectId = projectRes.json().id;
  });

  afterAll(async () => {
    await primary.app.close();
    await agent.app.close();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it("/setup/preview succeeds for a remote-hosted project — reads/writes/diffs on the AGENT, not locally", async () => {
    const remoteHostClientModule = await import("../../src/services/remote-host-client.js");
    const readFilesSpy = vi.spyOn(remoteHostClientModule.RemoteHostClient.prototype, "readFiles");
    const writeFilesSpy = vi.spyOn(remoteHostClientModule.RemoteHostClient.prototype, "writeFiles");
    const fileDiffSpy = vi.spyOn(
      remoteHostClientModule.RemoteHostClient.prototype,
      "resolveGitFileDiff",
    );

    const res = await primary.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/preview`,
      payload: { slug: "demo" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.previewId).toBeTypeOf("string");
    expect(body.files).toEqual(expect.arrayContaining(["AGENTS.md", "CLAUDE.md"]));
    expect(body.diff).toContain("AGENTS.md");

    expect(readFilesSpy).toHaveBeenCalled();
    expect(writeFilesSpy).toHaveBeenCalled();
    expect(fileDiffSpy).toHaveBeenCalled();

    // The scratch worktree lives on the AGENT's own PROJECTS_ROOTS
    // (repoRoot) — since both apps in this test share one process's
    // filesystem, this alone doesn't prove the HTTP hop happened (see this
    // file's own header comment), but it does prove the write landed in the
    // right place: under the agent-scoped repoRoot, not anywhere else.
    const worktreePath = path.join(cwd, ".mullion-worktrees", "setup-demo");
    expect(fs.existsSync(path.join(worktreePath, "AGENTS.md"))).toBe(true);

    readFilesSpy.mockRestore();
    writeFilesSpy.mockRestore();
    fileDiffSpy.mockRestore();
  });

  it("/setup/apply commits the scaffold on the AGENT and falls back to local-branch mode (no GitHub remote)", async () => {
    const remoteHostClientModule = await import("../../src/services/remote-host-client.js");
    const commitWipSpy = vi.spyOn(
      remoteHostClientModule.RemoteHostClient.prototype,
      "resolveCommitWipChanges",
    );

    const preview = await primary.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/preview`,
      payload: { slug: "demo2" },
    });
    expect(preview.statusCode).toBe(200);
    const previewId = preview.json().previewId as string;

    const apply = await primary.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/apply`,
      payload: { previewId },
    });
    expect(apply.statusCode).toBe(200);
    const applyBody = apply.json();
    // No GitHub remote configured on this test repo, so apply falls back to
    // "committed locally, push it yourself" rather than opening a PR.
    expect(applyBody.mode).toBe("local-branch");
    expect(commitWipSpy).toHaveBeenCalled();

    const worktreePath = path.join(cwd, ".mullion-worktrees", "setup-demo2");
    const { execFileSync } = await import("node:child_process");
    const { gitEnv } = await import("../../src/services/git-env.js");
    const log = execFileSync("git", ["-C", worktreePath, "log", "--oneline", "-1"], {
      stdio: "pipe",
      env: gitEnv(),
    }).toString();
    expect(log).toContain("chore: scaffold Mullion integration (demo2)");

    commitWipSpy.mockRestore();
  });
});
