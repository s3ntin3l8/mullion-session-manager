import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { gitEnv } from "../../src/services/git-env.js";
import { PathEscapeError, __testing } from "../../src/routes/project-setup.js";
import { writeProjectSkill } from "../../src/services/project-tooling.js";
import type * as GithubIntegration from "../../src/services/github-integration.js";
import type * as ScaffoldGenerate from "../../src/services/scaffold-generate.js";

vi.mock("../../src/services/github-integration.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GithubIntegration>();
  return { ...actual, resolveGitHubToken: vi.fn().mockResolvedValue(null) };
});

const { resolveGitHubToken } = await import("../../src/services/github-integration.js");

// Issue #956 — every `/setup/generate` test below mocks this module's own
// `generateScaffoldContent` rather than letting the route invoke a real
// CLI/LLM turn (the task brief's own instruction: mock the agent-turn
// spawn in tests). `importOriginal` keeps the real error classes
// (`UnsupportedGenerationAgentError` etc.) intact, since project-setup.ts
// imports and `instanceof`-checks those directly.
vi.mock("../../src/services/scaffold-generate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ScaffoldGenerate>();
  return { ...actual, generateScaffoldContent: vi.fn() };
});

const { generateScaffoldContent } = await import("../../src/services/scaffold-generate.js");

function mockValidGeneration(slug: string) {
  vi.mocked(generateScaffoldContent).mockResolvedValue({
    skill: `---\nname: ${slug}\n---\nGenerated: real invariant about ${slug}.\n`,
    reviewer: `---\nname: ${slug}-reviewer\n---\nRead .claude/skills/${slug}/SKILL.md first.\n`,
    briefingRegion: `The generated skill lives at .claude/skills/${slug}/SKILL.md.`,
  });
}

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
    vi.mocked(generateScaffoldContent).mockReset();
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
        "CLAUDE.md",
        ".claude/skills/demo/SKILL.md",
        ".claude/agents/demo-reviewer.md",
      ]),
    );
    expect(body.diff).toContain("AGENTS.md");

    // The scratch worktree really exists and really has the files.
    const worktreeDir = path.join(repoDir, ".mullion-worktrees", "setup-demo");
    expect(fs.existsSync(path.join(worktreeDir, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(worktreeDir, "CLAUDE.md"))).toBe(true);
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
      payload: { slug: "demo", includeContributingPointer: true },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().files).toContain("CONTRIBUTING.md");

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
      payload: { slug: "demo", includeContributingPointer: true },
    });
    expect(secondPreview.statusCode).toBe(200);
    const body = secondPreview.json();
    // A fresh worktree re-derived off the real base branch shows the new
    // pointer as an actual change — a stale, already-applied worktree
    // would still contain the FIRST preview's AGENTS.md/skill/reviewer as
    // already-committed (no diff), and CONTRIBUTING.md wouldn't even be new
    // relative to a HEAD that never had it — this only passes if the
    // worktree was genuinely rebuilt.
    expect(body.files).toContain("CONTRIBUTING.md");
    expect(body.diff).toContain("CONTRIBUTING.md");

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

  // Hermes review, PR #896 round 2 — the reverse direction of the test
  // above: switching OFF symlinkAgentsSkills left a stale symlink at
  // exactly the path the plain-file write's mkdirSync needs to create as
  // a real directory, which threw (reproduced: ENOENT) rather than
  // silently succeeding.
  it("switching from the symlink to the plain-file variant mid-preview actually replaces the stale symlink", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, repoDir);

    const symlinkPreview = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/preview`,
      payload: { slug: "demo", symlinkAgentsSkills: true },
    });
    expect(symlinkPreview.statusCode).toBe(200);
    const worktreeDir = path.join(repoDir, ".mullion-worktrees", "setup-demo");
    const agentsSkillsPath = path.join(worktreeDir, ".agents", "skills", "demo");
    expect(fs.lstatSync(agentsSkillsPath).isSymbolicLink()).toBe(true);

    const plainPreview = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/preview`,
      payload: { slug: "demo", symlinkAgentsSkills: false },
    });
    expect(plainPreview.statusCode).toBe(200);
    expect(fs.lstatSync(agentsSkillsPath).isSymbolicLink()).toBe(false);
    expect(fs.statSync(agentsSkillsPath).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(agentsSkillsPath, "SKILL.md"))).toBe(true);

    await app.close();
  });

  // Hermes review, PR #896 round 2 — a re-preview must not clobber a
  // skill/reviewer/dock-config the target repo already committed or
  // hand-edited; only the AGENTS.md briefing region is designed for
  // repeated safe upserts.
  it("does not clobber an already-committed skill file on a re-preview", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, repoDir);

    const customSkill =
      "---\nname: demo\ndescription: hand-written before scaffolding\n---\nmy own content\n";
    fs.mkdirSync(path.join(repoDir, ".claude", "skills", "demo"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, ".claude", "skills", "demo", "SKILL.md"), customSkill);
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-m", "hand-written skill", "--no-verify"]);

    const preview = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/preview`,
      payload: { slug: "demo" },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().files).not.toContain(".claude/skills/demo/SKILL.md");

    const worktreeDir = path.join(repoDir, ".mullion-worktrees", "setup-demo");
    const onDisk = fs.readFileSync(
      path.join(worktreeDir, ".claude", "skills", "demo", "SKILL.md"),
      "utf8",
    );
    expect(onDisk).toBe(customSkill);

    await app.close();
  });

  // Issue #942 — the route's own readExistingFiles must pick up an
  // existing CONTRIBUTING.md so computeScaffold upserts into it rather
  // than treating it as absent and overwriting it with a pointer-only
  // file. A computeScaffold-only unit test can't catch a missing entry in
  // the route's own scaffoldableRelPaths() read list — this has to go
  // through the real preview route.
  it("upserts the pointer into an already-committed CONTRIBUTING.md instead of overwriting it", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, repoDir);

    const customContributing =
      "# Contributing\n\n## Code of Conduct\n\nBe excellent to each other.\n";
    fs.writeFileSync(path.join(repoDir, "CONTRIBUTING.md"), customContributing);
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-m", "hand-written CONTRIBUTING.md", "--no-verify"]);

    const preview = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/preview`,
      payload: { slug: "demo", includeContributingPointer: true },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().files).toContain("CONTRIBUTING.md");

    const worktreeDir = path.join(repoDir, ".mullion-worktrees", "setup-demo");
    const onDisk = fs.readFileSync(path.join(worktreeDir, "CONTRIBUTING.md"), "utf8");
    expect(onDisk).toContain("Code of Conduct");
    expect(onDisk).toContain("Be excellent to each other.");
    expect(onDisk).toContain("AGENTS.md");

    await app.close();
  });

  // Issue #942 (this restructure) — CLAUDE.md is unconditional, not
  // opt-in, so the route's own readExistingFiles must ALWAYS pick it up so
  // computeScaffold upserts into it rather than treating it as absent and
  // overwriting a real, hand-authored CLAUDE.md with a scaffold-only
  // `@AGENTS.md` import file. A computeScaffold-only unit test can't catch
  // a missing entry in the route's own scaffoldableRelPaths() read list —
  // this has to go through the real preview route (same reasoning as the
  // CONTRIBUTING.md test above).
  it("upserts the @AGENTS.md import into an already-committed CLAUDE.md instead of overwriting it", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, repoDir);

    const customClaude =
      "# CLAUDE.md — Demo Project\n\n## Architecture\n\nSome hand-written architecture notes nobody wants clobbered.\n";
    fs.writeFileSync(path.join(repoDir, "CLAUDE.md"), customClaude);
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-m", "hand-written CLAUDE.md", "--no-verify"]);

    const preview = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/preview`,
      payload: { slug: "demo" },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().files).toContain("CLAUDE.md");

    const worktreeDir = path.join(repoDir, ".mullion-worktrees", "setup-demo");
    const onDisk = fs.readFileSync(path.join(worktreeDir, "CLAUDE.md"), "utf8");
    expect(onDisk).toContain("## Architecture");
    expect(onDisk).toContain("Some hand-written architecture notes nobody wants clobbered.");
    expect(onDisk).toContain("@AGENTS.md");

    await app.close();
  });
});

// Issue #956 — `/setup/generate`: extends the same preview/apply worktree
// machinery above with a real (here, mocked) generation pass ahead of it.
describe("project-setup route — /setup/generate (issue #956)", () => {
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
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-setup-generate-repo-"));
    initRepo(repoDir);
    vi.mocked(generateScaffoldContent).mockReset();
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("404s for an unknown project id", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/999999/setup/generate",
      payload: { slug: "demo" },
    });
    expect(res.statusCode).toBe(404);
    expect(generateScaffoldContent).not.toHaveBeenCalled();
    await app.close();
  });

  // Gap #1 (issue #956) — identical shape to /setup/preview's own 501.
  it("rejects a remote-hosted project with 501, matching /setup/preview's own precedent — never calls the generation agent", async () => {
    const app = await buildApp();
    const host = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "remote-generate-test", baseUrl: "http://127.0.0.1:59998", token: "t" },
    });
    const hostId = host.json().id as string;
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "remote-generate", cwd: "/remote/path", hostId },
    });
    const projectId = projectRes.json().id as number;

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/generate`,
      payload: { slug: "demo" },
    });
    expect(res.statusCode).toBe(501);
    expect(generateScaffoldContent).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an unsafe slug with 400 without calling the generation agent", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, repoDir);
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/generate`,
      payload: { slug: "../evil" },
    });
    expect(res.statusCode).toBe(400);
    expect(generateScaffoldContent).not.toHaveBeenCalled();
    await app.close();
  });

  it("uses the generated content — not the static placeholder — for the skill, reviewer, and AGENTS.md region", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, repoDir);
    mockValidGeneration("demo");

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/generate`,
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

    const worktreeDir = path.join(repoDir, ".mullion-worktrees", "setup-demo");
    const skill = fs.readFileSync(
      path.join(worktreeDir, ".claude", "skills", "demo", "SKILL.md"),
      "utf8",
    );
    const reviewer = fs.readFileSync(
      path.join(worktreeDir, ".claude", "agents", "demo-reviewer.md"),
      "utf8",
    );
    const agentsMd = fs.readFileSync(path.join(worktreeDir, "AGENTS.md"), "utf8");

    expect(skill).toContain("Generated: real invariant about demo.");
    expect(skill).not.toContain("Replace this section");
    expect(reviewer).toContain("Read .claude/skills/demo/SKILL.md first.");
    expect(agentsMd).toContain("The generated skill lives at");

    // The apply route works completely unchanged off this previewId.
    const applyRes = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/apply`,
      payload: { previewId: body.previewId },
    });
    expect(applyRes.statusCode).toBe(200);

    await app.close();
  });

  it("resolves the generating agent via project.defaultAgent, falling back to settings.launchers.defaultAgent", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, repoDir);
    mockValidGeneration("demo");

    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/generate`,
      payload: { slug: "demo" },
    });

    expect(generateScaffoldContent).toHaveBeenCalledTimes(1);
    const call = vi.mocked(generateScaffoldContent).mock.calls[0][0];
    // No project.defaultAgent was set, so this must be
    // settings.launchers.defaultAgent's own default ("claude").
    expect(call.agentCommand).toBe("claude");

    await app.close();
  });

  it("computes hasSkill/hasReviewer/hasBriefingRegion from the project's real checkout, not the scratch worktree", async () => {
    const app = await buildApp();
    fs.mkdirSync(path.join(repoDir, ".claude", "skills", "demo"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".claude", "skills", "demo", "SKILL.md"),
      "hand-written already\n",
    );
    execFileSync("git", ["add", "-A"], { cwd: repoDir, env: gitEnv() });
    execFileSync("git", ["commit", "-m", "pre-existing skill", "--no-verify"], {
      cwd: repoDir,
      env: gitEnv(),
    });
    const projectId = await createProject(app, repoDir);
    mockValidGeneration("demo");

    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/generate`,
      payload: { slug: "demo" },
    });

    const call = vi.mocked(generateScaffoldContent).mock.calls[0][0];
    expect(call.hasSkill).toBe(true);
    expect(call.hasReviewer).toBe(false);
    expect(call.hasBriefingRegion).toBe(false);

    await app.close();
  });

  it("threads the project_tooling DB draft into the generation seed", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, repoDir);
    writeProjectSkill(app.db, projectId, "a DB-authored draft skill description");
    mockValidGeneration("demo");

    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/generate`,
      payload: { slug: "demo" },
    });

    const call = vi.mocked(generateScaffoldContent).mock.calls[0][0];
    expect(call.seed.skill).toBe("a DB-authored draft skill description");

    await app.close();
  });

  // Issue #1082(c) — diff-aware refresh. Exact committed content, exported
  // so the "untouched target" assertions below can assert byte-equality
  // against it rather than a substring — matching the mirror-vs-skill
  // byte-identity check a few lines below in the same describe block,
  // instead of the weaker toContain/not.toContain pair a review pass found
  // here originally (a mutation that appended to, rather than replaced,
  // the untouched file's content would have slipped past those).
  const HAND_WRITTEN_SKILL =
    "---\nname: demo\ndescription: hand-written\n---\nhand-written skill content — do not touch\n";
  function handWrittenReviewer(slug: string) {
    return `---\nname: ${slug}-reviewer\n---\nhand-written reviewer content — do not touch\n`;
  }
  function commitBothScaffoldFiles(cwd: string, slug: string) {
    const skillDir = path.join(cwd, ".claude", "skills", slug);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), HAND_WRITTEN_SKILL);
    const agentsDir = path.join(cwd, ".claude", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, `${slug}-reviewer.md`), handWrittenReviewer(slug));
    execFileSync("git", ["add", "-A"], { cwd, env: gitEnv() });
    execFileSync("git", ["commit", "-m", "pre-existing skill+reviewer", "--no-verify"], {
      cwd,
      env: gitEnv(),
    });
  }

  // Regression — this is the exact behavior issue #956 built and issue
  // #1082(c) explicitly must NOT relax as a side effect of adding refresh:
  // absent an explicit `refresh`, both files already committed still means
  // "don't spend a real agent turn on content computeScaffold would throw
  // away anyway."
  it("both files already committed, no refresh requested -> 409, no agent turn spawned", async () => {
    const app = await buildApp();
    commitBothScaffoldFiles(repoDir, "demo");
    const projectId = await createProject(app, repoDir);

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/generate`,
      payload: { slug: "demo" },
    });
    expect(res.statusCode).toBe(409);
    expect(generateScaffoldContent).not.toHaveBeenCalled();

    await app.close();
  });

  it('refresh: ["skill"] spawns the agent turn and overwrites only the skill file — the reviewer is left byte-identical', async () => {
    const app = await buildApp();
    commitBothScaffoldFiles(repoDir, "demo");
    const projectId = await createProject(app, repoDir);
    mockValidGeneration("demo");

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/generate`,
      payload: { slug: "demo", refresh: ["skill"] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // finishPreview's own comment assumes every entry is BRAND NEW (an
    // untracked file `git diff HEAD` would otherwise show nothing for) —
    // refresh is the first path where that's false: the skill file is
    // already tracked and committed, so this is the one case that actually
    // exercises "does getFileDiff show a MODIFICATION", not just "does a
    // new file get staged."
    expect(body.diff).toContain(".claude/skills/demo/SKILL.md");
    expect(body.diff).toContain("Generated: real invariant about demo.");
    expect(generateScaffoldContent).toHaveBeenCalledTimes(1);
    // The seed booleans must reflect what's actually present (both exist),
    // not the write-view refresh is about to clear — otherwise a refresh
    // would wrongly start re-injecting a stale DB draft.
    const call = vi.mocked(generateScaffoldContent).mock.calls[0][0];
    expect(call.hasSkill).toBe(true);
    expect(call.hasReviewer).toBe(true);

    const worktreeDir = path.join(repoDir, ".mullion-worktrees", "setup-demo");
    const skill = fs.readFileSync(
      path.join(worktreeDir, ".claude", "skills", "demo", "SKILL.md"),
      "utf8",
    );
    // The `.agents/skills/<slug>` mirror carries whatever the skill's final
    // resolved content is (mullion-scaffold.ts's own `skillContent`) — a
    // refresh that updated `.claude/skills` but left this mirror stale
    // would be a real, silent divergence bug.
    const mirror = fs.readFileSync(
      path.join(worktreeDir, ".agents", "skills", "demo", "SKILL.md"),
      "utf8",
    );
    const reviewer = fs.readFileSync(
      path.join(worktreeDir, ".claude", "agents", "demo-reviewer.md"),
      "utf8",
    );

    expect(skill).toContain("Generated: real invariant about demo.");
    expect(skill).not.toContain("hand-written skill content");
    expect(mirror).toContain("Generated: real invariant about demo.");
    expect(mirror).not.toContain("hand-written skill content");
    // Not just "both contain the generated marker" — the mirror must carry
    // the EXACT same bytes as `.claude/skills`, not an independently
    // resolved (and potentially diverging) copy.
    expect(mirror).toBe(skill);

    // Reviewer was NOT named in `refresh` — must still be exactly the bytes
    // committed before this call, not the mocked generation's own content.
    // Exact equality, not toContain/not.toContain: a mutation that appended
    // to (rather than replaced) the untouched file would slip past a
    // substring check but not this one — same posture as the mirror-vs-
    // skill byte-identity assertion just above.
    expect(reviewer).toBe(handWrittenReviewer("demo"));

    await app.close();
  });

  it('refresh: ["reviewer"] spawns the agent turn and overwrites only the reviewer file — the skill is left byte-identical', async () => {
    const app = await buildApp();
    commitBothScaffoldFiles(repoDir, "demo");
    const projectId = await createProject(app, repoDir);
    mockValidGeneration("demo");

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/generate`,
      payload: { slug: "demo", refresh: ["reviewer"] },
    });
    expect(res.statusCode).toBe(200);
    expect(generateScaffoldContent).toHaveBeenCalledTimes(1);

    const worktreeDir = path.join(repoDir, ".mullion-worktrees", "setup-demo");
    const skill = fs.readFileSync(
      path.join(worktreeDir, ".claude", "skills", "demo", "SKILL.md"),
      "utf8",
    );
    const reviewer = fs.readFileSync(
      path.join(worktreeDir, ".claude", "agents", "demo-reviewer.md"),
      "utf8",
    );

    expect(reviewer).toContain("Read .claude/skills/demo/SKILL.md first.");
    expect(reviewer).not.toContain("hand-written reviewer content");

    // Skill was NOT named in `refresh` — must still be exactly the bytes
    // committed before this call. Exact equality, not toContain/
    // not.toContain — see the sibling skill-refresh test's identical note.
    expect(skill).toBe(HAND_WRITTEN_SKILL);

    await app.close();
  });

  it('refresh: ["skill", "reviewer"] regenerates both already-committed files in one turn', async () => {
    const app = await buildApp();
    commitBothScaffoldFiles(repoDir, "demo");
    const projectId = await createProject(app, repoDir);
    mockValidGeneration("demo");

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/generate`,
      payload: { slug: "demo", refresh: ["skill", "reviewer"] },
    });
    expect(res.statusCode).toBe(200);
    expect(generateScaffoldContent).toHaveBeenCalledTimes(1);

    const worktreeDir = path.join(repoDir, ".mullion-worktrees", "setup-demo");
    const skill = fs.readFileSync(
      path.join(worktreeDir, ".claude", "skills", "demo", "SKILL.md"),
      "utf8",
    );
    const reviewer = fs.readFileSync(
      path.join(worktreeDir, ".claude", "agents", "demo-reviewer.md"),
      "utf8",
    );

    expect(skill).toContain("Generated: real invariant about demo.");
    expect(skill).not.toContain("hand-written skill content");
    expect(reviewer).toContain("Read .claude/skills/demo/SKILL.md first.");
    expect(reviewer).not.toContain("hand-written reviewer content");

    await app.close();
  });

  it("maps a generation-agent failure to a 502, never partially writing a preview", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, repoDir);
    const { GenerationOutputError } = await import("../../src/services/scaffold-generate.js");
    vi.mocked(generateScaffoldContent).mockRejectedValue(
      new GenerationOutputError("reviewer never referenced the skill path"),
    );

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/generate`,
      payload: { slug: "demo" },
    });
    expect(res.statusCode).toBe(502);

    await app.close();
  });

  // Gap #3 (issue #956) — a separate, stricter bucket from SETUP_RATE_LIMIT
  // (10/min). Hammering /setup/generate to its own limit must not affect
  // /setup/preview's independent budget.
  it("rate-limits /setup/generate far below /setup/preview's own budget, in a separate bucket", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, repoDir);
    mockValidGeneration("demo");

    const results: number[] = [];
    // GENERATE_RATE_LIMIT's own max (project-setup.ts) — one more than the
    // limit to actually trip it, not just reach it.
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/setup/generate`,
        payload: { slug: `demo${i}` },
      });
      results.push(res.statusCode);
    }
    expect(results).toContain(429);
    // The unrelated /setup/preview route is completely unaffected — a
    // shared bucket would already be exhausted by the loop above.
    const previewRes = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/preview`,
      payload: { slug: "demo-preview-check" },
    });
    expect(previewRes.statusCode).toBe(200);

    await app.close();
  });
});
