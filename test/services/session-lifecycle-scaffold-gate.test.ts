import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" — see mock-pty.ts's header comment.
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import type * as ChildProcess from "node:child_process";

// Issue #1082(a) — once a project has been scaffolded (routes/
// project-setup.ts's `/setup/apply` stamping `projects.slug` at the point
// it commits the scaffold's files), a committed
// `.claude/skills/<slug>/SKILL.md`/`.claude/agents/<slug>-reviewer.md`
// already reaches Claude Code natively — session-lifecycle.ts's
// createSessionRecord must stop ALSO injecting the DB-authored
// `project_tooling.skill`/`.reviewerAgent` copy live for that same project.
// The gate is computed in session-lifecycle.ts itself (not adapter-side —
// see that function's own comment for why), so it's verified here through
// its real, observable effect: whether claude-code.ts's prepareLaunch
// composes a per-session `<id>.mullion-bundle` directory carrying the
// project's own skill/reviewer content at all (composeClaudeSessionBundle
// is only ever called when at least one of ctx.projectSkill/
// projectReviewerAgent is set — see claude-code.ts's prepareLaunch).
// `session.projectSkill`/`projectReviewerAgent` themselves are private on
// Session (pty-manager.ts), so this is the correct, real, end-to-end
// observation point rather than reaching into a private field.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));

// This file's worktree-regression suite (below) needs a REAL `git worktree
// add` to run (checkoutBranchWorktree/resolveWorktreeCwd, git-worktree.ts)
// — "git" passes through, everything else (systemd-run, dtach) stays faked,
// same posture as test/routes/sessions.test.ts's own worktree-exercising
// suite.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual, { passthrough: ["git"] });
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { projects } = await import("../../src/db/schema.js");
const { writeProjectSkill, writeProjectReviewerAgent } =
  await import("../../src/services/project-tooling.js");
const { scaffoldSkillPath, scaffoldReviewerPath } =
  await import("../../src/services/mullion-scaffold.js");
const { gitEnv } = await import("../../src/services/git-env.js");

const tmpDb = path.join(os.tmpdir(), `session-lifecycle-scaffold-gate-test-${process.pid}.db`);

// Single, FILE-scoped DB lifecycle (not one per describe block): every test
// below writes `<sessionId>.mullion-bundle` under the SAME shared sessionsDir
// (test setup resolves it once per process — see app.pty.hookSocketPath's
// own comment), and asserts on its presence/absence by that session's own
// numeric id. A per-describe DB reset would restart SQLite's autoincrement
// back at 1, so a later describe's session "2" could collide with an
// EARLIER describe's already-on-disk "2.mullion-bundle" from a completely
// different test — a false "still exists" that has nothing to do with this
// file's own gating logic under test. One shared DB across the whole file
// keeps every session id unique for the process's lifetime, so no directory
// from an earlier test can ever be mistaken for a later test's own output.
beforeAll(() => {
  fs.rmSync(tmpDb, { force: true });
  process.env.DATABASE_URL = `file:${tmpDb}`;
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDb, { force: true });
  delete process.env.DATABASE_URL;
});

async function waitUntil(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

const SKILL_CONTENT = `---\nname: my-project-skill\ndescription: "A project skill."\n---\n\nBody.\n`;
const REVIEWER_CONTENT = `---\nname: my-project-reviewer\ndescription: "A reviewer subagent."\ntools: Read\nmodel: inherit\n---\n\nBody.\n`;

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

function composedBundleDir(app: Awaited<ReturnType<typeof buildApp>>, sessionId: string) {
  const sessionsDir = path.dirname(app.pty.hookSocketPath);
  return path.join(sessionsDir, `${sessionId}.mullion-bundle`);
}

describe("session-lifecycle.ts — scaffold-committed-file gate on projectSkill/projectReviewerAgent (issue #1082(a))", () => {
  async function createProject(app: Awaited<ReturnType<typeof buildApp>>, name: string) {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name, cwd: projectDir },
    });
    const projectId = res.json().id as number;
    return { projectId, projectDir };
  }

  async function spawnClaudeSession(app: Awaited<ReturnType<typeof buildApp>>, projectId: number) {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "claude" },
    });
    expect(res.statusCode).toBe(201);
    const sessionId = String(res.json().id);
    await waitUntil(() => app.pty.get(sessionId)?.isAlive === true);
    return sessionId;
  }

  it("skips the composed per-session bundle once a committed scaffold file exists for this project's slug", async () => {
    const app = await buildApp();
    const { projectId, projectDir } = await createProject(app, "scaffold-gate-both-committed");
    const slug = "acme-widgets";

    writeProjectSkill(app.db, projectId, SKILL_CONTENT);
    writeProjectReviewerAgent(app.db, projectId, REVIEWER_CONTENT);

    const skillPath = path.join(projectDir, scaffoldSkillPath(slug));
    const reviewerPath = path.join(projectDir, scaffoldReviewerPath(slug));
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, SKILL_CONTENT);
    fs.mkdirSync(path.dirname(reviewerPath), { recursive: true });
    fs.writeFileSync(reviewerPath, REVIEWER_CONTENT);

    app.db.update(projects).set({ slug }).where(eq(projects.id, projectId)).run();

    const sessionId = await spawnClaudeSession(app, projectId);

    // Both the skill and the reviewer are already committed — no per-session
    // composed bundle should exist at all (claude-code.ts's prepareLaunch
    // falls through to the plain shipped-bundle branch, which never writes
    // under sessionsDir).
    expect(fs.existsSync(composedBundleDir(app, sessionId))).toBe(false);

    await app.close();
  });

  // CodeQL js/path-injection review finding on this PR — `projects.slug`'s
  // only current writer (routes/project-setup.ts's `/setup/apply`) already
  // runs every slug through `isValidScaffoldSlug` before it's ever stamped,
  // but that guarantee lives in a different file/request entirely, which a
  // purely local dataflow scanner can't see. This test bypasses that writer
  // entirely (writing straight to the DB, the same way a future buggy
  // writer could) to prove the gate itself, not just today's one producer,
  // refuses to build a path out of an unsafe slug — and actually
  // demonstrates the traversal, rather than merely asserting a file that
  // wouldn't exist either way stays missing: a naive `existsSync(false)`
  // check here would pass regardless of whether the fix is present, since
  // `path.join` silently normalizes `..` segments before `existsSync` ever
  // runs (an arbitrary nonexistent target proves nothing). Instead, a real
  // marker file is planted at the EXACT location the traversal would
  // resolve to (`.claude/skills/../../../marker/SKILL.md`, from
  // `<projectDir>`, normalizes to `<projectDir>/../marker/SKILL.md` —
  // verified by hand: two `..` segments cancel `.claude/skills`, landing
  // back at `projectDir`, and the third steps one level above it) — so an
  // unfixed sink would find it (falsely reporting the scaffold as
  // committed) while the fixed one refuses to construct that path at all.
  it("treats a path-traversal-shaped slug as no-scaffold, never joins it into a filesystem path (defense in depth)", async () => {
    const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-gate-traversal-scratch-"));
    const projectDir = path.join(scratchRoot, "project");
    fs.mkdirSync(projectDir);
    // The traversal's actual target, one level ABOVE projectDir — never
    // legitimately reachable via any valid slug, which can't contain `/`.
    const markerDir = path.join(scratchRoot, "marker");
    fs.mkdirSync(markerDir);
    fs.writeFileSync(
      path.join(markerDir, "SKILL.md"),
      "planted outside the project — must never be read as this project's own scaffold",
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "scaffold-gate-unsafe-slug", cwd: projectDir },
      });
      const projectId = res.json().id as number;

      writeProjectSkill(app.db, projectId, SKILL_CONTENT);
      writeProjectReviewerAgent(app.db, projectId, REVIEWER_CONTENT);
      // Bypasses isValidScaffoldSlug entirely — simulates a slug that
      // shouldn't be able to reach this column at all, per this function's
      // own defense-in-depth comment.
      app.db
        .update(projects)
        .set({ slug: "../../../marker" })
        .where(eq(projects.id, projectId))
        .run();

      const sessionId = await spawnClaudeSession(app, projectId);

      // An unsafe slug must fall through to the ordinary "no committed
      // scaffold" behavior — the DB-authored content still gets composed,
      // exactly as if `projects.slug` were null. If the traversal had
      // succeeded instead, no per-session bundle would exist at all (the
      // planted marker would have been treated as this project's own
      // committed SKILL.md).
      const bundleDir = composedBundleDir(app, sessionId);
      expect(fs.existsSync(path.join(bundleDir, "skills", "my-project-skill", "SKILL.md"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(bundleDir, "agents", "my-project-reviewer.md"))).toBe(true);
    } finally {
      // try/finally, not a bare trailing call: a failed assertion above
      // (e.g. this exact regression reappearing) must not also leak
      // `app`'s hooks.sock into whichever test runs next in this file —
      // that turned an actual, correctly-failing assertion into a
      // misleading cascade of unrelated SocketAlreadyListeningError
      // failures when this test was first written against the unfixed
      // source.
      await app.close();
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  it("keeps composing the per-session bundle when no committed scaffold file exists (regression guard)", async () => {
    const app = await buildApp();
    const { projectId } = await createProject(app, "scaffold-gate-no-scaffold");

    writeProjectSkill(app.db, projectId, SKILL_CONTENT);
    writeProjectReviewerAgent(app.db, projectId, REVIEWER_CONTENT);
    // Deliberately no `projects.slug` set, and no scaffold file written to
    // disk — today's ordinary "DB-authored content, never scaffolded" case.

    const sessionId = await spawnClaudeSession(app, projectId);

    const bundleDir = composedBundleDir(app, sessionId);
    expect(fs.existsSync(path.join(bundleDir, "skills", "my-project-skill", "SKILL.md"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(bundleDir, "agents", "my-project-reviewer.md"))).toBe(true);

    await app.close();
  });

  it("keeps composing the skill (only) when the reviewer's scaffold file is committed but the skill's isn't", async () => {
    const app = await buildApp();
    const { projectId, projectDir } = await createProject(app, "scaffold-gate-partial");
    const slug = "acme-widgets";

    writeProjectSkill(app.db, projectId, SKILL_CONTENT);
    writeProjectReviewerAgent(app.db, projectId, REVIEWER_CONTENT);

    const reviewerPath = path.join(projectDir, scaffoldReviewerPath(slug));
    fs.mkdirSync(path.dirname(reviewerPath), { recursive: true });
    fs.writeFileSync(reviewerPath, REVIEWER_CONTENT);

    app.db.update(projects).set({ slug }).where(eq(projects.id, projectId)).run();

    const sessionId = await spawnClaudeSession(app, projectId);

    const bundleDir = composedBundleDir(app, sessionId);
    expect(fs.existsSync(path.join(bundleDir, "skills", "my-project-skill", "SKILL.md"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(bundleDir, "agents", "my-project-reviewer.md"))).toBe(false);

    await app.close();
  });
});

// mullion-reviewer, this PR's own review pass — the gate must check whatever
// cwd this SESSION actually launches with, not unconditionally `project.cwd`:
// a session spawned into a `.mullion-worktrees/` checkout (a real, separate
// git working tree — see AGENTS.md's own "two distinct worktree concepts")
// can disagree with `project.cwd` about whether the scaffold file exists,
// e.g. when the worktree's branch predates the scaffold's own merge commit.
describe("session-lifecycle.ts — scaffold gate checks the session's own worktree cwd, not project.cwd (issue #1082(a) fix)", () => {
  const slug = "acme-widgets";
  let repoDir: string;

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-gate-worktree-"));
    git(repoDir, ["init", "-b", "main"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repoDir, "README.md"), "# repo\n");
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-m", "initial commit", "--no-verify"]);
    // Branched BEFORE the scaffold commit below — this branch's own
    // checkout never gets the scaffolded file.
    git(repoDir, ["branch", "old-branch"]);

    const skillPath = path.join(repoDir, scaffoldSkillPath(slug));
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, SKILL_CONTENT);
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-m", "scaffold Mullion integration (acme-widgets)", "--no-verify"]);
  });

  afterAll(() => {
    if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  async function createProjectFromRepo(app: Awaited<ReturnType<typeof buildApp>>) {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "scaffold-gate-worktree", cwd: repoDir },
    });
    return res.json().id as number;
  }

  async function spawnWorktreeClaudeSession(
    app: Awaited<ReturnType<typeof buildApp>>,
    projectId: number,
    branch: string,
  ) {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "claude", worktree: { branch } },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    const sessionId = String(body.id);
    await waitUntil(() => app.pty.get(sessionId)?.isAlive === true);
    return { sessionId, cwd: body.cwd as string };
  }

  it("does NOT suppress DB content for a worktree checked out from a branch that predates the scaffold commit", async () => {
    const app = await buildApp();
    const projectId = await createProjectFromRepo(app);
    writeProjectSkill(app.db, projectId, SKILL_CONTENT);
    app.db.update(projects).set({ slug }).where(eq(projects.id, projectId)).run();

    const { sessionId, cwd } = await spawnWorktreeClaudeSession(app, projectId, "old-branch");

    // Sanity check the test's own premise: the worktree checkout really
    // doesn't have the scaffolded file (unlike project.cwd's own "main").
    expect(fs.existsSync(path.join(cwd, scaffoldSkillPath(slug)))).toBe(false);
    expect(fs.existsSync(path.join(repoDir, scaffoldSkillPath(slug)))).toBe(true);

    // The buggy version of this gate checked `project.cwd` (which has the
    // file) and would have suppressed the DB copy here, leaving this
    // worktree session with neither the real file nor the DB content.
    const bundleDir = composedBundleDir(app, sessionId);
    expect(fs.existsSync(path.join(bundleDir, "skills", "my-project-skill", "SKILL.md"))).toBe(
      true,
    );

    await app.close();
  });

  it("DOES suppress DB content for a worktree checked out from a branch that already has the scaffold commit", async () => {
    const app = await buildApp();
    const projectId = await createProjectFromRepo(app);
    writeProjectSkill(app.db, projectId, SKILL_CONTENT);
    app.db.update(projects).set({ slug }).where(eq(projects.id, projectId)).run();

    // "main" (unlike "old-branch" above) already has the scaffold commit.
    const { sessionId, cwd } = await spawnWorktreeClaudeSession(app, projectId, "main");
    expect(fs.existsSync(path.join(cwd, scaffoldSkillPath(slug)))).toBe(true);

    expect(fs.existsSync(composedBundleDir(app, sessionId))).toBe(false);

    await app.close();
  });
});
