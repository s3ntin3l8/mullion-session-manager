import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts, projects, sessions } from "../../src/db/schema.js";

const DAY = 86_400_000;

describe("GET /api/hosts stale cleanup (#3183)", () => {
  let app: FastifyInstance;
  let nextId = 0;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeDb();
  });

  function addHost(ageDays: number | null = 40) {
    const id = `stale-${++nextId}`;
    const lastSeenAt = ageDays === null ? null : new Date(Date.now() - ageDays * DAY);
    app.db.insert(hosts).values({ id, name: id, lastSeenAt }).run();
    app.hostHeartbeatTracker!.markOffline(id);
    return { id, lastSeenAt };
  }

  async function listed(id: string) {
    const response = await app.inject({ method: "GET", url: "/api/hosts" });
    expect(response.statusCode).toBe(200);
    return (response.json() as Array<Record<string, unknown>>).find((host) => host.id === id)!;
  }

  it("flags an offline outbound-only host and returns persisted last seen after tracker restart", async () => {
    const host = addHost();
    // No successful ping exists in the current process, as after a primary restart.
    expect(app.hostHeartbeatTracker!.getHealth(host.id).lastSeenAt).toBeNull();
    expect(await listed(host.id)).toMatchObject({
      stale: true,
      health: "offline",
      lastSeenAt: new Date(Math.floor(host.lastSeenAt!.getTime() / 1000) * 1000).toISOString(),
    });
    // Reading the offer never deletes anything.
    expect(app.db.select().from(hosts).where(eq(hosts.id, host.id)).get()).toBeDefined();
  });

  it("does not flag recent, unknown, pending, degraded, online or local hosts", async () => {
    const recent = addHost(5);
    const unknown = addHost(null);
    const pending = addHost();
    app.hostHeartbeatTracker!.invalidateHost(pending.id);
    const degraded = addHost();
    app.hostHeartbeatTracker!.invalidateHost(degraded.id);
    app.hostHeartbeatTracker!.recordFailure(degraded.id);
    const online = addHost();
    app.hostHeartbeatTracker!.recordSuccess(online.id);
    for (const id of [recent.id, unknown.id, pending.id, degraded.id, online.id, "local"])
      expect(await listed(id)).toMatchObject({ stale: false });
  });

  it("uses the fresher in-memory successful contact for the displayed last seen", async () => {
    const host = addHost();
    app.hostHeartbeatTracker!.recordSuccess(host.id);
    const seen = app.hostHeartbeatTracker!.getHealth(host.id).lastSeenAt!;
    // A subsequent success can be newer than the hourly persisted snapshot.
    app.db
      .update(hosts)
      .set({ lastSeenAt: new Date(Date.now() - 5 * DAY) })
      .where(eq(hosts.id, host.id))
      .run();
    expect(await listed(host.id)).toMatchObject({
      lastSeenAt: new Date(seen).toISOString(),
      stale: false,
    });
  });

  it("protects hosts with active sessions using the session host before its project host", async () => {
    const inherited = addHost();
    const explicit = addHost();
    const projectOnly = addHost();
    const ended = addHost();
    const makeProject = (hostId: string) =>
      app.db.insert(projects).values({ name: hostId, cwd: "/tmp", hostId }).returning().get().id;
    app.db
      .insert(sessions)
      .values([
        {
          projectId: makeProject(inherited.id),
          name: "inherited",
          command: "sh",
          status: "active",
        },
        {
          projectId: makeProject(projectOnly.id),
          hostId: explicit.id,
          name: "explicit",
          command: "sh",
          status: "active",
        },
        { projectId: makeProject(ended.id), name: "ended", command: "sh", status: "exited" },
      ])
      .run();
    expect(await listed(inherited.id)).toMatchObject({ stale: false });
    expect(await listed(explicit.id)).toMatchObject({ stale: false });
    expect(await listed(projectOnly.id)).toMatchObject({ stale: true });
    expect(await listed(ended.id)).toMatchObject({ stale: true });
  });

  it("applies the editable threshold and lets zero disable the offer", async () => {
    const host = addHost(10);
    const setDays = async (staleAfterDays: number) => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { hosts: { staleAfterDays } },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().hosts.staleAfterDays).toBe(staleAfterDays);
    };
    try {
      expect(await listed(host.id)).toMatchObject({ stale: false });
      await setDays(7);
      expect(await listed(host.id)).toMatchObject({ stale: true });
      await setDays(0);
      expect(await listed(host.id)).toMatchObject({ stale: false });
    } finally {
      await setDays(30);
    }
  });
});
