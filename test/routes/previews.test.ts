import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { eq } from "drizzle-orm";
import { previews, projects, sessions } from "../../src/db/schema.js";
import * as sessionBackendModule from "../../src/services/session-backend.js";
import * as hostGitModule from "../../src/services/host-git.js";
import {
  bindBranchPreview,
  getOrCreateProjectPreview,
  upsertBranchPreview,
} from "../../src/services/preview-registry.js";
import * as branchPreviewModule from "../../src/services/branch-preview.js";
import { trackPreviewWorktree, deletePreviewWorktree } from "../../src/services/git-worktree.js";
import { verifyPreviewToken } from "../../src/services/preview-auth.js";

const tmpDb = path.join(os.tmpdir(), `previews-test-${process.pid}.db`);

async function createProject(app: Awaited<ReturnType<typeof buildApp>>) {
  const res = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {
      allowDuplicate: true,
      createDir: true,
      name: "with-dev-server",
      cwd: "/tmp/previews-test",
    },
  });
  return res.json().id as number;
}

describe("previews route (issue #28)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.PREVIEW_BASE_HOST = "preview.example.com";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.PREVIEW_BASE_HOST;
  });

  it("creates a project preview with a slug", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ kind: "project", projectId, externalUrl: null });
    expect(typeof body.slug).toBe("string");
    expect(body.slug.length).toBeGreaterThan(0);

    await app.close();
  });

  it("upserts by projectId — reopening the same project's preview reuses its slug", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const first = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().slug).toBe(first.json().slug);

    await app.close();
  });

  describe("branch previews (#2016)", () => {
    afterEach(() => vi.restoreAllMocks());

    it("starts a branch preview when `branch` is given, and maps refusals to their code", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const summary = {
        slug: "b1",
        kind: "project" as const,
        projectId,
        externalUrl: null,
        sessionId: 3,
        upstreamPort: 4000,
        createdAt: new Date(0),
        branch: "feat/x",
      };
      const start = vi
        .spyOn(branchPreviewModule, "getOrCreateBranchPreview")
        .mockResolvedValue(summary);
      const res = await app.inject({
        method: "POST",
        url: "/api/previews",
        payload: { kind: "project", projectId, branch: "feat/x" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ slug: "b1", branch: "feat/x", upstreamPort: 4000 });
      expect(start.mock.calls[0].slice(1)).toEqual([projectId, "feat/x"]);

      start.mockRejectedValueOnce(
        new branchPreviewModule.BranchPreviewError("remote_unsupported", "not yet"),
      );
      const refused = await app.inject({
        method: "POST",
        url: "/api/previews",
        payload: { kind: "project", projectId, branch: "feat/x" },
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: "remote_unsupported", message: "not yet" });

      start.mockRejectedValueOnce(new Error("boom"));
      const crashed = await app.inject({
        method: "POST",
        url: "/api/previews",
        payload: { kind: "project", projectId, branch: "feat/x" },
      });
      expect(crashed.statusCode).toBe(500);

      const empty = await app.inject({
        method: "POST",
        url: "/api/previews",
        payload: { kind: "project", projectId, branch: "" },
      });
      expect(empty.statusCode).toBe(400);
      await app.close();
    });

    it("reports a branch preview's own branch, never the checkout's", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const [session] = app.db
        .insert(sessions)
        .values({ projectId, command: "vite", kind: "dock" })
        .returning()
        .all();
      const row = upsertBranchPreview(app, projectId, "feat/x");
      bindBranchPreview(app, row.slug, { sessionId: session.id, upstreamPort: 4100 });
      const live = vi.spyOn(sessionBackendModule, "resolveBackend");

      const res = await app.inject({ method: "GET", url: `/api/previews/${row.slug}` });
      expect(res.json()).toMatchObject({ branch: "feat/x", upstreamPort: 4100 });
      // Nothing to derive: no live-status round trip for a branch preview.
      expect(live).not.toHaveBeenCalled();
      expect(() => upsertBranchPreview(app, projectId, "")).toThrow();
      await app.close();
    });
  });

  it("rate-limits creating previews like the PR preview route (30/min)", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);
    vi.spyOn(branchPreviewModule, "getOrCreateBranchPreview").mockResolvedValue({
      slug: "b1",
      kind: "project",
      projectId,
      externalUrl: null,
      sessionId: 3,
      upstreamPort: 4000,
      createdAt: new Date(0),
      branch: "feat/x",
    } as never);
    const post = () =>
      app.inject({
        method: "POST",
        url: "/api/previews",
        payload: { kind: "project", projectId, branch: "feat/x" },
      });
    for (let i = 0; i < 30; i++) expect((await post()).statusCode).toBe(201);
    expect((await post()).statusCode).toBe(429);
    vi.restoreAllMocks();
    await app.close();
  });

  it("404s creating a preview for an unknown projectId", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId: 999999 },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("rejects a project preview missing projectId", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("creates, resolves, and deletes an external preview", async () => {
    const app = await buildApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "external", url: "https://example.com/path" },
    });
    expect(created.statusCode).toBe(201);
    const { slug } = created.json();
    expect(created.json()).toMatchObject({
      kind: "external",
      externalUrl: "https://example.com/path",
      projectId: null,
    });

    const resolved = await app.inject({ method: "GET", url: `/api/previews/${slug}` });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ slug, kind: "external" });

    const deleted = await app.inject({ method: "DELETE", url: `/api/previews/${slug}` });
    expect(deleted.statusCode).toBe(204);

    const afterDelete = await app.inject({ method: "GET", url: `/api/previews/${slug}` });
    expect(afterDelete.statusCode).toBe(404);

    await app.close();
  });

  it("rejects a malformed external url", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "external", url: "not-a-url" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a non-http(s) external url", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "external", url: "ftp://example.com" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("404s resolving an unknown slug", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/previews/does-not-exist" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("404s deleting an unknown slug", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/previews/does-not-exist" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("lists all previews and leaves get/delete working (create -> list -> get/delete round trip)", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const projectPreview = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId },
    });
    const externalPreview = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "external", url: "https://example.com/list-test" },
    });

    const listed = await app.inject({ method: "GET", url: "/api/previews" });
    expect(listed.statusCode).toBe(200);
    const rows = listed.json();
    expect(Array.isArray(rows)).toBe(true);

    const slugs = rows.map((r: { slug: string }) => r.slug);
    expect(slugs).toContain(projectPreview.json().slug);
    expect(slugs).toContain(externalPreview.json().slug);

    // get/delete are unaffected by the new list route.
    const slug = externalPreview.json().slug;
    const resolved = await app.inject({ method: "GET", url: `/api/previews/${slug}` });
    expect(resolved.statusCode).toBe(200);
    const deleted = await app.inject({ method: "DELETE", url: `/api/previews/${slug}` });
    expect(deleted.statusCode).toBe(204);

    const afterDelete = await app.inject({ method: "GET", url: "/api/previews" });
    expect(afterDelete.json().map((r: { slug: string }) => r.slug)).not.toContain(slug);

    await app.close();
  });

  describe("POST /api/previews/:slug/token (issue #383)", () => {
    it("mints a bootstrap token for a known slug", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/previews",
        payload: { kind: "project", projectId },
      });
      const { slug } = created.json();

      const res = await app.inject({ method: "POST", url: `/api/previews/${slug}/token` });
      expect(res.statusCode).toBe(200);
      expect(typeof res.json().token).toBe("string");
      expect(res.json().token.length).toBeGreaterThan(0);

      await app.close();
    });

    it("404s for an unknown slug", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/previews/does-not-exist/token",
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });

  describe("GET /api/previews/:slug/open (issue #1316)", () => {
    it("redirects to the preview root with no token when PREVIEW_AUTH_REQUIRED is off", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/previews",
        payload: { kind: "project", projectId },
      });
      const { slug } = created.json();

      const res = await app.inject({ method: "GET", url: `/api/previews/${slug}/open` });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`http://preview-${slug}.preview.example.com/`);
      await app.close();
    });

    it("404s for an unknown slug", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/previews/does-not-exist/open" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });

  it("orders results newest first (desc by createdAt)", async () => {
    const app = await buildApp();

    // Insert directly with explicit, well-separated createdAt values so the
    // ordering assertion doesn't depend on two real-time inserts landing in
    // different seconds (the column has second-level precision).
    app.db
      .insert(previews)
      .values({
        slug: "older-preview",
        kind: "external",
        externalUrl: "https://example.com/older",
        createdAt: new Date("2020-01-01T00:00:00Z"),
      })
      .run();
    app.db
      .insert(previews)
      .values({
        slug: "newer-preview",
        kind: "external",
        externalUrl: "https://example.com/newer",
        createdAt: new Date("2021-01-01T00:00:00Z"),
      })
      .run();

    const listed = await app.inject({ method: "GET", url: "/api/previews" });
    expect(listed.statusCode).toBe(200);
    const slugs = listed.json().map((r: { slug: string }) => r.slug);
    expect(slugs.indexOf("newer-preview")).toBeLessThan(slugs.indexOf("older-preview"));

    await app.close();
  });

  it("carries the project checkout's branch, and null for external or remote (A6)", async () => {
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "previews-branch-"));
    fs.mkdirSync(path.join(cwd, ".git"));
    fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/feat/links\n");
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "branchy", cwd },
    });
    const projectId = created.json().id as number;

    const preview = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId },
    });
    // Create responses skip the branch lookup (the pane only needs the slug).
    expect(preview.json().branch).toBeUndefined();
    const slug = preview.json().slug as string;

    const one = await app.inject({ method: "GET", url: `/api/previews/${slug}` });
    expect(one.json().branch).toBe("feat/links");

    const external = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "external", url: "https://example.com/x" },
    });
    expect(external.json().branch).toBeUndefined();

    const list = await app.inject({ method: "GET", url: "/api/previews" });
    const rows = list.json() as Array<{ slug: string; branch: string | null }>;
    expect(rows.find((r) => r.slug === slug)?.branch).toBe("feat/links");
    expect(rows.find((r) => r.slug === external.json().slug)?.branch).toBeNull();

    // A detached HEAD is not a branch a consumer could link to.
    fs.writeFileSync(path.join(cwd, ".git", "HEAD"), `${"a".repeat(40)}\n`);
    const detached = await app.inject({ method: "GET", url: `/api/previews/${slug}` });
    expect(detached.json().branch).toBeNull();

    // A remote-hosted project's cwd is not readable here.
    fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/feat/links\n");
    app.db.update(projects).set({ hostId: "remote-1" }).where(eq(projects.id, projectId)).run();
    const remote = await app.inject({ method: "GET", url: `/api/previews/${slug}` });
    expect(remote.json().branch).toBeNull();

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  describe("branch follows the session serving the preview (A7, #2007)", () => {
    afterEach(() => vi.restoreAllMocks());

    // Answers for whichever session ids the route asks about.
    function fakeLive(liveBranch: string | null) {
      vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue({
        liveStatus: vi
          .fn()
          .mockImplementation(async (ids: string[]) =>
            Object.fromEntries(ids.map((id) => [id, { liveBranch }])),
          ),
      } as unknown as ReturnType<typeof sessionBackendModule.resolveBackend>);
    }

    async function setup(app: Awaited<ReturnType<typeof buildApp>>) {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "previews-session-"));
      fs.mkdirSync(path.join(cwd, ".git"));
      fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main-checkout\n");
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, createDir: true, name: `sess-${Math.random()}`, cwd },
      });
      const projectId = created.json().id as number;
      const [session] = app.db
        .insert(sessions)
        .values({ projectId, command: "claude" })
        .returning()
        .all();
      return { cwd, projectId, sessionId: session.id };
    }

    it("prefers the bound session's live branch, then its worktree, then the checkout", async () => {
      const app = await buildApp();
      const { cwd, projectId, sessionId } = await setup(app);
      fakeLive("feat/live");

      // Binding happens server-side (dev-server accept), not via the POST body.
      const bound = getOrCreateProjectPreview(app, projectId, sessionId);
      expect(bound.sessionId).toBe(sessionId);
      const slug = bound.slug;
      const viaLive = await app.inject({ method: "GET", url: `/api/previews/${slug}` });
      expect(viaLive.json().branch).toBe("feat/live");

      // No live branch yet: the session's tracked worktree wins over the checkout.
      vi.restoreAllMocks();
      vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue({
        liveStatus: vi.fn().mockResolvedValue({}),
      } as unknown as ReturnType<typeof sessionBackendModule.resolveBackend>);
      trackPreviewWorktree(sessionId, {
        worktreePath: path.join(cwd, "wt"),
        branch: "feat/worktree",
        worktreeRefresh: false,
        parentCwd: cwd,
        projectId,
      });
      const viaWorktree = await app.inject({ method: "GET", url: `/api/previews/${slug}` });
      expect(viaWorktree.json().branch).toBe("feat/worktree");

      deletePreviewWorktree(sessionId);
      const viaCheckout = await app.inject({ method: "GET", url: `/api/previews/${slug}` });
      expect(viaCheckout.json().branch).toBe("main-checkout");

      // A throwing backend (unreachable host) degrades to the checkout.
      vi.restoreAllMocks();
      vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue({
        liveStatus: vi.fn().mockRejectedValue(new Error("down")),
      } as unknown as ReturnType<typeof sessionBackendModule.resolveBackend>);
      const unreachable = await app.inject({ method: "GET", url: `/api/previews/${slug}` });
      expect(unreachable.json().branch).toBe("main-checkout");

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("ignores a session of another project and unbinds when the session is deleted", async () => {
      const app = await buildApp();
      const a = await setup(app);
      const b = await setup(app);
      fakeLive("feat/live");

      const res = getOrCreateProjectPreview(app, a.projectId, b.sessionId);
      expect(res.sessionId).toBeNull();
      const unbound = await app.inject({ method: "GET", url: `/api/previews/${res.slug}` });
      expect(unbound.json().branch).toBe("main-checkout");

      const bound = getOrCreateProjectPreview(app, a.projectId, a.sessionId);
      expect(bound.sessionId).toBe(a.sessionId);
      const list = await app.inject({ method: "GET", url: "/api/previews" });
      expect(
        (list.json() as Array<{ slug: string; branch: string }>).find((r) => r.slug === bound.slug)
          ?.branch,
      ).toBe("feat/live");
      app.db.delete(sessions).where(eq(sessions.id, a.sessionId)).run();
      const after = await app.inject({ method: "GET", url: `/api/previews/${bound.slug}` });
      expect(after.json().sessionId).toBeNull();

      fs.rmSync(a.cwd, { recursive: true, force: true });
      fs.rmSync(b.cwd, { recursive: true, force: true });
      await app.close();
    });

    it("resolves a remote-hosted project's branch through the host client, null on failure", async () => {
      const app = await buildApp();
      const { cwd, projectId } = await setup(app);
      app.db.update(projects).set({ hostId: "remote-1" }).where(eq(projects.id, projectId)).run();
      const slug = getOrCreateProjectPreview(app, projectId).slug;

      const spy = vi
        .spyOn(hostGitModule, "resolveHostGitBranch")
        .mockResolvedValue({ ok: true, value: "feat/remote" });
      const ok = await app.inject({ method: "GET", url: `/api/previews/${slug}` });
      expect(ok.json().branch).toBe("feat/remote");
      expect(spy).toHaveBeenCalledWith(expect.anything(), "remote-1", cwd);

      // A detached HEAD (7-char SHA from the agent) is not a branch.
      spy.mockResolvedValue({ ok: true, value: "abc1234" });
      // The SHA filter lives in resolveHostGitBranch itself, so exercise it too.
      spy.mockRestore();
      vi.spyOn(
        await import("../../src/services/remote-host-client.js"),
        "getRemoteHostClient",
      ).mockReturnValue({ resolveGitBranch: async () => "abc1234" } as never);
      const detachedRemote = await app.inject({ method: "GET", url: `/api/previews/${slug}` });
      expect(detachedRemote.json().branch).toBeNull();
      vi.restoreAllMocks();
      vi.spyOn(hostGitModule, "resolveHostGitBranch").mockResolvedValue({
        ok: false,
        reason: "unreachable",
        detail: "x",
      });
      const down = await app.inject({ method: "GET", url: `/api/previews/${slug}` });
      expect(down.json().branch).toBeNull();

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });
  });
});

describe("GET /api/previews/:slug/open with PREVIEW_AUTH_REQUIRED=true (issue #1316)", () => {
  const localTmpDb = path.join(os.tmpdir(), `previews-open-auth-test-${process.pid}.db`);
  const TEST_AUTH_TOKEN = "test-previews-open-dashboard-token-0123456789";
  const DASHBOARD_AUTH_HEADERS = { authorization: `Bearer ${TEST_AUTH_TOKEN}` };

  beforeAll(() => {
    fs.rmSync(localTmpDb, { force: true });
    process.env.DATABASE_URL = `file:${localTmpDb}`;
    process.env.PREVIEW_BASE_HOST = "preview.example.com";
    process.env.PREVIEW_AUTH_REQUIRED = "true";
    process.env.MULLION_SESSION_SECRET = "test-previews-open-session-secret-0123456789"; // pragma: allowlist secret
    process.env.MULLION_AUTH_TOKEN = TEST_AUTH_TOKEN;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(localTmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.PREVIEW_BASE_HOST;
    delete process.env.PREVIEW_AUTH_REQUIRED;
    delete process.env.MULLION_SESSION_SECRET;
    delete process.env.MULLION_AUTH_TOKEN;
  });

  async function createAuthedProjectPreview(app: Awaited<ReturnType<typeof buildApp>>) {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "open-route-test",
        cwd: "/tmp/previews-open-test",
      },
      headers: DASHBOARD_AUTH_HEADERS,
    });
    const projectId = created.json().id as number;
    const preview = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId },
      headers: DASHBOARD_AUTH_HEADERS,
    });
    return preview.json().slug as string;
  }

  it("401s an unauthenticated request the same as the JSON gate would, when PREVIEW_AUTH_DASHBOARD_URL is unset", async () => {
    // This route is exempted from src/plugins/auth.ts's generic /api/* gate
    // (issue #1316, addressing review feedback that a raw JSON 401 was a
    // dead end for a plain `<a href>` navigation) — but with no dashboard
    // URL configured to redirect to, there's truly nowhere else to send an
    // unauthenticated caller, so the handler itself falls back to the same
    // plain-JSON 401 that gate would have sent.
    const app = await buildApp();
    const slug = await createAuthedProjectPreview(app);

    const res = await app.inject({ method: "GET", url: `/api/previews/${slug}/open` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("redirects an unauthenticated request to PREVIEW_AUTH_DASHBOARD_URL when configured (issue #1316)", async () => {
    process.env.PREVIEW_AUTH_DASHBOARD_URL = "https://dashboard.example.com";
    try {
      const app = await buildApp();
      const slug = await createAuthedProjectPreview(app);

      const res = await app.inject({ method: "GET", url: `/api/previews/${slug}/open` });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("https://dashboard.example.com");
      await app.close();
    } finally {
      delete process.env.PREVIEW_AUTH_DASHBOARD_URL;
    }
  });

  it("mints a fresh bootstrap token and redirects an authenticated session to the preview, token in the query string", async () => {
    const app = await buildApp();
    const slug = await createAuthedProjectPreview(app);

    const res = await app.inject({
      method: "GET",
      url: `/api/previews/${slug}/open`,
      headers: DASHBOARD_AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin).toBe(`http://preview-${slug}.preview.example.com`);
    const token = location.searchParams.get("__mullion_preview");
    expect(token).toBeTruthy();
    expect(verifyPreviewToken(app.config.MULLION_SESSION_SECRET, token ?? undefined, slug)).toBe(
      true,
    );
    await app.close();
  });

  it("404s for an unknown slug even when authenticated", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/previews/does-not-exist/open",
      headers: DASHBOARD_AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("previews route with PREVIEW_BASE_HOST unset (default, feature opt-in)", () => {
  const localTmpDb = path.join(os.tmpdir(), `previews-disabled-test-${process.pid}.db`);

  beforeAll(() => {
    fs.rmSync(localTmpDb, { force: true });
    process.env.DATABASE_URL = `file:${localTmpDb}`;
    delete process.env.PREVIEW_BASE_HOST;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(localTmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("registers no preview routes", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "external", url: "https://example.com" },
    });
    expect(res.statusCode).toBe(404);

    const listRes = await app.inject({ method: "GET", url: "/api/previews" });
    expect(listRes.statusCode).toBe(404);

    await app.close();
  });
});
