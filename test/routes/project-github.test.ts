// The per-project GitHub status and issue routes, and the CI jobs route.
//
// Moved out of test/routes/projects.test.ts (issue #2399, audit finding F2),
// alongside the routes themselves: src/routes/project-github.ts. The GitHub
// route block left projects.ts, and the test tree mirrors the source tree.
//
// GET /api/projects/:id/github and /api/projects/:id/github/issues* answer the
// project's widget; GET /api/projects/:id/github/actions/:runId/jobs feeds the
// PR panel's CI section.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// Must come before any import below that could itself trigger loading
// "node-pty" — see mock-pty.ts's header comment for the empirically
// confirmed hoisting/ordering failure mode.
import { plainNodePtyMock } from "../helpers/mock-pty.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as GithubIntegration from "../../src/services/github-integration.js";
import type * as HermesReview from "../../src/services/hermes-review.js";
import { resolveGitHubToken } from "../../src/services/github-integration.js";
import { getRunForTarget } from "../../src/services/hermes-review.js";
import { buildTestApp } from "../helpers/app.js";

const { buildApp } = await import("../../src/app.js");

vi.mock("node-pty", () => plainNodePtyMock());

vi.mock("../../src/services/github-integration.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GithubIntegration>();
  return { ...actual, resolveGitHubToken: vi.fn(actual.resolveGitHubToken) };
});

// The issue list/detail ask the same index for a triage run (epic #1965 A6),
// so a test can hand back a result without a real Hermes.
vi.mock("../../src/services/hermes-review.js", async (importOriginal) => {
  const actual = await importOriginal<typeof HermesReview>();
  return {
    ...actual,
    getRunForTarget: vi.fn(actual.getRunForTarget),
  };
});

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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
  describe("GET /api/projects/:id/github (issue #27)", () => {
    it("400s for a non-integer project id (loadProjectRepoContext's own validation)", async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/not-a-number/github" });
      expect(res.statusCode).toBe(400);
    });

    it("404s for an unknown project", async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/999999/github" });
      expect(res.statusCode).toBe(404);
    });

    it("204s for a local project with no github.com remote", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-github-none-"));
      const app = await buildTestApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "no-remote", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/github`,
      });
      expect(res.statusCode).toBe(204);

      fs.rmSync(projectCwd, { recursive: true, force: true });
    });

    it("204s for a project with a github remote but no GitHub account connected", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-github-no-token-"));
      fs.mkdirSync(path.join(projectCwd, ".git"));
      fs.writeFileSync(
        path.join(projectCwd, ".git", "config"),
        '[remote "origin"]\n\turl = git@github.com:o/r.git\n',
      );
      const app = await buildTestApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "no-token", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/github`,
      });
      expect(res.statusCode).toBe(204);
      expect(fetchMock).not.toHaveBeenCalled();

      fs.rmSync(projectCwd, { recursive: true, force: true });
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

      const realResolve = vi.mocked(resolveGitHubToken).getMockImplementation()!;
      vi.mocked(resolveGitHubToken).mockImplementation(async (app, ref, scope) =>
        scope === "issues" ? "issues-sentinel" : realResolve(app, ref, scope),
      );

      const app = await buildTestApp();
      await app.inject({
        method: "PUT",
        url: "/api/integrations/github/token",
        payload: { token: "ghp_connected" },
      });

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "connected", cwd: projectCwd },
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
      // #2321 — the issue list is the user's view: it is fetched with the
      // connected account, never an App "issues"-scope token.
      expect(vi.mocked(resolveGitHubToken).mock.calls.map((c) => c[2])).not.toContain("issues");
      const issuesCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/issues?"));
      expect(issuesCall?.[1]?.headers?.Authorization).toBe("Bearer ghp_connected");

      vi.mocked(resolveGitHubToken).mockImplementation(realResolve);
      fs.rmSync(projectCwd, { recursive: true, force: true });
    });

    describe("issues view routes", () => {
      async function connectedProject(app: Awaited<ReturnType<typeof buildApp>>) {
        const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-github-issues-"));
        fs.mkdirSync(path.join(projectCwd, ".git"));
        fs.writeFileSync(
          path.join(projectCwd, ".git", "config"),
          '[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n',
        );
        await app.inject({
          method: "PUT",
          url: "/api/integrations/github/token",
          payload: { token: "ghp_connected" },
        });
        const created = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: { createDir: true, allowDuplicate: true, name: "issues-view", cwd: projectCwd },
        });
        return { projectCwd, id: created.json().id as number };
      }

      const rawIssue = (n: number, extra: Record<string, unknown> = {}) => ({
        number: n,
        title: `issue ${n}`,
        html_url: `https://github.com/acme/widgets/issues/${n}`,
        user: { login: "a" },
        labels: [{ name: "bug", color: "d73a4a" }],
        assignees: [{ login: "me" }],
        comments: 2,
        milestone: { title: "v1" },
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
        ...extra,
      });

      describe("title search across pages", () => {
        const page = (from: number, count: number, title: (n: number) => string) =>
          Array.from({ length: count }, (_, i) => rawIssue(from + i, { title: title(from + i) }));
        const mockPages = (pages: Record<number, unknown[]>) =>
          fetchMock.mockImplementation((input: RequestInfo | URL) => {
            const url = String(input);
            if (url === "https://api.github.com/user") {
              return Promise.resolve(jsonResponse(200, { login: "octocat" }));
            }
            if (url.includes("/repos/acme/widgets/issues?")) {
              const n = Number(new URL(url).searchParams.get("page"));
              return Promise.resolve(jsonResponse(200, pages[n] ?? []));
            }
            return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
          });

        it("finds a match on a later page, skipping PRs, and keeps empty q paged", async () => {
          mockPages({
            1: page(1, 50, (n) => `other ${n}`),
            2: [
              rawIssue(51, { title: "Needle in page two" }),
              rawIssue(52, { title: "needle PR", pull_request: {} }),
              ...page(53, 8, (n) => `other ${n}`),
            ],
          });
          const app = await buildTestApp();
          const { projectCwd, id } = await connectedProject(app);
          const res = await app.inject({
            method: "GET",
            url: `/api/projects/${id}/github/issues?q=NEEDLE`,
          });
          const body = res.json();
          expect(body.issues.map((i: { number: number }) => i.number)).toEqual([51]);
          expect(body.hasMore).toBe(false);
          expect(body.truncated).toBeUndefined();

          fetchMock.mockClear();
          const plain = await app.inject({
            method: "GET",
            url: `/api/projects/${id}/github/issues`,
          });
          expect(plain.json().issues).toHaveLength(50);
          expect(plain.json().hasMore).toBe(true);
          expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/issues?"))).toHaveLength(
            1,
          );
          fs.rmSync(projectCwd, { recursive: true, force: true });
        });

        it("pages the filtered set and flags truncation at the scan cap", async () => {
          const all: Record<number, unknown[]> = {};
          for (let p = 1; p <= 20; p++) all[p] = page((p - 1) * 50 + 1, 50, (n) => `hit ${n}`);
          mockPages(all);
          const app = await buildTestApp();
          const { projectCwd, id } = await connectedProject(app);
          const p1 = (
            await app.inject({ method: "GET", url: `/api/projects/${id}/github/issues?q=hit` })
          ).json();
          expect(p1.issues).toHaveLength(50);
          expect(p1.hasMore).toBe(true);
          const p2 = (
            await app.inject({
              method: "GET",
              url: `/api/projects/${id}/github/issues?q=hit&page=2`,
            })
          ).json();
          expect(p2.issues[0].number).toBe(51);
          expect(p2.page).toBe(2);

          // Nothing matches and 20 full pages were read: the scan stopped early.
          const none = (
            await app.inject({ method: "GET", url: `/api/projects/${id}/github/issues?q=zzz` })
          ).json();
          expect(none.issues).toEqual([]);
          expect(none.hasMore).toBe(false);
          expect(none.truncated).toBe(true);
          fs.rmSync(projectCwd, { recursive: true, force: true });
        });
      });

      it("lists filtered issues (PRs dropped) with labels and forwards the filters", async () => {
        fetchMock.mockImplementation((input: RequestInfo | URL) => {
          const url = String(input);
          if (url === "https://api.github.com/user") {
            return Promise.resolve(jsonResponse(200, { login: "octocat" }));
          }
          if (url.includes("/repos/acme/widgets/issues?")) {
            return Promise.resolve(
              jsonResponse(200, [rawIssue(1), rawIssue(2, { pull_request: {} })]),
            );
          }
          return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
        });
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);

        const res = await app.inject({
          method: "GET",
          url: `/api/projects/${id}/github/issues?labels=bug&assignee=me&sort=comments&q=issue`,
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.issues).toHaveLength(1);
        expect(body.issues[0]).toMatchObject({
          number: 1,
          labels: [{ name: "bug", color: "d73a4a" }],
          assignees: ["me"],
          commentCount: 2,
          milestone: "v1",
          taskStatus: null,
        });
        expect(body.labels).toEqual([{ name: "bug", color: "d73a4a" }]);
        const url = String(
          fetchMock.mock.calls.map(([u]) => String(u)).find((u) => u.includes("/issues?")),
        );
        expect(url).toContain("labels=bug");
        expect(url).toContain("assignee=me");
        expect(url).toContain("sort=comments");
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("finds an issue by number (123 or #123) beyond the current page", async () => {
        fetchMock.mockImplementation((input: RequestInfo | URL) => {
          const url = String(input);
          if (url === "https://api.github.com/user") {
            return Promise.resolve(jsonResponse(200, { login: "octocat" }));
          }
          if (url.endsWith("/repos/acme/widgets/issues/123")) {
            return Promise.resolve(jsonResponse(200, rawIssue(123, { state: "open" })));
          }
          if (url.includes("/repos/acme/widgets/issues?")) {
            return Promise.resolve(jsonResponse(200, [rawIssue(1)]));
          }
          return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
        });
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        for (const q of ["123", "%23123"]) {
          const res = await app.inject({
            method: "GET",
            url: `/api/projects/${id}/github/issues?q=${q}`,
          });
          expect(res.statusCode).toBe(200);
          expect(res.json().issues.map((i: { number: number }) => i.number)).toEqual([123]);
        }
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("does not return a PR, a closed issue or a missing number for a numeric search", async () => {
        const detail: Record<string, unknown> = {
          "5": rawIssue(5, { pull_request: {} }),
          "6": rawIssue(6, { state: "closed" }),
        };
        fetchMock.mockImplementation((input: RequestInfo | URL) => {
          const url = String(input);
          if (url === "https://api.github.com/user") {
            return Promise.resolve(jsonResponse(200, { login: "octocat" }));
          }
          const m = /\/repos\/acme\/widgets\/issues\/(\d+)$/.exec(url);
          if (m) {
            return Promise.resolve(
              m[1] in detail ? jsonResponse(200, detail[m[1]]) : jsonResponse(404, {}),
            );
          }
          if (url.includes("/repos/acme/widgets/issues?")) {
            return Promise.resolve(jsonResponse(200, [rawIssue(1)]));
          }
          return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
        });
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        for (const n of [5, 6, 999]) {
          const res = await app.inject({
            method: "GET",
            url: `/api/projects/${id}/github/issues?q=${n}`,
          });
          expect(res.statusCode).toBe(200);
          expect(res.json().issues).toEqual([]);
        }
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("carries the triage run Mullion dispatched for an issue (A6)", async () => {
        const triageRun = {
          runId: "run_triage_1",
          kind: "issue" as const,
          owner: "acme",
          repo: "widgets",
          prNumber: 1,
          headSha: "",
          dispatchedAt: Date.now(),
        };
        vi.mocked(getRunForTarget).mockImplementation((kind, _o, _r, n) =>
          kind === "issue" && n === 1 ? triageRun : null,
        );
        fetchMock.mockImplementation((input: RequestInfo | URL) => {
          const url = String(input);
          if (url === "https://api.github.com/user") {
            return Promise.resolve(jsonResponse(200, { login: "octocat" }));
          }
          if (url.includes("/repos/acme/widgets/issues?")) {
            return Promise.resolve(jsonResponse(200, [rawIssue(1), rawIssue(3)]));
          }
          if (url.endsWith("/issues/1/comments?per_page=100")) {
            return Promise.resolve(jsonResponse(200, []));
          }
          if (url.endsWith("/issues/1")) return Promise.resolve(jsonResponse(200, rawIssue(1)));
          return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
        });
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        try {
          const list = await app.inject({
            method: "GET",
            url: `/api/projects/${id}/github/issues`,
          });
          const byNumber = new Map(
            (list.json().issues as Array<{ number: number; triage: unknown }>).map((i) => [
              i.number,
              i.triage,
            ]),
          );
          expect(byNumber.get(1)).toEqual({
            state: "requested",
            runId: "run_triage_1",
            dispatchedAt: new Date(triageRun.dispatchedAt).toISOString(),
          });
          expect(byNumber.get(3)).toBeNull();

          const detail = await app.inject({
            method: "GET",
            url: `/api/projects/${id}/github/issues/1`,
          });
          expect(detail.json().triage).toMatchObject({ state: "requested", runId: "run_triage_1" });
        } finally {
          vi.mocked(getRunForTarget).mockReset();
          fs.rmSync(projectCwd, { recursive: true, force: true });
        }
      });

      it("rejects a bad sort or page", async () => {
        fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const badSort = await app.inject({
          method: "GET",
          url: `/api/projects/${id}/github/issues?sort=nope`,
        });
        expect(badSort.statusCode).toBe(400);
        const badPage = await app.inject({
          method: "GET",
          url: `/api/projects/${id}/github/issues?page=0`,
        });
        expect(badPage.statusCode).toBe(400);
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("502s when GitHub rejects the issue list", async () => {
        fetchMock.mockImplementation((input: RequestInfo | URL) => {
          const url = String(input);
          if (url === "https://api.github.com/user") {
            return Promise.resolve(jsonResponse(200, { login: "octocat" }));
          }
          return Promise.resolve(jsonResponse(500, { message: "boom" }));
        });
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const res = await app.inject({ method: "GET", url: `/api/projects/${id}/github/issues` });
        expect(res.statusCode).toBe(502);
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("returns an issue's rendered body and comments; 404s for a PR", async () => {
        fetchMock.mockImplementation((input: RequestInfo | URL) => {
          const url = String(input);
          if (url === "https://api.github.com/user") {
            return Promise.resolve(jsonResponse(200, { login: "octocat" }));
          }
          if (url.endsWith("/issues/5/comments?per_page=100")) {
            return Promise.resolve(
              jsonResponse(200, [
                {
                  id: 9,
                  user: { login: "bob" },
                  body_html: "<p>hi</p>",
                  created_at: "2026-01-03T00:00:00Z",
                  html_url: "https://github.com/acme/widgets/issues/5#issuecomment-9",
                },
              ]),
            );
          }
          if (url.endsWith("/issues/5")) {
            return Promise.resolve(
              jsonResponse(200, rawIssue(5, { body_html: "<p>body</p>", state: "closed" })),
            );
          }
          if (url.endsWith("/issues/6/comments?per_page=100")) {
            return Promise.resolve(jsonResponse(200, []));
          }
          if (url.endsWith("/issues/6")) {
            return Promise.resolve(jsonResponse(200, rawIssue(6, { pull_request: {} })));
          }
          return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
        });
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);

        const ok = await app.inject({ method: "GET", url: `/api/projects/${id}/github/issues/5` });
        expect(ok.statusCode).toBe(200);
        expect(ok.json()).toMatchObject({
          number: 5,
          state: "closed",
          bodyHtml: "<p>body</p>",
          comments: [{ id: 9, author: "bob", bodyHtml: "<p>hi</p>" }],
          taskStatus: null,
          // #2049 — who a comment from the box posts as (the connected account).
          writeIdentity: { kind: "user" },
        });
        // A task tracking the issue seeds the detail's Queued state.
        const { tasks } = await import("../../src/db/schema.js");
        app.db
          .insert(tasks)
          .values({ projectId: id, title: "t", issueNumber: 5, status: "in_progress" })
          .run();
        const queued = await app.inject({
          method: "GET",
          url: `/api/projects/${id}/github/issues/5`,
        });
        expect(queued.json()).toMatchObject({ number: 5, taskStatus: "in_progress" });
        const pr = await app.inject({ method: "GET", url: `/api/projects/${id}/github/issues/6` });
        expect(pr.statusCode).toBe(404);
        const bad = await app.inject({ method: "GET", url: `/api/projects/${id}/github/issues/x` });
        expect(bad.statusCode).toBe(400);
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("queue: says so when no write-scoped token is available", async () => {
        fetchMock.mockImplementation((input: RequestInfo | URL) =>
          Promise.resolve(
            String(input) === "https://api.github.com/user"
              ? jsonResponse(200, { login: "octocat" })
              : jsonResponse(200, []),
          ),
        );
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        app.config.MULLION_TASK_MASTER_ENABLED = true;
        // Disconnect the PAT so no token resolves at all.
        await app.inject({ method: "DELETE", url: "/api/integrations/github" });
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${id}/github/issues/7/queue`,
        });
        expect(res.statusCode).toBe(502);
        expect(res.json().message).toMatch(/not connected/);
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("queue: refuses when Task Master is off, labels the issue when it is on", async () => {
        fetchMock.mockImplementation((input: RequestInfo | URL) => {
          const url = String(input);
          if (url === "https://api.github.com/user") {
            return Promise.resolve(jsonResponse(200, { login: "octocat" }));
          }
          if (url.endsWith("/issues/7/labels")) return Promise.resolve(jsonResponse(200, []));
          return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
        });
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);

        const off = await app.inject({
          method: "POST",
          url: `/api/projects/${id}/github/issues/7/queue`,
        });
        expect(off.statusCode).toBe(403);

        app.config.MULLION_TASK_MASTER_ENABLED = true;
        const on = await app.inject({
          method: "POST",
          url: `/api/projects/${id}/github/issues/7/queue`,
        });
        expect(on.statusCode).toBe(200);
        expect(on.json()).toEqual({ queued: true, label: app.config.MULLION_TASK_LABEL });
        const labelCall = fetchMock.mock.calls.find(([u]) =>
          String(u).endsWith("/issues/7/labels"),
        );
        expect(JSON.parse(labelCall![1].body as string)).toEqual({
          labels: [app.config.MULLION_TASK_LABEL],
        });
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });
    });

    it("503s for a project on an unreachable remote host", async () => {
      // Unlike every other test in this block, this needs a real (failing)
      // network connection to 127.0.0.1:1, not the api.github.com fetch
      // mock this describe's beforeEach installs — same pattern the
      // existing "503s actions/dock" test below relies on.
      vi.unstubAllGlobals();

      const app = await buildTestApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "github-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, name: "remote-github", cwd: "/x", hostId: host.json().id },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${project.json().id}/github`,
      });
      expect(res.statusCode).toBe(503);
    });
  });

  describe("GET /api/projects/:id/github/actions/:runId/jobs (issue #221)", () => {
    it("returns jobs as a bare array for a connected project with a matching run", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-jobs-connected-"));
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
        if (url.startsWith("https://api.github.com/repos/acme/widgets/actions/runs/42/jobs")) {
          return Promise.resolve(
            jsonResponse(200, {
              total_count: 2,
              jobs: [
                {
                  id: 101,
                  name: "lint",
                  status: "completed",
                  conclusion: "success",
                  started_at: "2025-01-01T00:00:00Z",
                  completed_at: "2025-01-01T00:01:00Z",
                  html_url: "https://github.com/acme/widgets/actions/runs/42/jobs/101",
                  steps: [
                    { name: "prettier", status: "completed", conclusion: "success", number: 1 },
                  ],
                },
                {
                  id: 102,
                  name: "test",
                  status: "completed",
                  conclusion: "failure",
                  started_at: "2025-01-01T00:00:00Z",
                  completed_at: "2025-01-01T00:02:00Z",
                  html_url: "https://github.com/acme/widgets/actions/runs/42/jobs/102",
                  steps: [
                    { name: "vitest", status: "completed", conclusion: "failure", number: 1 },
                  ],
                },
              ],
            }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
      });

      const app = await buildApp();
      await app.inject({
        method: "PUT",
        url: "/api/integrations/github/token",
        payload: { token: "ghp_jobs_test" },
      });
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "jobs-connected", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/github/actions/42/jobs`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);
      expect(body[0].name).toBe("lint");
      expect(body[0].status).toBe("completed");
      expect(body[0].conclusion).toBe("success");
      expect(body[1].name).toBe("test");
      expect(body[1].status).toBe("completed");
      expect(body[1].conclusion).toBe("failure");

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });
  });
});
