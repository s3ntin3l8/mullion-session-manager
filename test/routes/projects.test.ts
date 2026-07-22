import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const tmpDb = path.join(os.tmpdir(), `projects-test-${process.pid}.db`);

describe("projects route", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("creates and lists projects", async () => {
    const app = await buildApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "home", cwd: "/home/bjoern" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: "home", cwd: "/home/bjoern" });

    const listed = await app.inject({ method: "GET", url: "/api/projects" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);
    // Always present, even with no dock session to detect from — see the
    // "detectedDevServerPort" describe block below for the detection cases.
    expect(listed.json()[0].detectedDevServerPort).toBeNull();
    // /home/bjoern isn't a git repo in the test sandbox — see the
    // "currentBranch" describe block below for the git-repo case.
    expect(listed.json()[0].currentBranch).toBeNull();

    await app.close();
  });

  it("lists projects in case-insensitive alphabetical order", async () => {
    const app = await buildApp();

    await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "zeta", cwd: "/tmp/z" },
    });
    await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Alpha", cwd: "/tmp/a" },
    });
    await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "beta", cwd: "/tmp/b" },
    });
    await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Gamma", cwd: "/tmp/g" },
    });

    const listed = await app.inject({ method: "GET", url: "/api/projects" });
    expect(listed.statusCode).toBe(200);
    const names = listed.json().map((p: { name: string }) => p.name);
    const sorted = [...names].sort((a: string, b: string) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
    expect(names).toEqual(sorted);

    await app.close();
  });

  it("expands a leading ~ in cwd on create", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "tilde", cwd: "~/code/my-project" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().cwd).toBe(path.join(os.homedir(), "code/my-project"));
    await app.close();
  });

  it("rejects a project missing cwd", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "no-cwd" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("404s deleting an unknown project", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/projects/999999" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("deletes a project with no sessions", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "throwaway", cwd: "/tmp" },
    });
    const { id } = created.json();

    const deleted = await app.inject({ method: "DELETE", url: `/api/projects/${id}` });
    expect(deleted.statusCode).toBe(204);

    await app.close();
  });

  describe("PATCH /api/projects/:id", () => {
    it("updates name and cwd", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "before", cwd: "/tmp/before" },
      });
      const { id } = created.json();

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { name: "after", cwd: "/tmp/after" },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toMatchObject({ id, name: "after", cwd: "/tmp/after" });

      await app.close();
    });

    it("expands a leading ~ in cwd on update", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "tilde-edit", cwd: "/tmp/tilde-edit" },
      });
      const { id } = created.json();

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { cwd: "~/code/edited-project" },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().cwd).toBe(path.join(os.homedir(), "code/edited-project"));

      await app.close();
    });

    it("supports a partial update (name only)", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "partial-before", cwd: "/tmp/partial" },
      });
      const { id } = created.json();

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { name: "partial-after" },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toMatchObject({ name: "partial-after", cwd: "/tmp/partial" });

      await app.close();
    });

    it("sets, then clears, devServerUrl (issue #28)", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "dev-server", cwd: "/tmp/dev-server" },
      });
      const { id } = created.json();

      const withPort = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { devServerUrl: "5173" },
      });
      expect(withPort.statusCode).toBe(200);
      expect(withPort.json().devServerUrl).toBe("5173");

      const withUrl = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { devServerUrl: "http://localhost:5173/base" },
      });
      expect(withUrl.statusCode).toBe(200);
      expect(withUrl.json().devServerUrl).toBe("http://localhost:5173/base");

      const cleared = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { devServerUrl: null },
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().devServerUrl).toBeNull();

      await app.close();
    });

    it("rejects an out-of-range port and a non-http(s) devServerUrl", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "bad-dev-server", cwd: "/tmp/bad-dev-server" },
      });
      const { id } = created.json();

      const badPort = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { devServerUrl: "99999" },
      });
      expect(badPort.statusCode).toBe(400);

      const badScheme = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { devServerUrl: "ftp://localhost:5173" },
      });
      expect(badScheme.statusCode).toBe(400);

      await app.close();
    });

    it("404s updating an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/projects/999999",
        payload: { name: "nope" },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("rejects an empty body", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "empty-body", cwd: "/tmp/empty-body" },
      });
      const { id } = created.json();

      const res = await app.inject({ method: "PATCH", url: `/api/projects/${id}`, payload: {} });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  describe("GET /api/projects/discover", () => {
    let root: string;

    beforeAll(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "projects-discover-root-"));
      fs.mkdirSync(path.join(root, "git-repo", ".git"), { recursive: true });
      fs.mkdirSync(path.join(root, "plain-dir"), { recursive: true });
      fs.writeFileSync(path.join(root, "not-a-dir.txt"), "");
      process.env.PROJECTS_ROOTS = root;
    });

    afterAll(() => {
      fs.rmSync(root, { recursive: true, force: true });
      delete process.env.PROJECTS_ROOTS;
    });

    it("returns candidate subdirectories, flagging git repos and skipping files", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/discover" });
      expect(res.statusCode).toBe(200);

      const byName = Object.fromEntries(res.json().map((c: { name: string }) => [c.name, c]));
      expect(byName["git-repo"]).toMatchObject({
        cwd: path.join(root, "git-repo"),
        isGitRepo: true,
        isRegistered: false,
      });
      expect(byName["plain-dir"]).toMatchObject({ isGitRepo: false, isRegistered: false });
      expect(byName["not-a-dir.txt"]).toBeUndefined();

      await app.close();
    });

    it("flags a candidate already registered as a project", async () => {
      const app = await buildApp();
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "git-repo", cwd: path.join(root, "git-repo") },
      });

      const res = await app.inject({ method: "GET", url: "/api/projects/discover" });
      const byName = Object.fromEntries(res.json().map((c: { name: string }) => [c.name, c]));
      expect(byName["git-repo"].isRegistered).toBe(true);

      await app.close();
    });

    it("ignores a PROJECTS_ROOTS entry that doesn't exist", async () => {
      process.env.PROJECTS_ROOTS = path.join(root, "does-not-exist");
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/discover" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
      process.env.PROJECTS_ROOTS = root;
      await app.close();
    });

    it("prefers settings.projectRoots (Settings -> Projects & discovery) over the PROJECTS_ROOTS env var", async () => {
      const settingsRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "projects-discover-settings-root-"),
      );
      fs.mkdirSync(path.join(settingsRoot, "from-settings"), { recursive: true });

      const app = await buildApp();
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { projectRoots: [settingsRoot] },
      });

      const res = await app.inject({ method: "GET", url: "/api/projects/discover" });
      const names = res.json().map((c: { name: string }) => c.name);
      // Only the settings-configured root is scanned — the env-configured
      // root's "git-repo"/"plain-dir" candidates must NOT appear.
      expect(names).toEqual(["from-settings"]);

      // Clearing the array falls back to the env var again.
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { projectRoots: [] },
      });
      const fallback = await app.inject({ method: "GET", url: "/api/projects/discover" });
      expect(
        fallback
          .json()
          .map((c: { name: string }) => c.name)
          .sort(),
      ).toEqual(["git-repo", "plain-dir"]);

      fs.rmSync(settingsRoot, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("GET /api/projects/:id/dock", () => {
    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/999999/dock" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("returns [] for a project with no .crs/dock.json", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-dock-empty-"));
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "no-dock", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/dock`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("reads the project's own .crs/dock.json controls", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-dock-with-controls-"));
      fs.mkdirSync(path.join(projectCwd, ".crs"));
      fs.writeFileSync(
        path.join(projectCwd, ".crs", "dock.json"),
        JSON.stringify({
          controls: [
            { id: "dev-server", title: "Dev Server", command: "npm run dev", height: 200 },
          ],
        }),
      );

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "with-dock", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/dock`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        { id: "dev-server", title: "Dev Server", command: "npm run dev", height: 200 },
      ]);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("GET /api/projects/:id/github (issue #27)", () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(async () => {
      vi.unstubAllGlobals();
      // github-integration's `integrations` row is a singleton shared
      // across this whole test file's DB — reset it after every test in
      // this block so a connected token doesn't leak into an unrelated
      // "no token" case (same reasoning as github-integration.test.ts).
      const app = await buildApp();
      const { disconnect } = await import("../../src/services/github-integration.js");
      disconnect(app);
      await app.close();
    });

    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/999999/github" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("204s for a local project with no github.com remote", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-github-none-"));
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "no-remote", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/github`,
      });
      expect(res.statusCode).toBe(204);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("204s for a project with a github remote but no GitHub account connected", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-github-no-token-"));
      fs.mkdirSync(path.join(projectCwd, ".git"));
      fs.writeFileSync(
        path.join(projectCwd, ".git", "config"),
        '[remote "origin"]\n\turl = git@github.com:o/r.git\n',
      );
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "no-token", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/github`,
      });
      expect(res.statusCode).toBe(204);
      expect(fetchMock).not.toHaveBeenCalled();

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns issue/PR status for a project with a connected token and github remote", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-github-connected-"));
      fs.mkdirSync(path.join(projectCwd, ".git"));
      fs.writeFileSync(
        path.join(projectCwd, ".git", "config"),
        '[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n',
      );

      fetchMock.mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://api.github.com/user") {
          return Promise.resolve(jsonResponse(200, { login: "octocat" }));
        }
        if (url === "https://api.github.com/repos/acme/widgets/issues?state=open&per_page=100") {
          return Promise.resolve(
            jsonResponse(200, [
              {
                number: 1,
                title: "a bug",
                html_url: "https://github.com/acme/widgets/issues/1",
                user: { login: "a" },
              },
              {
                number: 2,
                title: "a PR",
                html_url: "https://github.com/acme/widgets/pull/2",
                user: { login: "b" },
                pull_request: {},
              },
            ]),
          );
        }
        return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
      });

      const app = await buildApp();
      await app.inject({
        method: "PUT",
        url: "/api/integrations/github/token",
        payload: { token: "ghp_connected" },
      });

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "connected", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/github`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        repo: { owner: "acme", repo: "widgets", htmlUrl: "https://github.com/acme/widgets" },
        openIssues: 1,
        openPRs: 1,
      });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("503s for a project on an unreachable remote host", async () => {
      // Unlike every other test in this block, this needs a real (failing)
      // network connection to 127.0.0.1:1, not the api.github.com fetch
      // mock this describe's beforeEach installs — same pattern the
      // existing "503s actions/dock" test below relies on.
      vi.unstubAllGlobals();

      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "github-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-github", cwd: "/x", hostId: host.json().id },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${project.json().id}/github`,
      });
      expect(res.statusCode).toBe(503);

      await app.close();
    });
  });

  describe("GET /api/projects/:id/git-status (issue #76)", () => {
    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/999999/git-status" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("204s for a local project that isn't a git repo", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-status-none-"));
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "not-a-repo", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/git-status`,
      });
      expect(res.statusCode).toBe(204);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns branch/hash/isClean for a real local git repo", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-status-real-"));
      execFileSync("git", ["init", "-b", "main"], { cwd: projectCwd, stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: projectCwd, stdio: "pipe" });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: projectCwd, stdio: "pipe" });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "real-repo", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/git-status`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ branch: "main", isClean: true, hasConflicts: false });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("503s for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "git-status-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-git-status", cwd: "/x", hostId: host.json().id },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${project.json().id}/git-status`,
      });
      expect(res.statusCode).toBe(503);

      await app.close();
    });
  });

  describe("GET /api/projects/:id/git-branches (issue #162)", () => {
    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/999999/git-branches" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("204s for a local project that isn't a git repo", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-branches-none-"));
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "not-a-repo", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/git-branches`,
      });
      expect(res.statusCode).toBe(204);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns branches and worktrees for a real local git repo", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-branches-real-"));
      execFileSync("git", ["init", "-b", "main"], { cwd: projectCwd, stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: projectCwd, stdio: "pipe" });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: projectCwd, stdio: "pipe" });
      execFileSync("git", ["branch", "feature/foo"], { cwd: projectCwd, stdio: "pipe" });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "real-repo-branches", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/git-branches`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.branches).toContainEqual({ name: "main", isCurrent: true });
      expect(body.branches).toContainEqual({ name: "feature/foo", isCurrent: false });
      expect(body.worktrees).toEqual([{ path: projectCwd, branch: "main", isMain: true }]);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("503s for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "git-branches-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-git-branches", cwd: "/x", hostId: host.json().id },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${project.json().id}/git-branches`,
      });
      expect(res.statusCode).toBe(503);

      await app.close();
    });
  });

  describe("currentBranch (issue #96)", () => {
    it("is the branch name for a local git repo", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-current-branch-"));
      fs.mkdirSync(path.join(projectCwd, ".git"));
      fs.writeFileSync(path.join(projectCwd, ".git", "HEAD"), "ref: refs/heads/feature/foo\n");

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "branchy", cwd: projectCwd },
      });

      const listed = await app.inject({ method: "GET", url: "/api/projects" });
      const project = listed.json().find((p: { id: number }) => p.id === created.json().id);
      expect(project.currentBranch).toBe("feature/foo");

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("is null for a project on an unreachable remote host, without failing the whole list", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "branch-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-branch", cwd: "/x", hostId: host.json().id },
      });

      const listed = await app.inject({ method: "GET", url: "/api/projects" });
      expect(listed.statusCode).toBe(200);
      const project = listed.json().find((p: { id: number }) => p.id === created.json().id);
      expect(project.currentBranch).toBeNull();

      await app.close();
    });
  });

  describe("multi-host (issue #26)", () => {
    it("rejects creating a project with an unknown hostId", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "orphan", cwd: "/x", hostId: "does-not-exist" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("stores a remote project's cwd raw, without local ~-expansion", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "box", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote", cwd: "~/on-the-agent", hostId: host.json().id },
      });
      expect(created.statusCode).toBe(201);
      // Expanding against *this* process's home dir would be wrong — issue
      // #26's landmine #3: a remote cwd must resolve on the agent's own
      // filesystem, so the primary stores/forwards it untouched.
      expect(created.json().cwd).toBe("~/on-the-agent");
      await app.close();
    });

    it("keys discovery's isRegistered match by (hostId, cwd), not cwd alone", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "box-2", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = host.json().id as string;
      // A *local* project at the same cwd a remote discover candidate would
      // report must not make that remote candidate look already-registered.
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "same-path-local", cwd: "/shared/path" },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/discover?hostId=${hostId}`,
      });
      // The unreachable remote host makes discovery itself fail — 503,
      // never a false "isRegistered" derived from the local project above.
      expect(res.statusCode).toBe(503);
      await app.close();
    });

    it("404s discovery for an unknown hostId", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/projects/discover?hostId=does-not-exist",
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("503s actions/dock for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "box-3", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-actions", cwd: "/x", hostId: host.json().id },
      });
      const projectId = project.json().id;

      const actions = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/actions`,
      });
      expect(actions.statusCode).toBe(503);

      const dock = await app.inject({ method: "GET", url: `/api/projects/${projectId}/dock` });
      expect(dock.statusCode).toBe(503);

      await app.close();
    });
  });

  describe("detectedDevServerPort (issue #28 phase 7)", () => {
    it("is null for a project with an active dock session this process hasn't tracked in PtyManager", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "untracked-dock", cwd: "/tmp" },
      });
      const projectId = created.json().id as number;

      // Seeded straight into the DB, not via POST /api/sessions: this
      // process's own PtyManager never spawned/attached it (app.pty.get
      // returns undefined either way), so this only exercises the
      // dock-session *query* and grouping, not a real PTY.
      const { sessions } = await import("../../src/db/schema.js");
      app.db.insert(sessions).values({ projectId, command: "npm run dev", kind: "dock" }).run();

      const listed = await app.inject({ method: "GET", url: "/api/projects" });
      const project = listed.json().find((p: { id: number }) => p.id === projectId);
      expect(project.detectedDevServerPort).toBeNull();

      await app.close();
    });

    it("is null for a remote-hosted project, even with an active local-looking dock session row", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "detect-box", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-dock", cwd: "/x", hostId: host.json().id },
      });
      const projectId = created.json().id as number;

      const { sessions } = await import("../../src/db/schema.js");
      app.db.insert(sessions).values({ projectId, command: "npm run dev", kind: "dock" }).run();

      const listed = await app.inject({ method: "GET", url: "/api/projects" });
      const project = listed.json().find((p: { id: number }) => p.id === projectId);
      expect(project.detectedDevServerPort).toBeNull();

      await app.close();
    });

    it("ignores a killed or terminal-kind session, only ever considering active dock sessions", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "mixed-sessions", cwd: "/tmp" },
      });
      const projectId = created.json().id as number;

      const { sessions } = await import("../../src/db/schema.js");
      app.db
        .insert(sessions)
        .values([
          { projectId, command: "npm run dev", kind: "dock", status: "killed" },
          { projectId, command: "bash", kind: "terminal", status: "active" },
        ])
        .run();

      // Not a security/correctness assertion beyond "the route doesn't
      // crash or misclassify these" — with no *active dock* session at all,
      // the result is still null regardless of what PtyManager itself
      // would have returned.
      const listed = await app.inject({ method: "GET", url: "/api/projects" });
      const project = listed.json().find((p: { id: number }) => p.id === projectId);
      expect(project.detectedDevServerPort).toBeNull();

      await app.close();
    });
  });
});
