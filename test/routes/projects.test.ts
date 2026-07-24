import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { gitEnv } from "../../src/services/git-env.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Captured before any test stubs globalThis.fetch — lets the remote-host
// success test (issue #222) delegate real loopback calls to its own
// in-process agent server through the same fetchMock that mocks
// api.github.com, instead of needing genuine internet access.
const realFetch = globalThis.fetch;

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

  it("creates the project directory on disk on create", async () => {
    const app = await buildApp();
    const cwd = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mkdir-create-")), "project");
    expect(fs.existsSync(cwd)).toBe(false);
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "mkdir-test", cwd },
    });
    expect(created.statusCode).toBe(201);
    expect(fs.existsSync(cwd)).toBe(true);
    await app.close();
  });

  it("succeeds even when mkdir fails on create", async () => {
    const app = await buildApp();
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "mkdir-fail-create-"));
    const cwd = path.join(parent, "project");
    // Create a regular file so recursive mkdir fails with ENOTDIR
    fs.writeFileSync(cwd, "i am a file, not a directory", "utf-8");
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "mkdir-fail", cwd },
    });
    expect(created.statusCode).toBe(201);
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

    it("creates the project directory on disk on update", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "mkdir-update", cwd: "/tmp/mkdir-update-init" },
      });
      const { id } = created.json();
      const newCwd = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mkdir-update-")), "project");
      expect(fs.existsSync(newCwd)).toBe(false);

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { cwd: newCwd },
      });
      expect(patched.statusCode).toBe(200);
      expect(fs.existsSync(newCwd)).toBe(true);

      await app.close();
    });

    it("succeeds even when mkdir fails on update", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "mkdir-fail-update", cwd: "/tmp/mkdir-fail-update-init" },
      });
      const { id } = created.json();
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), "mkdir-fail-update-"));
      const newCwd = path.join(parent, "project");
      fs.writeFileSync(newCwd, "i am a file, not a directory", "utf-8");

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { cwd: newCwd },
      });
      expect(patched.statusCode).toBe(200);

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

  describe("GET /api/projects/:id/github/prs (issue #102)", () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(async () => {
      vi.unstubAllGlobals();
      const app = await buildApp();
      const { disconnect } = await import("../../src/services/github-integration.js");
      disconnect(app);
      await app.close();
    });

    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/999999/github/prs" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("204s for a local project with no github.com remote", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-prs-no-remote-"));
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "no-remote", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/github/prs`,
      });
      expect(res.statusCode).toBe(204);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("204s for a project with a github remote but empty cache (poller hasn't run yet)", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-prs-no-cache-"));
      fs.mkdirSync(path.join(projectCwd, ".git"));
      fs.writeFileSync(
        path.join(projectCwd, ".git", "config"),
        '[remote "origin"]\n\turl = git@github.com:o/r.git\n',
      );
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "no-cache", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/github/prs`,
      });
      expect(res.statusCode).toBe(204);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("204s when the poller cache is populated but has no PRs", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-prs-empty-"));
      fs.mkdirSync(path.join(projectCwd, ".git"));
      fs.writeFileSync(
        path.join(projectCwd, ".git", "config"),
        '[remote "origin"]\n\turl = git@github.com:empty/prs.git\n',
      );

      fetchMock.mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://api.github.com/user") {
          return Promise.resolve(jsonResponse(200, { login: "octocat" }));
        }
        return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
      });

      const app = await buildApp();
      await app.inject({
        method: "PUT",
        url: "/api/integrations/github/token",
        payload: { token: "ghp_prs_token" },
      });

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "empty-prs", cwd: projectCwd },
      });

      // Prime the cache as the poller would.
      const { setRepoPRsStatus } = await import("../../src/services/github.js");
      setRepoPRsStatus("empty", "prs", {
        prs: [],
        prSummary: { total: 0, pass: 0, fail: 0, pending: 0 },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/github/prs`,
      });
      expect(res.statusCode).toBe(204);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns per-PR status from the warm cache for a connected project", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-prs-cached-"));
      fs.mkdirSync(path.join(projectCwd, ".git"));
      fs.writeFileSync(
        path.join(projectCwd, ".git", "config"),
        '[remote "origin"]\n\turl = git@github.com:cached/pr-repo.git\n',
      );

      fetchMock.mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://api.github.com/user") {
          return Promise.resolve(jsonResponse(200, { login: "octocat" }));
        }
        return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
      });

      const app = await buildApp();
      await app.inject({
        method: "PUT",
        url: "/api/integrations/github/token",
        payload: { token: "ghp_prs_token" },
      });

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "cached-prs", cwd: projectCwd },
      });

      const { setRepoPRsStatus } = await import("../../src/services/github.js");
      setRepoPRsStatus("cached", "pr-repo", {
        prs: [
          {
            number: 7,
            title: "Add CI badge",
            htmlUrl: "https://github.com/cached/pr-repo/pull/7",
            author: "dev",
            headSha: "abc",
            headBranch: "add-badge",
            baseBranch: "main",
            ciStatus: "success",
            actionsRuns: [
              {
                name: "CI",
                status: "completed",
                conclusion: "success",
                htmlUrl: "https://github.com/cached/pr-repo/actions/runs/1",
                headSha: "abc",
              },
            ],
          },
        ],
        prSummary: { total: 1, pass: 1, fail: 0, pending: 0 },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/github/prs`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.prs).toHaveLength(1);
      expect(body.prs[0].number).toBe(7);
      expect(body.prs[0].ciStatus).toBe("success");
      expect(body.prSummary).toEqual({ total: 1, pass: 1, fail: 0, pending: 0 });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("?branch= filters the cached PR list down to that branch's PR (issue #202)", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-prs-branch-filter-"));
      fs.mkdirSync(path.join(projectCwd, ".git"));
      fs.writeFileSync(
        path.join(projectCwd, ".git", "config"),
        '[remote "origin"]\n\turl = git@github.com:branch/filter.git\n',
      );

      fetchMock.mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://api.github.com/user") {
          return Promise.resolve(jsonResponse(200, { login: "octocat" }));
        }
        return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
      });

      const app = await buildApp();
      await app.inject({
        method: "PUT",
        url: "/api/integrations/github/token",
        payload: { token: "ghp_prs_token" },
      });

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "branch-filter-prs", cwd: projectCwd },
      });

      const { setRepoPRsStatus } = await import("../../src/services/github.js");
      const prA = {
        number: 1,
        title: "PR A",
        htmlUrl: "https://github.com/branch/filter/pull/1",
        author: "dev",
        headSha: "a1",
        headBranch: "feature/a",
        baseBranch: "main",
        ciStatus: "success" as const,
        actionsRuns: [],
      };
      const prB = {
        number: 2,
        title: "PR B",
        htmlUrl: "https://github.com/branch/filter/pull/2",
        author: "dev",
        headSha: "b1",
        headBranch: "feature/b",
        baseBranch: "main",
        ciStatus: "failure" as const,
        actionsRuns: [],
      };
      setRepoPRsStatus("branch", "filter", {
        prs: [prA, prB],
        prSummary: { total: 2, pass: 1, fail: 1, pending: 0 },
      });

      const projectId = created.json().id;

      const filtered = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/github/prs?branch=feature/a`,
      });
      expect(filtered.statusCode).toBe(200);
      const filteredBody = filtered.json();
      expect(filteredBody.prs).toHaveLength(1);
      expect(filteredBody.prs[0].number).toBe(1);
      expect(filteredBody.prSummary).toEqual({ total: 1, pass: 1, fail: 0, pending: 0 });

      const noMatch = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/github/prs?branch=no-such-branch`,
      });
      expect(noMatch.statusCode).toBe(204);

      const unfiltered = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/github/prs`,
      });
      expect(unfiltered.statusCode).toBe(200);
      expect(unfiltered.json().prs).toHaveLength(2);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("503s for a project on an unreachable remote host (issue #222)", async () => {
      // Same pattern as the /github route's own unreachable-host test above:
      // a real (failing) connection attempt to 127.0.0.1:1, not the
      // api.github.com fetch mock this describe's beforeEach installs.
      vi.unstubAllGlobals();

      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "prs-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-prs", cwd: "/x", hostId: host.json().id },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${project.json().id}/github/prs`,
      });
      expect(res.statusCode).toBe(503);

      await app.close();
    });

    it("returns per-PR status for a remote-hosted project via the agent (issue #222)", async () => {
      // Full round trip: a real listening agent resolves owner/repo from
      // its own filesystem via /internal/github-repo, the primary reads the
      // warm prsCache (populated here the same way the poller would) keyed
      // by that owner/repo, and returns it — same as the local-project test
      // above, but with the repoRef resolved over the wire instead of via
      // parseGitRemote(project.cwd) directly. fetchMock still handles the
      // github.com token-validation call (like every other test here), but
      // delegates real 127.0.0.1 calls to the actual fetch so the primary's
      // RemoteHostClient can genuinely reach the agent below.
      fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://api.github.com/user") {
          return Promise.resolve(jsonResponse(200, { login: "octocat" }));
        }
        if (url.startsWith("http://127.0.0.1:")) {
          return realFetch(input, init);
        }
        return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
      });

      const remoteCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-prs-remote-"));
      fs.mkdirSync(path.join(remoteCwd, ".git"));
      fs.writeFileSync(
        path.join(remoteCwd, ".git", "config"),
        '[remote "origin"]\n\turl = git@github.com:remote/pr-repo.git\n',
      );

      const AGENT_TOKEN = "prs-remote-agent-token";
      const prevEnv: Record<string, string | undefined> = {};
      const agentEnv = {
        MULLION_ROLE: "agent",
        MULLION_AGENT_TOKEN: AGENT_TOKEN,
        PROJECTS_ROOTS: os.tmpdir(),
      };
      for (const key of Object.keys(agentEnv)) {
        prevEnv[key] = process.env[key];
        process.env[key] = agentEnv[key as keyof typeof agentEnv];
      }
      const agentApp = await buildApp();
      for (const key of Object.keys(agentEnv)) {
        if (prevEnv[key] === undefined) delete process.env[key];
        else process.env[key] = prevEnv[key];
      }
      await agentApp.listen({ port: 0, host: "127.0.0.1" });
      const address = agentApp.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a real bound address");
      }

      const primary = await buildApp();
      await primary.inject({
        method: "PUT",
        url: "/api/integrations/github/token",
        payload: { token: "ghp_remote_prs_token" },
      });
      const host = await primary.inject({
        method: "POST",
        url: "/api/hosts",
        payload: {
          name: "prs-remote-success-host",
          baseUrl: `http://127.0.0.1:${address.port}`,
          token: AGENT_TOKEN,
        },
      });
      const project = await primary.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-prs-success", cwd: remoteCwd, hostId: host.json().id },
      });

      const { setRepoPRsStatus } = await import("../../src/services/github.js");
      setRepoPRsStatus("remote", "pr-repo", {
        prs: [
          {
            number: 3,
            title: "Remote PR",
            htmlUrl: "https://github.com/remote/pr-repo/pull/3",
            author: "dev",
            headSha: "def",
            headBranch: "remote-branch",
            baseBranch: "main",
            ciStatus: "success",
            actionsRuns: [],
          },
        ],
        prSummary: { total: 1, pass: 1, fail: 0, pending: 0 },
      });

      const res = await primary.inject({
        method: "GET",
        url: `/api/projects/${project.json().id}/github/prs`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.prs).toHaveLength(1);
      expect(body.prs[0].number).toBe(3);
      expect(body.prSummary).toEqual({ total: 1, pass: 1, fail: 0, pending: 0 });

      fs.rmSync(remoteCwd, { recursive: true, force: true });
      await primary.close();
      await agentApp.close();
    });
  });

  describe("GET /api/projects/git-statuses (batch, issue #166)", () => {
    it("returns empty projects/sessions maps when no ids are given", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/git-statuses" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ projects: {}, sessions: {} });
      await app.close();
    });

    it("returns empty projects/sessions maps for an empty ids string", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/git-statuses?ids=" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ projects: {}, sessions: {} });
      await app.close();
    });

    it("returns git status for a real local git repo", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-git-status-real-"));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "batch-real-repo", cwd: projectCwd },
      });
      const projectId = created.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${projectId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.projects[String(projectId)]).toMatchObject({
        branch: "main",
        isClean: true,
        hasConflicts: false,
      });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns null for a local project that isn't a git repo", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-git-status-none-"));
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "batch-not-a-repo", cwd: projectCwd },
      });
      const projectId = created.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${projectId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().projects[String(projectId)]).toBeNull();

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("omits a project with a transient git failure from the response", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-git-status-transient-"));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      // Break HEAD so `git status` fails while `.git` still exists.
      fs.unlinkSync(path.join(projectCwd, ".git", "HEAD"));

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "batch-transiently-broken", cwd: projectCwd },
      });
      const projectId = created.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${projectId}`,
      });
      expect(res.statusCode).toBe(200);
      // Project is omitted (not in response) because git status failed.
      expect(res.json()).toEqual({ projects: {}, sessions: {} });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("omits a project on an unreachable remote host from the response", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "batch-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "batch-remote", cwd: "/x", hostId: host.json().id },
      });
      const projectId = project.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${projectId}`,
      });
      expect(res.statusCode).toBe(200);
      // Remote host unreachable — project omitted from response.
      expect(res.json()).toEqual({ projects: {}, sessions: {} });

      await app.close();
    });

    it("handles a mix of repo, non-repo, and transient-failure projects", async () => {
      const { execFileSync } = await import("node:child_process");
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-mix-repo-"));
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: repoDir,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(repoDir, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: repoDir,
        stdio: "pipe",
        env: gitEnv(),
      });

      const nonRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-mix-nonrepo-"));

      const app = await buildApp();
      const repo = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "batch-mix-repo", cwd: repoDir },
      });
      const nonRepo = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "batch-mix-nonrepo", cwd: nonRepoDir },
      });
      const repoId = repo.json().id as number;
      const nonRepoId = nonRepo.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${repoId},${nonRepoId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.projects[String(repoId)]).toMatchObject({ branch: "main", isClean: true });
      expect(body.projects[String(nonRepoId)]).toBeNull();

      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(nonRepoDir, { recursive: true, force: true });
      await app.close();
    });

    it("returns per-session git status for a session's worktree cwd, distinct from its project", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-project-"));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      // A real linked worktree on a distinct branch, checked out outside
      // the project's own cwd — exactly the "cwd points outside the
      // project root" shape sessions.cwd allows (see
      // resolveSessionCwdTargets's own doc comment). `git worktree add`
      // requires a path that doesn't exist yet, so the parent (not the
      // worktree dir itself) is what mkdtempSync creates securely —
      // unlike a Date.now()-suffixed path, this isn't guessable/racy
      // (CodeQL js/insecure-temporary-file).
      const worktreeParent = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-worktree-"));
      const worktreeDir = path.join(worktreeParent, "wt");
      execFileSync("git", ["worktree", "add", "-b", "feature/x", worktreeDir], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(worktreeDir, "b.txt"), "b");

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "batch-session-project", cwd: projectCwd },
      });
      const projectId = created.json().id as number;

      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", cwd: worktreeDir },
      });
      const sessionId = sessionRes.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${projectId}&sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Project-level status (its own cwd) stays clean/main.
      expect(body.projects[String(projectId)]).toMatchObject({ branch: "main", isClean: true });
      // Session-level status (the worktree's cwd) is a distinct branch with
      // an untracked file — not the same as the project's own status.
      expect(body.sessions[String(sessionId)]).toMatchObject({
        branch: "feature/x",
        isClean: false,
      });

      execFileSync("git", ["worktree", "remove", "--force", worktreeDir], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.rmSync(worktreeParent, { recursive: true, force: true });
      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("prefers a session's live (OSC-7-announced) cwd over its static launch cwd once one arrives", async () => {
      // Issue: sidebar worktree display. Unlike the worktree test above (a
      // session launched WITH a cwd override), this session is launched with
      // NO cwd override at all — session.cwd stays null, spawned at the
      // project's own root. `app.pty.get(id)?.liveCwd` is stubbed rather than
      // driven through a real spawned shell (this test's actual concern is
      // resolveSessionCwdTargets's merge logic, not PtyManager's OSC-7
      // wiring — already covered by test/services/pty-manager.test.ts's own
      // liveCwd tests — and a real spawn depends on a live systemd --user
      // session, which isn't guaranteed in every test environment).
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-livecwd-project-"));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const worktreeParent = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-livecwd-wt-"));
      const worktreeDir = path.join(worktreeParent, "wt");
      execFileSync("git", ["worktree", "add", "-b", "feature/live", worktreeDir], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "batch-session-livecwd-project", cwd: projectCwd },
      });
      const projectId = created.json().id as number;

      // No `cwd` in the body — session.cwd stays null, spawned at projectCwd.
      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = sessionRes.json().id as number;

      const getSpy = vi
        .spyOn(app.pty, "get")
        .mockReturnValue({ liveCwd: worktreeDir } as ReturnType<typeof app.pty.get>);

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().sessions[String(sessionId)]).toMatchObject({ branch: "feature/live" });

      getSpy.mockRestore();
      execFileSync("git", ["worktree", "remove", "--force", worktreeDir], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.rmSync(worktreeParent, { recursive: true, force: true });
      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("falls back to the static launch cwd when the live cwd isn't a real git repo", async () => {
      // Guards resolveSessionCwdTargets's isGitRepo gate: a `liveCwd` is
      // parsed straight off the PTY byte stream (stale, mid-typo, or a
      // shell-integration bug), so a bogus value must not be trusted as a
      // `git -C` target — it should silently fall back to the session's
      // static cwd instead, same "nothing to show" posture as this
      // endpoint's other gaps, not a crash or a wrong branch.
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-badlive-project-"));
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "batch-session-badlive-project", cwd: projectCwd },
      });
      const projectId = created.json().id as number;
      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = sessionRes.json().id as number;

      const getSpy = vi
        .spyOn(app.pty, "get")
        .mockReturnValue({ liveCwd: "/definitely/not/a/real/repo" } as ReturnType<
          typeof app.pty.get
        >);

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().sessions[String(sessionId)]).toMatchObject({ branch: "main" });

      getSpy.mockRestore();
      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns null in the sessions map for a session whose cwd isn't a git repo", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-nonrepo-project-"));
      const sessionCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-nonrepo-cwd-"));

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "batch-session-nonrepo", cwd: projectCwd },
      });
      const projectId = created.json().id as number;
      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", cwd: sessionCwd },
      });
      const sessionId = sessionRes.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().sessions[String(sessionId)]).toBeNull();

      fs.rmSync(projectCwd, { recursive: true, force: true });
      fs.rmSync(sessionCwd, { recursive: true, force: true });
      await app.close();
    });

    it("omits a session with no matching row (already deleted) from the sessions map", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/projects/git-statuses?sessionIds=999999",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ projects: {}, sessions: {} });
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
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

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

    // Distinguishes "not a repo" (204, durable) from "is a repo but git
    // status itself failed" (503, transient) — the fix for the sidebar/
    // GitPanel flicker: a client that treats 503 as "keep my last-known-good"
    // and only clears to empty on 204 stops flickering on a single failed
    // poll tick.
    it("503s (not 204) for a local project that IS a repo but git status fails transiently", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-status-transient-"));
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      // Break HEAD so `git status` fails while `.git` still exists — the
      // same technique as git-status.test.ts's own transient-failure test.
      fs.unlinkSync(path.join(projectCwd, ".git", "HEAD"));

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "transiently-broken-repo", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/git-status`,
      });
      expect(res.statusCode).toBe(503);

      fs.rmSync(projectCwd, { recursive: true, force: true });
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
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["branch", "feature/foo"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

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

  describe("GET /api/projects/git-diff-stats (batch, issue #202)", () => {
    it("returns an empty object when no sessionIds are given", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/git-diff-stats" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({});
      await app.close();
    });

    it("returns diff stats for a session's cwd with a modified tracked file", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "diff-stats-project-"));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "one\ntwo\nthree\n");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "one\nTWO\nthree\nfour\n");

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "diff-stats-project", cwd: projectCwd },
      });
      const projectId = created.json().id as number;
      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = sessionRes.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body[String(sessionId)]).toEqual({
        filesChanged: 1,
        insertions: 2,
        deletions: 1,
      });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns null for a session whose cwd isn't a git repo", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "diff-stats-nonrepo-"));
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "diff-stats-nonrepo", cwd: projectCwd },
      });
      const projectId = created.json().id as number;
      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = sessionRes.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()[String(sessionId)]).toBeNull();

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns zero-change stats for a clean repo with no diff against HEAD", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "diff-stats-clean-"));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "diff-stats-clean", cwd: projectCwd },
      });
      const projectId = created.json().id as number;
      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = sessionRes.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()[String(sessionId)]).toEqual({
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
      });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("omits a session on an unreachable remote host from the response", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "diff-stats-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "diff-stats-remote-project", cwd: "/x", hostId: host.json().id },
      });
      const projectId = project.json().id as number;

      // Seeded straight into the DB, not via POST /api/sessions — a real
      // spawn attempt against this unreachable host would 502 and roll the
      // row back before this test ever gets to exercise the batch endpoint
      // (see the "detectedDevServerPort" describe block's identical
      // seed-straight-into-the-DB pattern for a remote project).
      const { sessions } = await import("../../src/db/schema.js");
      const [created] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash" })
        .returning()
        .all();

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${created.id}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({});

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
