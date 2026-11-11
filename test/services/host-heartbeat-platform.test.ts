import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type * as RemoteHostClientModule from "../../src/services/remote-host-client.js";
import { buildTestApp } from "../helpers/app.js";
import { hosts, projects, sessions } from "../../src/db/schema.js";
import { createHost } from "../../src/services/host-registry.js";
import { startHostHeartbeat } from "../../src/services/host-heartbeat.js";
import { resolveExecutionContext } from "../../src/services/execution-context.js";

// Issue #2953 — a host added by hand never enrolls, so nothing wrote its
// `platform`; the heartbeat sweep receives it in every capacity report and now
// fills it when the row has none. Real DB and real sweep; only the remote
// client is faked, per host id.

const capacity = new Map<string, { platform?: unknown }>();

vi.mock("../../src/services/remote-host-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteHostClientModule>();
  return {
    ...actual,
    getRemoteHostClient: (_app: unknown, hostId: string) => ({
      probe: async () => "ok",
      resolveCapacity: async () => ({
        sampledAt: new Date().toISOString(),
        logicalCores: 4,
        loadAverage1m: 0,
        memory: { totalBytes: 1, freeBytes: 1 },
        sessions: { tracked: 0, alive: 0 },
        ...capacity.get(hostId),
      }),
      detectAgents: async () => [],
      resolveConfig: async () => ({ version: "0.3.61" }),
    }),
  };
});

vi.mock("../../src/services/terminal-palette-sync.js", () => ({
  pushTerminalPaletteToHost: async () => {},
}));

describe("heartbeat sweep fills a host's platform from its capacity report", () => {
  let app: FastifyInstance;
  let stop: (() => void) | undefined;

  beforeEach(async () => {
    capacity.clear();
    app = await buildTestApp();
    await app.ready();
  });

  afterEach(async () => {
    stop?.();
    stop = undefined;
    await app.close();
  });

  const platformOf = (id: string) =>
    app.db.select().from(hosts).where(eq(hosts.id, id)).get()?.platform ?? null;

  /** Runs the real sweep (its first pass is immediate) and waits for the host
   * to have been polled, i.e. for the capacity cache to hold its report. */
  async function sweep(hostId: string): Promise<void> {
    stop = startHostHeartbeat(app);
    // The test env turns the heartbeat off (HOST_HEARTBEAT_INTERVAL_SECONDS=0);
    // arming it through the same hook Settings uses runs the first sweep now.
    app.reconfigureHostHeartbeat?.(30);
    for (let i = 0; i < 200 && !app.hostCapacityTracker?.get(hostId); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(app.hostCapacityTracker?.get(hostId)).toBeTruthy();
  }

  function addHost(name: string): string {
    return createHost(app, { name, baseUrl: `http://${name}.test`, token: "t" }).id;
  }

  it("sets win32 on a NULL row, shows it in GET /api/hosts, and makes drive paths resolve", async () => {
    const id = addHost("desktop");
    capacity.set(id, { platform: "win32" });
    expect(platformOf(id)).toBeNull();

    await sweep(id);

    expect(platformOf(id)).toBe("win32");
    const listed = (await app.inject({ method: "GET", url: "/api/hosts" })).json() as Array<{
      id: string;
      platform: string | null;
    }>;
    expect(listed.find((h) => h.id === id)?.platform).toBe("win32");

    // The consumer: path flavour. A lower-cased session cwd is only "inside"
    // the checkout under win32 rules; with a NULL platform it was not.
    const projectId = app.db
      .insert(projects)
      .values({
        name: "runway",
        cwd: "/home/x/runway",
        hostId: "local",
        hostCwds: JSON.stringify({ [id]: "D:\\Projects\\runway" }),
      })
      .returning({ id: projects.id })
      .get().id;
    const sessionId = app.db
      .insert(sessions)
      .values({
        projectId,
        name: "s",
        command: "bash",
        cwd: "d:\\projects\\runway\\src",
        hostId: id,
      })
      .returning({ id: sessions.id })
      .get().id;
    expect(await resolveExecutionContext(app, { projectId, sessionId })).toMatchObject({
      ok: true,
      context: { hostId: id, platform: "win32", checkoutRoot: "D:\\Projects\\runway" },
    });
  });

  it("fills a row whose platform is the empty string too", async () => {
    const id = addHost("blank");
    app.db.update(hosts).set({ platform: "" }).where(eq(hosts.id, id)).run();
    capacity.set(id, { platform: "win32" });

    await sweep(id);

    expect(platformOf(id)).toBe("win32");
  });

  it("never rewrites a platform that is already set", async () => {
    const id = addHost("macbook");
    app.db.update(hosts).set({ platform: "darwin" }).where(eq(hosts.id, id)).run();
    capacity.set(id, { platform: "win32" });

    await sweep(id);

    expect(platformOf(id)).toBe("darwin");
  });

  it.each([["Win 32"], [""], ["a".repeat(100)], [42], [null]])(
    "ignores a reported platform of %j and still records the host's capacity",
    async (bad) => {
      const id = addHost("odd");
      capacity.set(id, { platform: bad });

      await sweep(id);

      expect(platformOf(id)).toBeNull();
      expect(app.hostHeartbeatTracker?.getHealth(id).status).toBe("online");
    },
  );
});
