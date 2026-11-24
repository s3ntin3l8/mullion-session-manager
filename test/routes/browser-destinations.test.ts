import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { eq } from "drizzle-orm";
import type * as DockerDetect from "../../src/services/docker-service-detect.js";

// #3003 — GET /api/projects/:id/browser-destinations (the Browser pane's
// quick pick) and POST …/preview, which opens a running service in the
// preview. A real dock session with buffered PTY output needs the same
// node-pty/child_process mocking as projects-dev-server-detect.test.ts;
// Compose discovery is faked at getComposeServices, the one `docker` call.
const fakePtyChildren: FakePty[] = [];

class FakePty {
  dataListeners: Array<(data: string) => void> = [];
  onData(cb: (data: string) => void) {
    this.dataListeners.push(cb);
    return { dispose: () => {} };
  }
  onExit() {
    return { dispose: () => {} };
  }
  write() {}
  resize() {}
  kill() {}
  emitData(chunk: string) {
    for (const cb of this.dataListeners) cb(chunk);
  }
}

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const child = new FakePty();
    fakePtyChildren.push(child);
    return child;
  }),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((file: string) => {
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      if (file === "systemctl") {
        ee.stdout = new EventEmitter();
        setImmediate(() => {
          ee.emit("exit", 0);
          setImmediate(() => ee.stdout?.emit("data", Buffer.from("active\n")));
        });
        return ee;
      }
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }),
  };
});

let composeServices: DockerDetect.ComposeService[] = [];
vi.mock("../../src/services/docker-service-detect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof DockerDetect>();
  return { ...actual, getComposeServices: vi.fn(async () => composeServices) };
});

const { buildApp } = await import("../../src/app.js");
const { hosts, previews, projects, sessions } = await import("../../src/db/schema.js");
const { bindBranchPreview, upsertBranchPreview } =
  await import("../../src/services/preview-registry.js");
const { resolvePreviewTarget } = await import("../../src/services/preview-upstream.js");
const { prunePortPreviews } = await import("../../src/services/browser-destinations.js");

const tmpDb = path.join(os.tmpdir(), `browser-destinations-test-${process.pid}.db`);

async function waitUntil(check: () => boolean) {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

function composeService(cwd: string, over: Partial<DockerDetect.ComposeService> = {}) {
  return {
    composeProject: "shop",
    service: "web",
    containerName: "shop-web-1",
    workingDir: cwd,
    state: "running",
    status: "Up 2 hours",
    imageRef: "nginx:latest",
    imageId: "sha256:x",
    buildable: false,
    pullable: true,
    composeResolvable: false,
    configFiles: [],
    envFile: null,
    configHash: "",
    publishedPorts: [8080],
    ...over,
  } satisfies DockerDetect.ComposeService;
}

type App = Awaited<ReturnType<typeof buildApp>>;

async function startDockSession(app: App, projectId: number, name: string, banner: string) {
  const before = fakePtyChildren.length;
  const spawned = await app.inject({
    method: "POST",
    url: "/api/sessions",
    payload: { projectId, command: "npm run dev", kind: "dock", name },
  });
  expect(spawned.statusCode).toBe(201);
  await waitUntil(() => fakePtyChildren.length > before);
  fakePtyChildren[fakePtyChildren.length - 1].emitData(banner);
  return spawned.json().id as number;
}

describe("browser destinations (#3003)", () => {
  let app: App;
  let projectId: number;
  let cwd: string;
  let storybookId: number;
  let devId: number;
  let branchSlug: string;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.PREVIEW_BASE_HOST = "preview.test";
    app = await buildApp();
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "browser-destinations-"));
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, name: "shop", cwd },
    });
    expect(created.statusCode).toBe(201);
    projectId = created.json().id as number;
    const saved = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/preview-targets`,
      payload: {
        devServerUrl: "5173",
        targets: [
          {
            id: "api-docs",
            name: "API docs",
            destination: "localhost:9000/docs",
            connectionOrigin: "primary",
          },
        ],
      },
    });
    expect(saved.statusCode).toBe(200);
    composeServices = [composeService(cwd)];
    storybookId = await startDockSession(
      app,
      projectId,
      "storybook",
      "  ➜  Local:   http://localhost:6006/\n",
    );
    devId = await startDockSession(
      app,
      projectId,
      "vite",
      "  ➜  Local:   http://localhost:5173/\n",
    );
    // A branch preview's own dock session: listed as the branch preview, not
    // as a running Dock command. Not live here, so it has no PTY anyway.
    const branchSession = app.db
      .insert(sessions)
      .values({ projectId, command: "npm run dev", kind: "dock", name: "preview feat/cart" })
      .returning()
      .get();
    const branch = upsertBranchPreview(app, projectId, "feat/cart");
    bindBranchPreview(app, branch.slug, { sessionId: branchSession.id, upstreamPort: 4100 });
    branchSlug = branch.slug;
  });

  afterAll(async () => {
    await app.close();
    const { closeDb } = await import("../../src/db/client.js");
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
    delete process.env.PREVIEW_BASE_HOST;
  });

  it("lists running services, then saved destinations, in order", async () => {
    const res = await app.inject({ url: `/api/projects/${projectId}/browser-destinations` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runningNote).toBeNull();
    expect(body.destinations.map((d: { key: string; group: string }) => [d.group, d.key])).toEqual([
      ["running", `dock:${storybookId}`],
      ["running", `dock:${devId}`],
      ["running", "compose:shop:web:8080"],
      ["saved", "dev-server"],
      ["saved", "target:api-docs"],
      ["saved", `branch:${branchSlug}`],
    ]);
    const byKey = new Map(body.destinations.map((d: { key: string }) => [d.key, d]));
    expect(byKey.get(`dock:${storybookId}`)).toMatchObject({
      kind: "dock",
      label: "storybook",
      address: "http://localhost:6006/",
      hostId: "local",
    });
    expect(byKey.get("compose:shop:web:8080")).toMatchObject({
      kind: "compose",
      label: "web",
      detail: "shop · port 8080",
      address: "http://localhost:8080/",
    });
    expect(byKey.get("dev-server")).toMatchObject({ address: "http://localhost:5173/" });
    expect(byKey.get("target:api-docs")).toMatchObject({
      targetId: "api-docs",
      address: "http://localhost:9000/docs",
      hostId: "local",
    });
    expect(byKey.get(`branch:${branchSlug}`)).toMatchObject({
      label: "feat/cart",
      previewSlug: branchSlug,
      address: "http://localhost:4100/",
    });
  });

  it("opens a running Dock command through a port preview the proxy serves", async () => {
    const open = () =>
      app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/browser-destinations/preview`,
        payload: { key: `dock:${storybookId}` },
      });
    const first = await open();
    expect(first.statusCode).toBe(200);
    expect(first.json().label).toBe("storybook");
    const slug = first.json().slug as string;
    // Reused, not minted again.
    expect((await open()).json().slug).toBe(slug);
    const row = app.db.select().from(previews).where(eq(previews.slug, slug)).get()!;
    expect(row).toMatchObject({ upstreamPort: 6006, sessionId: storybookId, branch: "port:6006" });
    const resolved = await resolvePreviewTarget(app, slug);
    expect(resolved).toEqual({
      ok: true,
      target: { kind: "project", devServerUrl: "6006", projectId, hostId: "local" },
    });
  });

  it("opens a Compose service's published port, served from the project's host", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/browser-destinations/preview`,
      payload: { key: "compose:shop:web:8080" },
    });
    expect(res.statusCode).toBe(200);
    const resolved = await resolvePreviewTarget(app, res.json().slug);
    expect(resolved).toEqual({
      ok: true,
      target: { kind: "project", devServerUrl: "8080", projectId, hostId: "local" },
    });
  });

  it("opens the project's own preview for a port the dev server already names", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/browser-destinations/preview`,
      payload: { key: `dock:${devId}` },
    });
    expect(res.statusCode).toBe(200);
    const row = app.db.select().from(previews).where(eq(previews.slug, res.json().slug)).get()!;
    expect(row.branch).toBe("");
    expect(row.upstreamPort).toBeNull();
  });

  it("refuses a key that names no running service", async () => {
    for (const key of ["dock:999999", "compose:shop:web:9999", "dev-server", "nonsense"]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/browser-destinations/preview`,
        payload: { key },
      });
      expect(res.statusCode).toBe(404);
    }
    const missing = await app.inject({
      method: "POST",
      url: "/api/projects/987654/browser-destinations/preview",
      payload: { key: "dock:1" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("never lists a port preview as a branch preview", async () => {
    const listed = await app.inject({ url: "/api/previews" });
    const ports = listed.json().filter((p: { portPreview?: boolean }) => p.portPreview === true);
    expect(ports.length).toBeGreaterThanOrEqual(2);
    for (const p of ports) expect(p.branch ?? null).toBeNull();
    // The saved group lists branch previews only, not port previews.
    const res = await app.inject({ url: `/api/projects/${projectId}/browser-destinations` });
    expect(
      res.json().destinations.filter((d: { kind: string }) => d.kind === "branch"),
    ).toHaveLength(1);
  });

  it("leaves Compose services out when Docker discovery is off", async () => {
    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { dock: { dockerServices: false } },
    });
    try {
      const res = await app.inject({ url: `/api/projects/${projectId}/browser-destinations` });
      expect(res.json().destinations.some((d: { kind: string }) => d.kind === "compose")).toBe(
        false,
      );
    } finally {
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { dock: { dockerServices: true } },
      });
    }
  });

  it("says why a project on another host has no running services", async () => {
    app.db.insert(hosts).values({ id: "dev-01", name: "dev-01" }).run();
    const remote = app.db
      .insert(projects)
      .values({ name: "remote", cwd: "/srv/remote", hostId: "dev-01", devServerUrl: "3000" })
      .returning()
      .get();
    const res = await app.inject({ url: `/api/projects/${remote.id}/browser-destinations` });
    expect(res.statusCode).toBe(200);
    expect(res.json().runningNote).toContain("dev-01");
    expect(res.json().destinations.map((d: { key: string }) => d.key)).toEqual(["dev-server"]);
    const open = await app.inject({
      method: "POST",
      url: `/api/projects/${remote.id}/browser-destinations/preview`,
      payload: { key: "compose:shop:web:8080" },
    });
    expect(open.statusCode).toBe(404);
  });

  it("says where a session's browser runs, for the agent's browser", async () => {
    const res = await app.inject({
      url: `/api/projects/${projectId}/browser-destinations?sessionId=${storybookId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agentBrowser).toEqual({ hostId: "local", reason: null });
    // Without the query there is nothing to say.
    const plain = await app.inject({ url: `/api/projects/${projectId}/browser-destinations` });
    expect(plain.json().agentBrowser).toBeNull();
    expect(
      (
        await app.inject({
          url: `/api/projects/${projectId}/browser-destinations?sessionId=nope`,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          url: `/api/projects/${projectId}/browser-destinations?sessionId=987654`,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("never hands a port preview back as a branch preview", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId, branch: "port:6006" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().slug).toBeUndefined();
  });

  it("opens a port preview, not the project's own, while the dev server is served elsewhere", async () => {
    app.db.insert(hosts).values({ id: "box-b", name: "box-b" }).run();
    const elsewhere = app.db
      .insert(sessions)
      .values({ projectId, command: "npm run dev", hostId: "box-b" })
      .returning()
      .get();
    const checkout = app.db
      .select()
      .from(previews)
      .where(eq(previews.projectId, projectId))
      .all()
      .find((p) => p.branch === "")!;
    app.db
      .update(previews)
      .set({ sessionId: elsewhere.id })
      .where(eq(previews.slug, checkout.slug))
      .run();
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/browser-destinations/preview`,
        payload: { key: `dock:${devId}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().slug).not.toBe(checkout.slug);
      const row = app.db.select().from(previews).where(eq(previews.slug, res.json().slug)).get()!;
      expect(row).toMatchObject({ branch: "port:5173", upstreamPort: 5173 });
    } finally {
      app.db
        .update(previews)
        .set({ sessionId: null })
        .where(eq(previews.slug, checkout.slug))
        .run();
    }
  });

  it("answers 400 for a bad id and 404 for an unknown project", async () => {
    expect((await app.inject({ url: "/api/projects/x/browser-destinations" })).statusCode).toBe(
      400,
    );
    expect(
      (await app.inject({ url: "/api/projects/987654/browser-destinations" })).statusCode,
    ).toBe(404);
  });

  describe("pruning port previews (#3467)", () => {
    const open = async (key: string) => {
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/browser-destinations/preview`,
        payload: { key },
      });
      expect(res.statusCode).toBe(200);
      return res.json().slug as string;
    };
    const exists = (slug: string) =>
      app.db.select().from(previews).where(eq(previews.slug, slug)).all().length > 0;

    it(
      "answers 503, then 404 once pruned, for a Dock port preview whose session was killed",
      { timeout: 30_000 },
      async () => {
        const slug = await open(`dock:${storybookId}`);
        const checkout = app.db
          .select()
          .from(previews)
          .where(eq(previews.projectId, projectId))
          .all()
          .filter((p) => p.branch === "" || p.branch === "feat/cart")
          .map((p) => p.slug);
        expect(
          (await app.inject({ method: "DELETE", url: `/api/sessions/${storybookId}` })).statusCode,
        ).toBeLessThan(300);
        // Before the sweep the slug must not dial the port.
        expect(await resolvePreviewTarget(app, slug)).toEqual({ ok: false, status: 503 });
        expect(await prunePortPreviews(app)).toContain(slug);
        expect(exists(slug)).toBe(false);
        expect(await resolvePreviewTarget(app, slug)).toEqual({ ok: false, status: 404 });
        // Checkout and branch previews, and the still-running Dock session's
        // port preview, are untouched.
        for (const kept of checkout) expect(exists(kept)).toBe(true);
        expect(exists(branchSlug)).toBe(true);
      },
    );

    it("keeps a live Dock port preview and a Compose one while discovery lists the port", async () => {
      const dockSlug = await open(`dock:${devId}`);
      // The dev server names 5173, so that pick is the checkout preview; use
      // the compose one for the session-less row.
      const composeSlug = await open("compose:shop:web:8080");
      await prunePortPreviews(app);
      expect(exists(composeSlug)).toBe(true);
      expect(exists(dockSlug)).toBe(true);
    });

    it("removes a Compose port preview once discovery no longer reports the port", async () => {
      const slug = await open("compose:shop:web:8080");
      composeServices = [];
      // The real reconcile timer, armed at its 1 s floor, does the sweep.
      app.reconfigureReconciler(1);
      try {
        await vi.waitFor(() => expect(exists(slug)).toBe(false), { timeout: 8000 });
        expect(await resolvePreviewTarget(app, slug)).toEqual({ ok: false, status: 404 });
      } finally {
        app.reconfigureReconciler(30);
        composeServices = [composeService(cwd)];
      }
    });
  });

  it("refuses to open a running service without the preview proxy", async () => {
    await app.close();
    delete process.env.PREVIEW_BASE_HOST;
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/browser-destinations/preview`,
      payload: { key: `dock:${storybookId}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("PREVIEW_BASE_HOST");
  });
});
