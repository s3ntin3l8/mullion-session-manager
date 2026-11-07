import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { pendingBrowserCloses, previews, projects, sessions } from "../../src/db/schema.js";
import { AGENT_OPERATIONS, PROTOCOL_VERSION } from "../../src/shared/agent-protocol.js";
import {
  closeSessionBrowserBindings,
  getOrBindEndpoint,
  listSessionBrowserBindings,
  processPendingBrowserCloses,
  recordSessionBrowserBinding,
} from "../../src/services/session-browsers.js";

// Issue #2701 — the legacy cookie jar belongs to the default checkout, not to
// the first endpoint string that loads it; a local session's endpoint is fixed
// once for the panel and `use_browser`; a close reaches the key the context was
// opened with. Chromium is faked (never launched in a test); everything else is
// the real app, routes and database.
const launchedContexts: Array<{ storageState?: string }> = [];

class FakePage extends EventEmitter {
  content = async () => "<html></html>";
  url = () => "http://localhost/";
  title = async () => "t";
  getByText = () => ({ all: async () => [] });
  locator = () => ({ ariaSnapshot: async () => "- body" });
  evaluate = async () => [];
}
class FakeContext extends EventEmitter {
  constructor(readonly options?: { storageState?: string }) {
    super();
    launchedContexts.push(options ?? {});
  }
  async storageState(opts?: { path: string }) {
    if (opts?.path) fs.writeFileSync(opts.path, JSON.stringify({ cookies: [], origins: [] }));
    return { cookies: [], origins: [] };
  }
  async close() {}
  async addCookies() {}
  async newPage() {
    return new FakePage();
  }
}
class FakeBrowser extends EventEmitter {
  isConnected = () => true;
  async newContext(options?: { storageState?: string }) {
    return new FakeContext(options);
  }
  async close() {}
}
vi.mock("playwright", () => ({ chromium: { launch: vi.fn(async () => new FakeBrowser()) } }));

const tmpDb = path.join(os.tmpdir(), `browser-legacy-jar-${process.pid}.db`);
const TOKEN = "browser-legacy-jar-token";
type App = Awaited<ReturnType<typeof buildApp>>;

describe("legacy browser cookie jar and mixed-version closes (#2701)", () => {
  let primary: App;
  let n = 0;
  let dataRoot = "";
  const dataDir = () => (primary.browser as unknown as { dataDir: string }).dataDir;
  // The `.endpoints` index (#2700) is bookkeeping, not storage state.
  const files = () =>
    fs
      .readdirSync(dataDir())
      .filter((f) => !f.endsWith(".endpoints"))
      .sort();

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.BROWSER_ENABLED = "true";
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bl-jar-data-"));
    process.env.BROWSER_DATA_DIR = dataRoot;
    primary = await buildApp();
  });
  afterAll(async () => {
    await primary.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
    delete process.env.BROWSER_ENABLED;
    delete process.env.BROWSER_DATA_DIR;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await primary.browser.closeAll();
    launchedContexts.length = 0;
  });

  function addLocalProject() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-jar-"));
    const id = primary.db
      .insert(projects)
      .values({ name: `bl-${++n}`, cwd: dir, hostId: "local" })
      .returning({ id: projects.id })
      .get().id;
    return { id, dir };
  }
  function addSession(projectId: number, cwd: string, hostId = "local") {
    return primary.db
      .insert(sessions)
      .values({ projectId, name: "s", command: "bash", cwd, hostId })
      .returning({ id: sessions.id })
      .get().id;
  }
  function addPreview(projectId: number, sessionId: number, slug: string) {
    primary.db
      .insert(previews)
      .values({ slug, kind: "project", projectId, sessionId, branch: slug })
      .run();
  }
  const open = (sessionId: number) =>
    primary.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser`,
      payload: { action: "get" },
    });
  const writeJar = (projectId: number) =>
    fs.writeFileSync(
      path.join(dataDir(), `project-${projectId}.json`),
      JSON.stringify({ cookies: [], origins: [] }),
    );

  it("two default-checkout sessions with different preview slugs both use project-<id>.json", async () => {
    const { id, dir } = addLocalProject();
    writeJar(id);
    const jar = path.join(dataDir(), `project-${id}.json`);
    for (const slug of ["slug-a", "slug-b", undefined]) {
      const sessionId = addSession(id, dir);
      if (slug) addPreview(id, sessionId, slug);
      expect((await open(sessionId)).statusCode).toBe(200);
      expect(launchedContexts.at(-1)?.storageState).toBe(jar);
      closeSessionBrowserBindings(primary, sessionId);
      await vi.waitFor(() => expect(primary.browser.instanceCount).toBe(0));
    }
    // Every one of them saved back to the one file; no hashed file appeared.
    expect(files().filter((f) => f.startsWith(`project-${id}`))).toEqual([`project-${id}.json`]);
  });

  it("a second concurrent endpoint in the same checkout gets its own file", async () => {
    const { id, dir } = addLocalProject();
    writeJar(id);
    const first = addSession(id, dir);
    const second = addSession(id, dir);
    addPreview(id, first, "one");
    addPreview(id, second, "two");
    await open(first);
    await open(second);
    expect(launchedContexts[0].storageState).toBe(path.join(dataDir(), `project-${id}.json`));
    expect(launchedContexts[1].storageState).toBeUndefined();
    await primary.browser.closeAll();
    const mine = files().filter((f) => f.startsWith(`project-${id}`));
    expect(mine).toHaveLength(2);
    expect(mine).toContain(`project-${id}.json`);
    expect(mine.some((f) => /^project-\d+-[0-9a-f]{16}\.json$/.test(f))).toBe(true);
  });

  it("two concurrent first binds produce one claim of the jar", async () => {
    const { id, dir } = addLocalProject();
    writeJar(id);
    const a = addSession(id, dir);
    const b = addSession(id, dir);
    addPreview(id, a, "race-a");
    addPreview(id, b, "race-b");
    await Promise.all([open(a), open(b)]);
    const jar = path.join(dataDir(), `project-${id}.json`);
    expect(launchedContexts.filter((c) => c.storageState === jar)).toHaveLength(1);
    expect(launchedContexts).toHaveLength(2);
  });

  it("deleting a project removes its jar, claim file and per-target files", async () => {
    const { id } = addLocalProject();
    const other = addLocalProject().id;
    const names = [
      `project-${id}.json`,
      `project-${id}.owner`,
      `project-${id}-0123456789abcdef.json`,
      `project-${other}.json`,
    ];
    for (const name of names) fs.writeFileSync(path.join(dataDir(), name), "{}");
    fs.mkdirSync(path.join(dataDir(), "downloads", `project-${id}-0123456789abcdef`), {
      recursive: true,
    });
    fs.mkdirSync(path.join(dataDir(), "downloads", `project-${id}`), { recursive: true });
    const res = await primary.inject({ method: "DELETE", url: `/api/projects/${id}` });
    expect(res.statusCode).toBe(204);
    await vi.waitFor(() =>
      expect(files().filter((f) => f.startsWith(`project-${id}`))).toEqual([]),
    );
    expect(files()).toContain(`project-${other}.json`);
    expect(fs.existsSync(path.join(dataDir(), "downloads", `project-${id}-0123456789abcdef`))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(dataDir(), "downloads", `project-${id}`))).toBe(false);
  });

  it("the panel and use_browser resolving together produce one context", async () => {
    const { id, dir } = addLocalProject();
    const sessionId = addSession(id, dir);
    addPreview(id, sessionId, "first-slug");
    // Panel (WS-style proxy) and automation (REST) race on a session with no binding.
    const [a, b] = await Promise.all([open(sessionId), open(sessionId)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(primary.browser.instanceCount).toBe(1);
    expect(listSessionBrowserBindings(primary, sessionId)).toHaveLength(1);
  });

  it("a preview that appears after the first resolve does not re-key an open panel", async () => {
    // The endpoint is fixed at the session's first browser resolve. A preview
    // accepted afterwards must not give use_browser a different key (a second
    // context, and the first one leaked on close).
    const { id, dir } = addLocalProject();
    const sessionId = addSession(id, dir);
    expect((await open(sessionId)).statusCode).toBe(200); // no preview yet
    expect(listSessionBrowserBindings(primary, sessionId)).toEqual([
      expect.objectContaining({ targetEndpoint: "" }),
    ]);
    addPreview(id, sessionId, "arrives-late");

    expect((await open(sessionId)).statusCode).toBe(200);
    expect(primary.browser.instanceCount).toBe(1);
    const [binding] = listSessionBrowserBindings(primary, sessionId);
    expect(binding.targetEndpoint).toBe("");
  });

  it("getOrBindEndpoint is a compare-and-set: the first endpoint wins for both callers", () => {
    const { id, dir } = addLocalProject();
    const sessionId = addSession(id, dir);
    const base = { projectId: id, hostId: "local", checkoutRoot: dir, legacy: true };
    const first = getOrBindEndpoint(primary, sessionId, { ...base, endpoint: "x" });
    const second = getOrBindEndpoint(primary, sessionId, { ...base, endpoint: "y" });
    expect(first.endpoint).toBe("x");
    expect(second.endpoint).toBe("x");
    const none = addSession(id, dir);
    getOrBindEndpoint(primary, none, base);
    expect(
      getOrBindEndpoint(primary, none, { ...base, endpoint: "late" }).endpoint,
    ).toBeUndefined();
  });

  describe("remote agents", () => {
    /** A listening agent with its own route table; `routes` decides what it understands. */
    async function agentApp(register: (app: ReturnType<typeof Fastify>) => void) {
      const app = Fastify();
      register(app);
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (address === null || typeof address === "string") throw new Error("no address");
      return { app, port: address.port };
    }
    async function addHost(port: number, operations: readonly string[]) {
      const res = await primary.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: `bl-host-${++n}`, baseUrl: `http://127.0.0.1:${port}`, token: TOKEN },
      });
      const hostId = res.json().id as string;
      primary.hostAgentTracker?.record(hostId, {
        agents: null,
        capabilities: null,
        mullionVersion: null,
        protocol: {
          protocolVersion: PROTOCOL_VERSION,
          legacy: false,
          operations: [...operations],
          launchOptions: ["browserTarget"],
        },
      });
      return hostId;
    }

    it("a real old agent (no endpoint in routes or schema) yields one context and one close", async () => {
      // Keys contexts like an agent that predates endpoints: project + checkout only.
      const contexts = new Set<string>();
      let closes = 0;
      const oldQuery = {
        type: "object",
        additionalProperties: false,
        required: ["projectId", "hostId", "checkoutRoot"],
        properties: {
          projectId: { type: "number" },
          hostId: { type: "string" },
          checkoutRoot: { type: "string" },
          legacy: { type: "string" },
        },
      };
      const { app: old, port } = await agentApp((a) => {
        a.post("/internal/sessions/:id/browser", async (req: FastifyRequest) => {
          const q = req.query as Record<string, string>;
          contexts.add(`${q.projectId}\0${q.checkoutRoot}`);
          return {
            url: "http://localhost/",
            title: "t",
            content: "",
            consoleLogs: [],
            pageErrors: [],
          };
        });
        a.post(
          "/internal/browser/close",
          { schema: { querystring: oldQuery } },
          async (req: FastifyRequest) => {
            const q = req.query as { projectId: number; checkoutRoot: string };
            closes++;
            contexts.delete(`${q.projectId}\0${q.checkoutRoot}`);
            return { ok: true };
          },
        );
      });
      try {
        const ops = AGENT_OPERATIONS.filter((op) => op !== "browser-endpoints");
        const hostId = await addHost(port, ops);
        const dir = "/work/old-agent";
        const projectId = primary.db
          .insert(projects)
          .values({ name: `bl-${++n}`, cwd: dir, hostId })
          .returning({ id: projects.id })
          .get().id;
        const sessionId = addSession(projectId, dir, hostId);
        recordSessionBrowserBinding(
          primary,
          sessionId,
          { projectId, hostId, checkoutRoot: dir, legacy: true },
          { endpointUnfixed: true },
        );
        addPreview(projectId, sessionId, "slug-old");
        await open(sessionId);
        await open(sessionId);
        expect(contexts.size).toBe(1);
        closeSessionBrowserBindings(primary, sessionId);
        await vi.waitFor(() => expect(closes).toBe(1));
        expect(contexts.size).toBe(0);
      } finally {
        await old.close();
      }
    });

    it("a real old agent still closes a session whose binding already carries an endpoint", async () => {
      // The binding was recorded while the host spoke endpoints; the agent now
      // refuses an `endpoint` query parameter outright (its schema is strict).
      // The close must reach it without that parameter, not 400 into a leak.
      let closes = 0;
      const oldQuery = {
        type: "object",
        additionalProperties: false,
        required: ["projectId", "hostId", "checkoutRoot"],
        properties: {
          projectId: { type: "number" },
          hostId: { type: "string" },
          checkoutRoot: { type: "string" },
          legacy: { type: "string" },
        },
      };
      const { app: old, port } = await agentApp((a) => {
        a.post("/internal/browser/close", { schema: { querystring: oldQuery } }, async () => {
          closes++;
          return { ok: true };
        });
      });
      try {
        const ops = AGENT_OPERATIONS.filter((op) => op !== "browser-endpoints");
        const hostId = await addHost(port, ops);
        const dir = "/work/old-agent-bound";
        const projectId = primary.db
          .insert(projects)
          .values({ name: `bl-${++n}`, cwd: dir, hostId })
          .returning({ id: projects.id })
          .get().id;
        const sessionId = addSession(projectId, dir, hostId);
        recordSessionBrowserBinding(primary, sessionId, {
          projectId,
          hostId,
          checkoutRoot: dir,
          endpoint: "bound-slug",
          legacy: true,
        });
        closeSessionBrowserBindings(primary, sessionId);
        await vi.waitFor(() => expect(closes).toBeGreaterThan(0), { timeout: 8000 });
        expect(
          primary.db
            .select()
            .from(pendingBrowserCloses)
            .where(eq(pendingBrowserCloses.projectId, projectId))
            .all(),
        ).toEqual([]);
      } finally {
        await old.close();
      }
    });

    it("a downgrade after an endpoint bind closes the endpoint-keyed context, and a failed close keeps its key", async () => {
      const closed: Array<{ endpoint?: string }> = [];
      let fail = true;
      const { app: agent, port } = await agentApp((a) => {
        a.post("/internal/browser/close", async (req: FastifyRequest, reply: FastifyReply) => {
          if (fail) return reply.code(503).send({ error: "down" });
          closed.push({ endpoint: (req.query as { endpoint?: string }).endpoint });
          return { ok: true };
        });
      });
      try {
        // Bound while the host spoke endpoints; the agent has since lost the operation.
        const hostId = await addHost(
          port,
          AGENT_OPERATIONS.filter((op) => op !== "browser-endpoints"),
        );
        const dir = "/work/downgraded";
        const projectId = primary.db
          .insert(projects)
          .values({ name: `bl-${++n}`, cwd: dir, hostId })
          .returning({ id: projects.id })
          .get().id;
        const sessionId = addSession(projectId, dir, hostId);
        recordSessionBrowserBinding(primary, sessionId, {
          projectId,
          hostId,
          checkoutRoot: dir,
          endpoint: "bound-slug",
          legacy: true,
        });
        closeSessionBrowserBindings(primary, sessionId);
        await vi.waitFor(
          () =>
            expect(
              primary.db
                .select()
                .from(pendingBrowserCloses)
                .where(eq(pendingBrowserCloses.projectId, projectId))
                .all().length,
            ).toBe(1),
          { timeout: 8000 },
        );
        const [row] = primary.db
          .select()
          .from(pendingBrowserCloses)
          .where(eq(pendingBrowserCloses.projectId, projectId))
          .all();
        expect(row.endpoint).toBe("bound-slug");
        fail = false;
        await processPendingBrowserCloses(primary, new Date(Date.now() + 3_600_000));
        expect(closed.map((c) => c.endpoint)).toEqual(["bound-slug", undefined]);
      } finally {
        await agent.close();
      }
    });
  });
});
