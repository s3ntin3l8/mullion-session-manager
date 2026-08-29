import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { gitEnv } from "../../src/services/git-env.js";
import { PathEscapeError, __testing } from "../../src/routes/project-setup.js";
import type * as GithubIntegration from "../../src/services/github-integration.js";

vi.mock("../../src/services/github-integration.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GithubIntegration>();
  return { ...actual, resolveGitHubToken: vi.fn().mockResolvedValue(null) };
});

const { resolveGitHubToken } = await import("../../src/services/github-integration.js");

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

function initRepo(cwd: string) {
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "# test repo\n");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "initial commit", "--no-verify"]);
}

const tmpDb = path.join(os.tmpdir(), `project-setup-test-${process.pid}.db`);
let repoDir: string;

async function createProject(app: Awaited<ReturnType<typeof buildApp>>, cwd: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "setup-test", cwd },
  });
  return res.json().id as number;
}

describe("resolveWithin (CodeQL js/path-injection containment guard)", () => {
  it("joins an ordinary relative path under root", () => {
    expect(__testing.resolveWithin("/repo", "AGENTS.md")).toBe(path.join("/repo", "AGENTS.md"));
    expect(__testing.resolveWithin("/repo", path.join(".claude", "skills", "x", "SKILL.md"))).toBe(
      path.join("/repo", ".claude", "skills", "x", "SKILL.md"),
    );
  });

  it("throws PathEscapeError for a traversal segment that would escape root", () => {
    expect(() => __testing.resolveWithin("/repo", "../outside")).toThrow(PathEscapeError);
    expect(() => __testing.resolveWithin("/repo", "../../etc/passwd")).toThrow(PathEscapeError);
  });

  it("throws PathEscapeError for an absolute path that would replace root entirely", () => {
    expect(() => __testing.resolveWithin("/repo", "/etc/passwd")).toThrow(PathEscapeError);
  });
});

describe("project-setup route", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-setup-repo-"));
    initRepo(repoDir);
    vi.mocked(resolveGitHubToken).mockResolvedValue(null);
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("404s for an unknown project id", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/999999/setup/preview",
      payload: { slug: "demo" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("rejects a remote-hosted project's preview with 501 — issue #895 tracks the fix", async () => {
    const app = await buildApp();
    const host = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "remote-setup-test", baseUrl: "http://127.0.0.1:59999", token: "t" },
    });
    const hostId = host.json().id as string;
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "remote-setup", cwd: "/remote/path", hostId },
    });
    const projectId = projectRes.json().id as number;

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/preview`,
      payload: { slug: "demo" },
    });
    expect(res.statusCode).toBe(501);

    await app.close();
  });

  it("rejects an unsafe slug with 400", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, repoDir);
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/preview`,
      payload: { slug: "../evil" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("preview creates a worktree, writes the scaffold, and returns a diff naming every file", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, repoDir);

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/preview`,
      payload: { slug: "demo" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.previewId).toBeTypeOf("string");
    expect(body.files).toEqual(
      expect.arrayContaining([
        "AGENTS.md",
        ".claude/skills/demo/SKILL.md",
        ".claude/agents/demo-reviewer.md",
      ]),
    );
    expect(body.diff).toContain("AGENTS.md");

    // The scratch worktree really exists and really has the files.
    const worktreeDir = path.join(repoDir, ".mullion-worktrees", "setup-demo");
    expect(fs.existsSync(path.join(worktreeDir, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(worktreeDir, ".claude", "skills", "demo", "SKILL.md"))).toBe(
      true,
    );

    await app.close();
  });

  it("re-previewing with the same slug reuses the existing worktree rather than failing", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, repoDir);

    const first = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/preview`,
      payload: { slug: "demo" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/preview`,
      payload: { slug: "demo", mirrors: ["GEMINI.md"] },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().files).toContain("GEMINI.md");

    await app.close();
  });

  it("apply with an unknown previewId is rejected", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, repoDir);

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/apply`,
      payload: { previewId: "does-not-exist" },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it("apply commits the scaffold and falls back to local-branch mode when no GitHub token is configured", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, repoDir);

    const previewRes = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/preview`,
      payload: { slug: "demo" },
    });
    const { previewId } = previewRes.json();

    const applyRes = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/apply`,
      payload: { previewId },
    });
    expect(applyRes.statusCode).toBe(200);
    const body = applyRes.json();
    expect(body).toMatchObject({ ok: true, mode: "local-branch", branch: "mullion/setup-demo" });

    // The commit actually landed in the worktree.
    const worktreeDir = path.join(repoDir, ".mullion-worktrees", "setup-demo");
    const log = execFileSync("git", ["log", "-1", "--pretty=%s"], {
      cwd: worktreeDir,
      env: gitEnv(),
    })
      .toString()
      .trim();
    expect(log).toContain("scaffold Mullion integration");

    await app.close();
  });

  it("re-applying the same previewId after it's already been consumed is rejected", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, repoDir);

    const previewRes = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/preview`,
      payload: { slug: "demo" },
    });
    const { previewId } = previewRes.json();

    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/apply`,
      payload: { previewId },
    });
    const secondApply = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/apply`,
      payload: { previewId },
    });
    expect(secondApply.statusCode).toBe(400);

    await app.close();
  });

  // Hermes review, PR #896 round 1 — after apply commits the scratch
  // worktree, its HEAD IS the scaffold commit; a naive "reuse whatever's at
  // the predicted path" would diff a later same-slug preview against that
  // stale HEAD and silently show "no changes" even though nothing about
  // this preview's OWN inputs repeats the prior one.
  it("previewing again after apply removes the now-stale worktree and starts fresh, rather than silently diffing against the applied commit", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, repoDir);

    const firstPreview = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/preview`,
      payload: { slug: "demo" },
    });
    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/apply`,
      payload: { previewId: firstPreview.json().previewId },
    });

    const secondPreview = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/preview`,
      payload: { slug: "demo", mirrors: ["GEMINI.md"] },
    });
    expect(secondPreview.statusCode).toBe(200);
    const body = secondPreview.json();
    // A fresh worktree re-derived off the real base branch shows the new
    // mirror as an actual change — a stale, already-applied worktree
    // would still contain the FIRST preview's AGENTS.md/skill/reviewer as
    // already-committed (no diff), and GEMINI.md wouldn't even be new
    // relative to a HEAD that never had it — this only passes if the
    // worktree was genuinely rebuilt.
    expect(body.files).toContain("GEMINI.md");
    expect(body.diff).toContain("GEMINI.md");

    await app.close();
  });

  // Hermes review, PR #896 round 1 — the old EEXIST swallow assumed
  // anything already at the symlink's target path was a matching symlink
  // from a prior preview. Switching modes mid-session (still the same
  // live preview window, so the worktree is genuinely reused) used to
  // leave the stale plain-file directory in place and silently skip
  // creating the symlink.
  it("switching from the plain-file to the symlink variant mid-preview actually replaces the stale directory", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, repoDir);

    const plainPreview = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/preview`,
      payload: { slug: "demo", symlinkAgentsSkills: false },
    });
    expect(plainPreview.statusCode).toBe(200);
    const worktreeDir = path.join(repoDir, ".mullion-worktrees", "setup-demo");
    const agentsSkillsPath = path.join(worktreeDir, ".agents", "skills", "demo");
    expect(fs.statSync(agentsSkillsPath).isDirectory()).toBe(true);

    const symlinkPreview = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/preview`,
      payload: { slug: "demo", symlinkAgentsSkills: true },
    });
    expect(symlinkPreview.statusCode).toBe(200);
    expect(fs.lstatSync(agentsSkillsPath).isSymbolicLink()).toBe(true);

    await app.close();
  });
});
