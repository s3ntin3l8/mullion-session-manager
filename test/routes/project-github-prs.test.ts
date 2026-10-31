// The batched PR-list route.
//
// Moved out of test/routes/projects.test.ts (issue #2399, audit finding F2),
// alongside the routes themselves: src/routes/project-github.ts. The GitHub
// route block left projects.ts, and the test tree mirrors the source tree.
//
// GET /api/projects/:id/github/prs answers the sidebar's PR list from the
// poller's warm cache, with an optional ?branch= filter.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// Must come before any import below that could itself trigger loading
// "node-pty" — see mock-pty.ts's header comment for the empirically
// confirmed hoisting/ordering failure mode.
import { plainNodePtyMock } from "../helpers/mock-pty.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { PR_REVIEW_DEFAULTS } from "../helpers/pr-review-defaults.js";
import { buildTestApp } from "../helpers/app.js";

const { buildApp } = await import("../../src/app.js");

vi.mock("node-pty", () => plainNodePtyMock());

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// The remote-host test below builds a second, real app in `agent` role
// alongside this file's own primary one — both would otherwise default to the
// SAME SESSIONS_DIR (test/setup.ts sets it once per file), so their
// hooksPlugin listeners would collide on the same hooks.sock path. Gives each
// instance its own scratch directory instead.
function uniqueSessionsDir(): string {
  return path.join(
    os.tmpdir(),
    `projects-agent-sessions-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
}

// Captured before any test stubs globalThis.fetch — lets the remote-host
// success test (issue #222) delegate real loopback calls to its own
// in-process agent server through the same fetchMock that mocks
// api.github.com, instead of needing genuine internet access.
const realFetch = globalThis.fetch;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  // github-integration's `integrations` row is a singleton shared across this
  // file's DB — reset it before every test so a connected token doesn't leak
  // into an unrelated "no token" case (same reasoning as
  // github-integration.test.ts).
  //
  // The reset runs in beforeEach, not afterEach: buildTestApp() closes its
  // app from an onTestFinished callback, which Vitest runs AFTER afterEach —
  // so in an afterEach this reset app would be built while the test's own app
  // is still open, and the two would collide on the shared hooks.sock.
  const resetApp = await buildApp();
  const { disconnect } = await import("../../src/services/github-integration.js");
  disconnect(resetApp);
  await resetApp.close();

  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("projects route", () => {
  describe("GET /api/projects/:id/github/prs (issue #102)", () => {
    it("404s for an unknown project", async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/999999/github/prs" });
      expect(res.statusCode).toBe(404);
    });

    it("204s for a local project with no github.com remote", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-prs-no-remote-"));
      const app = await buildTestApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "no-remote", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/github/prs`,
      });
      expect(res.statusCode).toBe(204);

      fs.rmSync(projectCwd, { recursive: true, force: true });
    });

    it("204s for a project with a github remote but empty cache (poller hasn't run yet)", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-prs-no-cache-"));
      fs.mkdirSync(path.join(projectCwd, ".git"));
      fs.writeFileSync(
        path.join(projectCwd, ".git", "config"),
        '[remote "origin"]\n\turl = git@github.com:o/r.git\n',
      );
      const app = await buildTestApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "no-cache", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/github/prs`,
      });
      expect(res.statusCode).toBe(204);

      fs.rmSync(projectCwd, { recursive: true, force: true });
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

      const app = await buildTestApp();
      await app.inject({
        method: "PUT",
        url: "/api/integrations/github/token",
        payload: { token: "ghp_prs_token" },
      });

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "empty-prs", cwd: projectCwd },
      });

      // Prime the cache as the poller would.
      const { setRepoPRsStatus } = await import("../../src/services/github.js");
      setRepoPRsStatus("empty", "prs", {
        prs: [],
        prSummary: { total: 0, pass: 0, fail: 0, pending: 0, unknown: 0 },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/github/prs`,
      });
      expect(res.statusCode).toBe(204);

      fs.rmSync(projectCwd, { recursive: true, force: true });
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

      const app = await buildTestApp();
      await app.inject({
        method: "PUT",
        url: "/api/integrations/github/token",
        payload: { token: "ghp_prs_token" },
      });

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "cached-prs", cwd: projectCwd },
      });

      const { setRepoPRsStatus } = await import("../../src/services/github.js");
      setRepoPRsStatus("cached", "pr-repo", {
        prs: [
          {
            number: 7,
            title: "Add CI badge",
            htmlUrl: "https://github.com/cached/pr-repo/pull/7",
            author: "dev",
            ...PR_REVIEW_DEFAULTS,
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
                ...PR_REVIEW_DEFAULTS,
                headSha: "abc",
              },
            ],
          },
        ],
        prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
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
      expect(body.prSummary).toEqual({ total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 });

      fs.rmSync(projectCwd, { recursive: true, force: true });
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

      const app = await buildTestApp();
      await app.inject({
        method: "PUT",
        url: "/api/integrations/github/token",
        payload: { token: "ghp_prs_token" },
      });

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "branch-filter-prs",
          cwd: projectCwd,
        },
      });

      const { setRepoPRsStatus } = await import("../../src/services/github.js");
      const prA = {
        number: 1,
        title: "PR A",
        htmlUrl: "https://github.com/branch/filter/pull/1",
        author: "dev",
        ...PR_REVIEW_DEFAULTS,
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
        ...PR_REVIEW_DEFAULTS,
        headSha: "b1",
        headBranch: "feature/b",
        baseBranch: "main",
        ciStatus: "failure" as const,
        actionsRuns: [],
      };
      setRepoPRsStatus("branch", "filter", {
        prs: [prA, prB],
        prSummary: { total: 2, pass: 1, fail: 1, pending: 0, unknown: 0 },
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
      expect(filteredBody.prSummary).toEqual({
        total: 1,
        pass: 1,
        fail: 0,
        pending: 0,
        unknown: 0,
      });

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
    });

    it("503s for a project on an unreachable remote host (issue #222)", async () => {
      // Same pattern as the /github route's own unreachable-host test above:
      // a real (failing) connection attempt to 127.0.0.1:1, not the
      // api.github.com fetch mock this describe's beforeEach installs.
      vi.unstubAllGlobals();

      const app = await buildTestApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "prs-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, name: "remote-prs", cwd: "/x", hostId: host.json().id },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${project.json().id}/github/prs`,
      });
      expect(res.statusCode).toBe(503);
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
        SESSIONS_DIR: uniqueSessionsDir(),
      };
      for (const key of Object.keys(agentEnv)) {
        prevEnv[key] = process.env[key];
        process.env[key] = agentEnv[key as keyof typeof agentEnv];
      }
      const agentApp = await buildTestApp();
      for (const key of Object.keys(agentEnv)) {
        if (prevEnv[key] === undefined) delete process.env[key];
        else process.env[key] = prevEnv[key];
      }
      await agentApp.listen({ port: 0, host: "127.0.0.1" });
      const address = agentApp.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a real bound address");
      }

      const primary = await buildTestApp();
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
        payload: {
          allowDuplicate: true,
          name: "remote-prs-success",
          cwd: remoteCwd,
          hostId: host.json().id,
        },
      });

      const { setRepoPRsStatus } = await import("../../src/services/github.js");
      setRepoPRsStatus("remote", "pr-repo", {
        prs: [
          {
            number: 3,
            title: "Remote PR",
            htmlUrl: "https://github.com/remote/pr-repo/pull/3",
            author: "dev",
            ...PR_REVIEW_DEFAULTS,
            headSha: "def",
            headBranch: "remote-branch",
            baseBranch: "main",
            ciStatus: "success",
            actionsRuns: [],
          },
        ],
        prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
      });

      const res = await primary.inject({
        method: "GET",
        url: `/api/projects/${project.json().id}/github/prs`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.prs).toHaveLength(1);
      expect(body.prs[0].number).toBe(3);
      expect(body.prSummary).toEqual({ total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 });

      fs.rmSync(remoteCwd, { recursive: true, force: true });
    });
  });
});
