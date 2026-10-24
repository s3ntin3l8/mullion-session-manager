import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type * as SettingsModule from "../../src/services/settings.js";

// Issue #1719 (roadmap 8.5) — a host that comes back from a suspend.
//
// A sleep severs the network WITHOUT a FIN, so the primary's sockets to that
// host are half-open: they report as open and never emit "close", which is
// the only event the reconnect loops re-arm on. The heartbeat is the one
// thing that notices the host came back — so it is the thing that has to
// force the reconnect.

const mockListHosts = vi.hoisted(() => vi.fn(() => [] as unknown[]));
const pingMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../../src/services/host-registry.js", () => ({
  LOCAL_HOST_ID: "local",
  listHosts: (...args: unknown[]) => mockListHosts(...(args as [])),
}));

vi.mock("../../src/services/remote-host-client.js", () => ({
  getRemoteHostClient: () => ({ ping: pingMock }),
}));

vi.mock("../../src/services/settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SettingsModule>();
  return {
    ...actual,
    getStoredSettings: () => ({
      ...actual.DEFAULT_SETTINGS,
      hosts: { heartbeatSeconds: 30 },
    }),
  };
});

import { HostHeartbeatTracker, startHostHeartbeat } from "../../src/services/host-heartbeat.js";
import { hostHeartbeatPlugin } from "../../src/plugins/host-heartbeat.js";

function fakeHost(id: string) {
  return {
    id,
    name: id,
    baseUrl: `http://${id}.example`,
    isLocal: false,
    hasToken: true,
    createdAt: new Date(0),
    origin: "manual" as const,
  };
}

describe("HostHeartbeatTracker: recovery detection", () => {
  it("reports a recovery only when a known-unreachable host comes back", () => {
    const tracker = new HostHeartbeatTracker();

    // A FIRST contact is not a recovery — there is no earlier unreachable
    // state, and no half-open socket that predates this entry.
    expect(tracker.recordSuccess("h1")).toBe(false);
    expect(tracker.getHealth("h1").status).toBe("online");

    // Still online — not a recovery.
    expect(tracker.recordSuccess("h1")).toBe(false);

    // Degraded (one missed ping) → online IS a recovery.
    tracker.recordFailure("h1");
    expect(tracker.getHealth("h1").status).toBe("degraded");
    expect(tracker.recordSuccess("h1")).toBe(true);

    // Offline (three missed pings) → online IS a recovery too.
    tracker.recordFailure("h1");
    tracker.recordFailure("h1");
    tracker.recordFailure("h1");
    expect(tracker.getHealth("h1").status).toBe("offline");
    expect(tracker.recordSuccess("h1")).toBe(true);
  });

  it("does not report a recovery for a host that goes straight back to online", () => {
    const tracker = new HostHeartbeatTracker();
    tracker.recordFailure("h1");
    tracker.recordSuccess("h1");
    // The transition already happened — a further success is not a new one.
    expect(tracker.recordSuccess("h1")).toBe(false);
  });
});

describe("startHostHeartbeat: onHostRecovered", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockListHosts.mockReset();
    pingMock.mockReset();
    mockListHosts.mockReturnValue([fakeHost("h1")]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls onHostRecovered when a host comes back, and not while it stays online", async () => {
    // Two misses (degraded), then a success (the host woke up).
    pingMock.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);

    const onHostRecovered = vi.fn();
    const app = {
      db: {},
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
      config: { HOST_HEARTBEAT_INTERVAL_SECONDS: 30 },
    } as unknown as FastifyInstance;

    const cleanup = startHostHeartbeat(app, undefined, onHostRecovered);
    await vi.advanceTimersByTimeAsync(0);
    expect(onHostRecovered).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000); // second miss
    expect(onHostRecovered).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000); // the host is back
    expect(onHostRecovered).toHaveBeenCalledTimes(1);
    expect(onHostRecovered).toHaveBeenCalledWith("h1");

    // Still online on the next sweep — no further recovery.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onHostRecovered).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("keeps reconciling the other hosts when one host's recovery handler throws", async () => {
    mockListHosts.mockReturnValue([fakeHost("h1"), fakeHost("h2")]);
    // Both hosts miss a ping first, so both are DEGRADED and their next
    // success is a recovery.
    pingMock.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);

    const onHostRecovered = vi.fn((hostId: string) => {
      if (hostId === "h1") throw new Error("handler exploded");
    });
    const app = {
      db: {},
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
      config: { HOST_HEARTBEAT_INTERVAL_SECONDS: 30 },
    } as unknown as FastifyInstance;

    const cleanup = startHostHeartbeat(app, undefined, onHostRecovered);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);

    // Both hosts recovered; the throwing one did not stop the other.
    expect(onHostRecovered).toHaveBeenCalledWith("h1");
    expect(onHostRecovered).toHaveBeenCalledWith("h2");
    cleanup();
  });
});

describe("hostHeartbeatPlugin: force-reconnect on recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockListHosts.mockReset();
    pingMock.mockReset();
    mockListHosts.mockReturnValue([fakeHost("h1")]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("forces a reconnect of BOTH the events subscription and the ssh-agent fan-out when a host recovers", async () => {
    pingMock.mockResolvedValueOnce(false).mockResolvedValue(true);

    const app = Fastify();
    app.decorate("config", { MULLION_ROLE: "primary" } as never);
    const reconfigureEvents = vi.fn();
    const reconfigureFanout = vi.fn();
    app.decorate("reconfigureRemoteEventSubscriptions", reconfigureEvents);
    app.decorate("reconfigureSshAgentFanout", reconfigureFanout);

    await app.register(hostHeartbeatPlugin);
    await app.ready();

    await vi.advanceTimersByTimeAsync(0); // first sweep: the host misses
    expect(reconfigureEvents).not.toHaveBeenCalled();
    expect(reconfigureFanout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000); // the host is back

    expect(reconfigureEvents).toHaveBeenCalledWith({ forceReconnect: ["h1"] });
    expect(reconfigureFanout).toHaveBeenCalledWith({ forceReconnect: ["h1"] });

    await app.close();
  });
});
