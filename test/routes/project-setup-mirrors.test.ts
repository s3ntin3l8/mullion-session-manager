import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { gitEnv } from "../../src/services/git-env.js";

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

const tmpDb = path.join(os.tmpdir(), `project-setup-mirrors-test-${process.pid}.db`);
let repoDir: string;

describe("project-setup route — skill mirror drift", () => {
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
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-setup-mirrors-repo-"));
    git(repoDir, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(repoDir, "README.md"), "# test repo\n");
    fs.writeFileSync(path.join(repoDir, ".prettierignore"), ".claude/\n");
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-m", "initial commit", "--no-verify"]);
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("preview offers the missing .prettierignore line when only .claude/ is ignored", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, name: "setup-test", cwd: repoDir },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${created.json().id}/setup/preview`,
      payload: { slug: "demo" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.files).toContain(".prettierignore");
    expect(body.diff).toContain("+.agents/");
    await app.close();
  });
});
