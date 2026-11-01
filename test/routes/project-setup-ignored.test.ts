import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { gitEnv } from "../../src/services/git-env.js";
import type * as GithubIntegration from "../../src/services/github-integration.js";

vi.mock("../../src/services/github-integration.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GithubIntegration>();
  return { ...actual, resolveGitHubToken: vi.fn().mockResolvedValue(null) };
});

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

function initRepo(cwd: string) {
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "# test repo\n");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "initial commit", "--no-verify"]);
}

const tmpDb = path.join(os.tmpdir(), `project-setup-ignored-test-${process.pid}.db`);
let repoDir: string;

async function createProject(app: Awaited<ReturnType<typeof buildApp>>, cwd: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { allowDuplicate: true, name: "setup-test", cwd },
  });
  return res.json().id as number;
}

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
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  describe("issue #2473 — gitignored targets and the skill/reviewer exclusion", () => {
    function ignoreClaudeDir() {
      fs.writeFileSync(path.join(repoDir, ".gitignore"), "# --- AI ---\n.claude/\n");
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "ignore .claude", "--no-verify"]);
    }
    const preview = (app: Awaited<ReturnType<typeof buildApp>>, id: number, extra = {}) =>
      app.inject({
        method: "POST",
        url: `/api/projects/${id}/setup/preview`,
        payload: { slug: "demo", ...extra },
      });
    const committedFiles = () =>
      execFileSync("git", ["show", "--name-only", "--pretty=", "HEAD"], {
        cwd: path.join(repoDir, ".mullion-worktrees", "setup-demo"),
        env: gitEnv(),
      })
        .toString()
        .split("\n")
        .filter(Boolean);

    it("reports ignored targets with their rule, force-adds them, and apply commits them", async () => {
      ignoreClaudeDir();
      const app = await buildApp();
      const projectId = await createProject(app, repoDir);

      const res = await preview(app, projectId);
      const body = res.json();
      expect(body.ignoredPaths).toHaveLength(2);
      expect(body.ignoredPaths).toEqual(
        expect.arrayContaining([
          { path: ".claude/agents/demo-reviewer.md", rule: ".gitignore:2:.claude/" },
          { path: ".claude/skills/demo/SKILL.md", rule: ".gitignore:2:.claude/" },
        ]),
      );
      expect(body.diff).toContain(".claude/skills/demo/SKILL.md");

      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/setup/apply`,
        payload: { previewId: body.previewId },
      });
      expect(committedFiles()).toEqual(
        expect.arrayContaining([".claude/skills/demo/SKILL.md", ".claude/agents/demo-reviewer.md"]),
      );
      await app.close();
    });

    it("a repo that ignores nothing has no ignoredPaths field", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, repoDir);
      const body = (await preview(app, projectId)).json();
      expect("ignoredPaths" in body).toBe(false);
      await app.close();
    });

    it("includeSkillAndReviewer:false writes no skill, reviewer or mirror and leaves no dangling pointer — even after a preview that included them", async () => {
      ignoreClaudeDir();
      const app = await buildApp();
      const projectId = await createProject(app, repoDir);
      await preview(app, projectId);

      const body = (await preview(app, projectId, { includeSkillAndReviewer: false })).json();
      expect(body.files.filter((f: string) => f.includes("demo"))).toEqual([]);
      expect("ignoredPaths" in body).toBe(false);

      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/setup/apply`,
        payload: { previewId: body.previewId },
      });
      const committed = committedFiles();
      expect(committed).toEqual(expect.arrayContaining(["AGENTS.md", "CLAUDE.md"]));
      expect(committed.filter((f) => f.includes("demo") || f.includes(".claude/"))).toEqual([]);
      const agentsMd = fs.readFileSync(
        path.join(repoDir, ".mullion-worktrees", "setup-demo", "AGENTS.md"),
        "utf8",
      );
      expect(agentsMd).not.toContain("SKILL.md");
      expect(agentsMd).toContain("Workflow Conventions");
      await app.close();
    });

    it("generate with the skill and reviewer excluded and no instructions mode is a 409", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, repoDir);
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/setup/generate/start`,
        payload: { slug: "demo", includeSkillAndReviewer: false },
      });
      expect(res.statusCode).toBe(409);
      await app.close();
    });
  });
});
