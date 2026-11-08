// Route-level wiring of the unreachable-host log throttle (#2778, follow-up to
// #2753): the batch diff-stats and refs routes and the live-status route feed
// `host-warn-throttle.ts` through HostOutcomes / noteHostReachable. A wiring
// mistake there (ok() for a local host, a dropped guard) is invisible to the
// helper's own unit tests, so these go through app.inject().

import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hosts, projects, sessions } from "../../src/db/schema.js";
import { buildApp } from "../../src/app.js";
import { deleteHost } from "../../src/services/host-registry.js";
import { LOCAL_HOST_ID } from "../../src/shared/constants.js";
import { HostUnreachableError } from "../../src/services/remote-host-errors.js";
import * as remoteHostClient from "../../src/services/remote-host-client.js";
import * as sessionBackend from "../../src/services/session-backend.js";
import { resetHostWarnThrottle, warnHostThrottled } from "../../src/services/host-warn-throttle.js";

const MSG_DIFF_STATS = "batch git-diff-stats: remote host unavailable, omitting";
const MSG_REFS = "batch git-refs: remote host unavailable for branches, omitting";

type Client = Record<string, ReturnType<typeof vi.fn>>;

function stubClient(client: Client) {
  return vi
    .spyOn(remoteHostClient, "getRemoteHostClient")
    .mockReturnValue(client as unknown as remoteHostClient.RemoteHostClient);
}

describe("unreachable-host throttle wiring", () => {
  beforeEach(() => resetHostWarnThrottle());
  afterEach(() => {
    vi.restoreAllMocks();
    resetHostWarnThrottle();
  });

  async function seedRemote(app: Awaited<ReturnType<typeof buildApp>>, hostId: string) {
    app.db.insert(hosts).values({ id: hostId, name: hostId, baseUrl: "http://127.0.0.1:1" }).run();
    const projectId = app.db
      .insert(projects)
      .values({ name: `p-${hostId}`, cwd: os.tmpdir(), hostId })
      .returning({ id: projects.id })
      .get().id;
    const sessionId = app.db
      .insert(sessions)
      .values({ projectId, command: "bash", status: "active", hostId, cwd: "/remote/x" })
      .returning({ id: sessions.id })
      .get().id;
    return { projectId, sessionId };
  }

  const count = (spy: { mock: { calls: unknown[][] } }, msg: string) =>
    spy.mock.calls.filter(([, m]) => m === msg).length;

  describe("GET /api/projects/git-diff-stats", () => {
    it("logs once then suppresses; a success clears the throttle", async () => {
      const app = await buildApp();
      try {
        const { sessionId } = await seedRemote(app, "ds-host");
        const client: Client = {
          resolveGitDiffStats: vi
            .fn()
            .mockRejectedValue(new HostUnreachableError("ds-host", new Error("down"))),
        };
        stubClient(client);
        const warn = vi.spyOn(app.log, "warn");
        const info = vi.spyOn(app.log, "info");
        const url = `/api/projects/git-diff-stats?sessionIds=${sessionId}`;

        for (let i = 0; i < 3; i++) {
          expect((await app.inject({ method: "GET", url })).json()).toEqual({});
        }
        expect(count(warn, MSG_DIFF_STATS)).toBe(1);

        client.resolveGitDiffStats.mockResolvedValue({ isRepo: false });
        await app.inject({ method: "GET", url });
        expect(info.mock.calls.filter(([, m]) => m === "host reachable again")).toHaveLength(1);

        // Cleared: the next outage warns immediately.
        client.resolveGitDiffStats.mockRejectedValue(
          new HostUnreachableError("ds-host", new Error("down")),
        );
        await app.inject({ method: "GET", url });
        expect(count(warn, MSG_DIFF_STATS)).toBe(2);
      } finally {
        await app.close();
      }
    });

    it("a local host never feeds the throttle", async () => {
      const app = await buildApp();
      try {
        const projectId = app.db
          .insert(projects)
          .values({ name: "ds-local", cwd: os.tmpdir() })
          .returning({ id: projects.id })
          .get().id;
        const sessionId = app.db
          .insert(sessions)
          .values({ projectId, command: "bash", status: "active", cwd: os.tmpdir() })
          .returning({ id: sessions.id })
          .get().id;
        // Prime a throttled entry for the local id: a stray ok(LOCAL) would clear it.
        const log = { warn: vi.fn(), info: vi.fn() };
        warnHostThrottled(log, LOCAL_HOST_ID, {}, MSG_DIFF_STATS);
        const info = vi.spyOn(app.log, "info");
        const warn = vi.spyOn(app.log, "warn");

        await app.inject({
          method: "GET",
          url: `/api/projects/git-diff-stats?sessionIds=${sessionId}`,
        });

        expect(info.mock.calls.filter(([, m]) => m === "host reachable again")).toHaveLength(0);
        expect(count(warn, MSG_DIFF_STATS)).toBe(0);
        // Entry survived: a repeat is still suppressed.
        expect(warnHostThrottled(log, LOCAL_HOST_ID, {}, MSG_DIFF_STATS)).toBe(false);
      } finally {
        await app.close();
      }
    });
  });

  describe("GET /api/projects/git-refs", () => {
    it("logs once then suppresses; a success clears the throttle", async () => {
      const app = await buildApp();
      try {
        const { projectId } = await seedRemote(app, "refs-host");
        const client: Client = {
          resolveGitBranches: vi
            .fn()
            .mockRejectedValue(new HostUnreachableError("refs-host", new Error("down"))),
        };
        stubClient(client);
        const warn = vi.spyOn(app.log, "warn");
        const info = vi.spyOn(app.log, "info");
        const url = `/api/projects/git-refs?ids=${projectId}`;

        for (let i = 0; i < 3; i++) await app.inject({ method: "GET", url });
        expect(count(warn, MSG_REFS)).toBe(1);

        client.resolveGitBranches.mockResolvedValue(null);
        await app.inject({ method: "GET", url });
        expect(info.mock.calls.filter(([, m]) => m === "host reachable again")).toHaveLength(1);

        client.resolveGitBranches.mockRejectedValue(
          new HostUnreachableError("refs-host", new Error("down")),
        );
        await app.inject({ method: "GET", url });
        expect(count(warn, MSG_REFS)).toBe(2);
      } finally {
        await app.close();
      }
    });

    it("a local project never feeds the throttle", async () => {
      const app = await buildApp();
      try {
        const projectId = app.db
          .insert(projects)
          .values({ name: "refs-local", cwd: os.tmpdir() })
          .returning({ id: projects.id })
          .get().id;
        const log = { warn: vi.fn(), info: vi.fn() };
        warnHostThrottled(log, LOCAL_HOST_ID, {}, MSG_REFS);
        const info = vi.spyOn(app.log, "info");

        await app.inject({ method: "GET", url: `/api/projects/git-refs?ids=${projectId}` });

        expect(info.mock.calls.filter(([, m]) => m === "host reachable again")).toHaveLength(0);
        expect(warnHostThrottled(log, LOCAL_HOST_ID, {}, MSG_REFS)).toBe(false);
      } finally {
        await app.close();
      }
    });
  });

  describe("GET /api/sessions (live-status)", () => {
    it("logs once then suppresses; a success clears the throttle", async () => {
      const app = await buildApp();
      try {
        const { projectId } = await seedRemote(app, "live-host");
        const liveStatus = vi
          .fn()
          .mockRejectedValue(new HostUnreachableError("live-host", new Error("down")));
        vi.spyOn(sessionBackend, "resolveBackend").mockReturnValue({ liveStatus } as never);
        const warn = vi.spyOn(app.log, "warn");
        const info = vi.spyOn(app.log, "info");
        const url = `/api/sessions?projectId=${projectId}`;

        for (let i = 0; i < 3; i++)
          expect((await app.inject({ method: "GET", url })).statusCode).toBe(200);
        const liveWarns = warn.mock.calls.filter(
          ([f]) => (f as { hostId?: string })?.hostId === "live-host",
        );
        expect(liveWarns).toHaveLength(1);

        liveStatus.mockResolvedValue({});
        await app.inject({ method: "GET", url });
        expect(info.mock.calls.filter(([, m]) => m === "host reachable again")).toHaveLength(1);

        liveStatus.mockRejectedValue(new HostUnreachableError("live-host", new Error("down")));
        await app.inject({ method: "GET", url });
        expect(
          warn.mock.calls.filter(([f]) => (f as { hostId?: string })?.hostId === "live-host"),
        ).toHaveLength(2);
      } finally {
        await app.close();
      }
    });
  });

  it("removing a down host drops its throttle entries", async () => {
    const app = await buildApp();
    try {
      app.db
        .insert(hosts)
        .values({ id: "gone-host", name: "gone", baseUrl: "http://127.0.0.1:1" })
        .run();
      const log = { warn: vi.fn(), info: vi.fn() };
      warnHostThrottled(log, "gone-host", {}, MSG_REFS);
      // Still throttled while the host is registered.
      expect(warnHostThrottled(log, "gone-host", {}, MSG_REFS)).toBe(false);

      deleteHost(app, "gone-host");

      // Entry gone: the next warning is a first occurrence (no suppressed count).
      expect(warnHostThrottled(log, "gone-host", {}, MSG_REFS)).toBe(true);
      expect(log.warn).toHaveBeenLastCalledWith({ hostId: "gone-host" }, MSG_REFS);
    } finally {
      await app.close();
    }
  });
});
