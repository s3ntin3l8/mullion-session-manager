import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { gitEnv } from "../../src/services/git-env.js";
import type * as GithubIntegration from "../../src/services/github-integration.js";
import type * as ScaffoldGenerate from "../../src/services/scaffold-generate.js";

vi.mock("../../src/services/github-integration.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GithubIntegration>();
  return { ...actual, resolveGitHubToken: vi.fn().mockResolvedValue(null) };
});

vi.mock("../../src/services/scaffold-generate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ScaffoldGenerate>();
  return { ...actual, generateScaffoldContent: vi.fn() };
});

const { generateScaffoldContent } = await import("../../src/services/scaffold-generate.js");

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

const tmpDb = path.join(os.tmpdir(), `project-setup-restructure-report-test-${process.pid}.db`);
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

  // Issue #2531 — a restructure also returns the passages it left unchanged.
  it("restructure returns the passages it left unchanged", async () => {
    fs.writeFileSync(path.join(repoDir, "AGENTS.md"), "# P\n\n## Workflow rules\n- x\n");
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-m", "add AGENTS.md", "--no-verify"]);
    const app = await buildApp();
    const projectId = await createProject(app, repoDir);
    vi.mocked(generateScaffoldContent).mockResolvedValue({
      skill: "---\nname: demo\n---\nS\n",
      reviewer: "---\nname: demo-reviewer\n---\nRead .claude/skills/demo/SKILL.md first.\n",
      scaffoldRegion: "Pointer.",
      sandboxed: true,
      possiblyGeneric: false,
      agentsMdBody: "# P\n\n<<<MULLION_REGION>>>\n\n## Repo specifics\n- y\n",
      conflicts: [
        { file: "CONTRIBUTING.md", excerpt: "ask @bot", kind: "stale-reference", note: "n" },
      ],
      droppedConflictLines: 1,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/generate`,
      payload: { slug: "demo", existingInstructions: "restructure" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().conflicts).toEqual([
      { file: "CONTRIBUTING.md", excerpt: "ask @bot", kind: "stale-reference", note: "n" },
    ]);
    expect(res.json().droppedConflictLines).toBe(1);
    await app.close();
  });
});
