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
const detectAgentsMock = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const resolveConfigMock = vi.hoisted(() => vi.fn(async () => ({ version: "0.3.40" })));

vi.mock("../../src/services/host-registry.js", () => ({
  LOCAL_HOST_ID: "local",
  listHosts: (...args: unknown[]) => mockListHosts(...(args as [])),
}));

vi.mock("../../src/services/remote-host-client.js", () => ({
  // The capacity poll (issue #1721) rides on the same client; a null report
  // means "an agent build without the capacity route" and keeps the sweep
  // free of noise.
  getRemoteHostClient: () => ({
    ping: pingMock,
    resolveCapacity: async () => null,
    // Issue #2240 — the agent-CLI list rides on the same client.
    detectAgents: detectAgentsMock,
    resolveConfig: resolveConfigMock,
  }),
  HostRequestError: class HostRequestError extends Error {
    statusCode = 0;
  },
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

const pushPalette = vi.hoisted(() => vi.fn(async (_app: unknown, _hostId: string) => {}));
vi.mock("../../src/services/terminal-palette-sync.js", () => ({
  pushTerminalPaletteToHost: pushPalette,
}));

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
  it("reports a recovery only when the host had been unreachable for at least two pings", () => {
    const tracker = new HostHeartbeatTracker();

    // A FIRST contact is not a recovery — there is no earlier unreachable
    // state, and no half-open socket that predates this entry.
    expect(tracker.recordSuccess("h1")).toBe(false);
    expect(tracker.getHealth("h1").status).toBe("online");

    // Still online — not a recovery.
    expect(tracker.recordSuccess("h1")).toBe(false);

    // ONE missed ping is often one dropped packet. Tearing down a working
    // connection on that basis would penalise a healthy host for a hiccup,
    // so it is not a recovery.
    tracker.recordFailure("h1");
    expect(tracker.getHealth("h1").status).toBe("degraded");
    expect(tracker.recordSuccess("h1")).toBe(false);

    // TWO consecutive misses mean the network really was down — which is
    // what leaves a socket half-open. That IS a recovery (and the status is
    // still "degraded" at two misses; it only reaches "offline" at three).
    tracker.recordFailure("h1");
    tracker.recordFailure("h1");
    expect(tracker.getHealth("h1").status).toBe("degraded");
    expect(tracker.recordSuccess("h1")).toBe(true);

    // The transition already happened — a further success is not a new one.
    expect(tracker.recordSuccess("h1")).toBe(false);
  });

  it("reports a recovery after two misses even while the status is still degraded", () => {
    const tracker = new HostHeartbeatTracker();
    tracker.recordFailure("h1");
    tracker.recordFailure("h1");
    // Two misses is the threshold; the status only reaches "offline" at the
    // third. The recovery must not wait for the third.
    expect(tracker.getHealth("h1").status).toBe("degraded");
    expect(tracker.recordSuccess("h1")).toBe(true);
  });
});

/**
 * The sweep is fire-and-forget (startHostHeartbeat's runSweep does not await
 * it), so its promise chain — the ping, the capacity poll, the recovery
 * report — settles a few microtask turns AFTER the timer advance that
 * triggered it, and a single advance does not flush all of them.
 *
 * So advance the clock until the expectation holds (or the budget runs out),
 * which is what the assertion actually means: "the recovery is reported".
 */
async function waitForAssertion(assertion: () => void, budgetMs = 5_000): Promise<void> {
  const stepMs = 10;
  for (let waited = 0; waited <= budgetMs; waited += stepMs) {
    try {
      assertion();
      return;
    } catch {
      await vi.advanceTimersByTimeAsync(stepMs);
    }
  }
  assertion();
}

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
    // Two misses (the host was unreachable for two consecutive pings), then a
    // success — the host woke up.
    pingMock.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);

    const onHostRecovered = vi.fn();
    const app = {
      db: {},
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      config: { HOST_HEARTBEAT_INTERVAL_SECONDS: 30 },
    } as unknown as FastifyInstance;

    const cleanup = startHostHeartbeat(app, undefined, undefined, onHostRecovered);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(onHostRecovered).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000); // second miss
    await vi.advanceTimersByTimeAsync(0);
    expect(onHostRecovered).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000); // the host is back
    await waitForAssertion(() => {
      expect(onHostRecovered).toHaveBeenCalledTimes(1);
      expect(onHostRecovered).toHaveBeenCalledWith("h1");
    });

    // Still online on the next sweep — no further recovery.
    await vi.advanceTimersByTimeAsync(30_000);
    await waitForAssertion(() => expect(onHostRecovered).toHaveBeenCalledTimes(1));

    cleanup();
  });

  it("keeps reconciling the other hosts when one host's recovery handler throws", async () => {
    mockListHosts.mockReturnValue([fakeHost("h1"), fakeHost("h2")]);
    // Both hosts miss two consecutive pings, so both are due a recovery on
    // the next sweep.
    pingMock.mockResolvedValue(false);

    const onHostRecovered = vi.fn((hostId: string) => {
      if (hostId === "h1") throw new Error("handler exploded");
    });
    const app = {
      db: {},
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      config: { HOST_HEARTBEAT_INTERVAL_SECONDS: 30 },
    } as unknown as FastifyInstance;

    const cleanup = startHostHeartbeat(app, undefined, undefined, onHostRecovered);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(onHostRecovered).not.toHaveBeenCalled();

    pingMock.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(30_000);

    // Both hosts recovered; the throwing one did not stop the other.
    await waitForAssertion(() => {
      expect(onHostRecovered).toHaveBeenCalledWith("h1");
      expect(onHostRecovered).toHaveBeenCalledWith("h2");
    });
    cleanup();
  });
});

// Issue #2090 — "came online" is BROADER than "recovered": it also fires for a
// host's first contact (pending -> online), which is when "where does each
// project live on this machine?" is worth asking.
describe("startHostHeartbeat: onHostOnline", () => {
  const fakeApp = () =>
    ({
      db: {},
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      config: { HOST_HEARTBEAT_INTERVAL_SECONDS: 30 },
    }) as unknown as FastifyInstance;

  beforeEach(() => {
    vi.useFakeTimers();
    mockListHosts.mockReset();
    pingMock.mockReset();
    mockListHosts.mockReturnValue([fakeHost("h1")]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once for a first contact, not again while the host stays online", async () => {
    pingMock.mockResolvedValue(true);
    const onHostRecovered = vi.fn();
    const onHostOnline = vi.fn();

    const cleanup = startHostHeartbeat(
      fakeApp(),
      undefined,
      undefined,
      onHostRecovered,
      onHostOnline,
    );
    await waitForAssertion(() => expect(onHostOnline).toHaveBeenCalledWith("h1"));
    await vi.advanceTimersByTimeAsync(60_000);
    await waitForAssertion(() => expect(onHostOnline).toHaveBeenCalledTimes(1));

    // A first contact is not a recovery.
    expect(onHostRecovered).not.toHaveBeenCalled();
    cleanup();
  });

  it("fires again when the host comes back from being unreachable", async () => {
    pingMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    pingMock.mockResolvedValue(true);
    const onHostOnline = vi.fn();

    const cleanup = startHostHeartbeat(fakeApp(), undefined, undefined, undefined, onHostOnline);
    await waitForAssertion(() => expect(onHostOnline).toHaveBeenCalledTimes(1)); // first contact
    await vi.advanceTimersByTimeAsync(30_000); // miss 1
    await vi.advanceTimersByTimeAsync(30_000); // miss 2
    await vi.advanceTimersByTimeAsync(30_000); // back
    await waitForAssertion(() => expect(onHostOnline).toHaveBeenCalledTimes(2));
    cleanup();
  });

  it("does not fire for a single dropped ping (online -> degraded -> online is no rescan)", async () => {
    pingMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    pingMock.mockResolvedValue(true);
    const onHostOnline = vi.fn();

    const cleanup = startHostHeartbeat(fakeApp(), undefined, undefined, undefined, onHostOnline);
    await waitForAssertion(() => expect(onHostOnline).toHaveBeenCalledTimes(1)); // first contact
    await vi.advanceTimersByTimeAsync(30_000); // one miss
    await vi.advanceTimersByTimeAsync(30_000); // back
    await vi.advanceTimersByTimeAsync(60_000);

    expect(onHostOnline).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("does not fire for a host that does not answer", async () => {
    pingMock.mockResolvedValue(false);
    const onHostOnline = vi.fn();

    const cleanup = startHostHeartbeat(fakeApp(), undefined, undefined, undefined, onHostOnline);
    await vi.advanceTimersByTimeAsync(90_000);

    expect(onHostOnline).not.toHaveBeenCalled();
    cleanup();
  });

  it("keeps notifying the other hosts when one handler throws", async () => {
    mockListHosts.mockReturnValue([fakeHost("h1"), fakeHost("h2")]);
    pingMock.mockResolvedValue(true);
    const onHostOnline = vi.fn((hostId: string) => {
      if (hostId === "h1") throw new Error("handler exploded");
    });
    const app = fakeApp();

    const cleanup = startHostHeartbeat(app, undefined, undefined, undefined, onHostOnline);
    await waitForAssertion(() => {
      expect(onHostOnline).toHaveBeenCalledWith("h1");
      expect(onHostOnline).toHaveBeenCalledWith("h2");
    });
    expect(app.log.error).toHaveBeenCalled();
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
    pingMock.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);

    const app = Fastify();
    app.decorate("config", { MULLION_ROLE: "primary" } as never);
    const reconfigureEvents = vi.fn();
    const reconfigureFanout = vi.fn();
    app.decorate("reconfigureRemoteEventSubscriptions", reconfigureEvents);
    app.decorate("reconfigureSshAgentFanout", reconfigureFanout);

    await app.register(hostHeartbeatPlugin);
    await app.ready();

    await vi.advanceTimersByTimeAsync(0); // first sweep: the host misses
    await vi.advanceTimersByTimeAsync(0);
    expect(reconfigureEvents).not.toHaveBeenCalled();
    expect(reconfigureFanout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000); // second miss
    await vi.advanceTimersByTimeAsync(0);
    expect(reconfigureEvents).not.toHaveBeenCalled();
    expect(reconfigureFanout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000); // the host is back

    await waitForAssertion(() => {
      expect(reconfigureEvents).toHaveBeenCalledWith({ forceReconnect: ["h1"] });
      expect(reconfigureFanout).toHaveBeenCalledWith({ forceReconnect: ["h1"] });
    });

    await app.close();
  });

  it("pushes the terminal palette to a host that comes online and to one that recovers", async () => {
    pushPalette.mockClear();
    pingMock.mockResolvedValue(true);

    const app = Fastify();
    app.decorate("config", { MULLION_ROLE: "primary" } as never);
    await app.register(hostHeartbeatPlugin);
    await app.ready();

    await vi.advanceTimersByTimeAsync(0); // first contact: pending -> online
    await waitForAssertion(() => expect(pushPalette).toHaveBeenCalledWith(app, "h1"));

    pushPalette.mockClear();
    pingMock.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000); // the host is back
    await waitForAssertion(() => expect(pushPalette).toHaveBeenCalledWith(app, "h1"));

    await app.close();
  });
});

// Issue #2240 — the agent-CLI cache is re-read by the sweep once its TTL
// lapses (a host that just came online is filled by `onHostOnline` instead).
describe("startHostHeartbeat: agent list refresh", () => {
  const fakeApp = () =>
    ({
      db: {},
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      config: { HOST_HEARTBEAT_INTERVAL_SECONDS: 30, HOST_AGENTS_TTL_SECONDS: 600 },
    }) as unknown as FastifyInstance;

  beforeEach(() => {
    vi.useFakeTimers();
    mockListHosts.mockReset();
    pingMock.mockReset();
    detectAgentsMock.mockReset();
    mockListHosts.mockReturnValue([fakeHost("h1")]);
    pingMock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves a first contact to onHostOnline, then fills a still-empty cache on the next sweep", async () => {
    detectAgentsMock.mockResolvedValue([
      { id: "agent:claude", title: "claude", command: "claude", kind: "agent", available: true },
    ]);
    const app = fakeApp();
    const cleanup = startHostHeartbeat(app, undefined, undefined, undefined, vi.fn());
    await waitForAssertion(() => expect(pingMock).toHaveBeenCalledTimes(1));
    expect(detectAgentsMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(31_000);
    await waitForAssertion(() =>
      expect(app.hostAgentTracker?.get("h1")).toMatchObject({
        agents: ["claude"],
        mullionVersion: "0.3.40",
      }),
    );
    cleanup();
    expect(app.hostAgentTracker).toBeUndefined();
  });

  it("keeps sweeping when the refresh fails", async () => {
    detectAgentsMock.mockRejectedValue(new Error("boom"));
    const app = fakeApp();
    const cleanup = startHostHeartbeat(app, undefined, undefined, undefined, vi.fn());
    await vi.advanceTimersByTimeAsync(31_000);
    await waitForAssertion(() => expect(detectAgentsMock).toHaveBeenCalled());
    expect(app.hostAgentTracker?.get("h1")).toBeUndefined();
    expect(pingMock.mock.calls.length).toBeGreaterThan(1);
    cleanup();
  });
});
