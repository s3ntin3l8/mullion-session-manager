import { describe, it, expect, vi, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type * as SettingsModule from "../../src/services/settings.js";

const mockListHosts = vi.hoisted(() => vi.fn(() => []));
const storedHeartbeat = vi.hoisted(() => ({ seconds: -1 }));

vi.mock("../../src/services/host-registry.js", () => ({
  LOCAL_HOST_ID: "local",
  listHosts: mockListHosts,
}));

vi.mock("../../src/services/settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SettingsModule>();
  return {
    ...actual,
    getStoredSettings: () => ({
      ...actual.DEFAULT_SETTINGS,
      hosts: { heartbeatSeconds: storedHeartbeat.seconds },
    }),
  };
});

import { startHostHeartbeat } from "../../src/services/host-heartbeat.js";

function mockApp(): FastifyInstance {
  return {
    db: {},
    log: { error: vi.fn(), warn: vi.fn() },
    config: { HOST_HEARTBEAT_INTERVAL_SECONDS: 30 },
  } as unknown as FastifyInstance;
}

describe("startHostHeartbeat: settings-driven interval", () => {
  afterEach(() => {
    vi.useRealTimers();
    mockListHosts.mockClear();
    storedHeartbeat.seconds = -1;
  });

  it("uses the env interval when the setting inherits", async () => {
    vi.useFakeTimers();
    const app = mockApp();
    const cleanup = startHostHeartbeat(app);
    expect(mockListHosts).toHaveBeenCalledTimes(1); // immediate first sweep
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockListHosts).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("does not start at all when the saved setting is 0", () => {
    vi.useFakeTimers();
    storedHeartbeat.seconds = 0;
    const app = mockApp();
    const cleanup = startHostHeartbeat(app);
    vi.advanceTimersByTime(120_000);
    expect(mockListHosts).not.toHaveBeenCalled();
    cleanup();
  });

  it("re-arms at a new interval, and stops on 0, via reconfigureHostHeartbeat", async () => {
    vi.useFakeTimers();
    const app = mockApp();
    const cleanup = startHostHeartbeat(app);
    await vi.advanceTimersByTimeAsync(0);
    mockListHosts.mockClear();

    app.reconfigureHostHeartbeat?.(5);
    expect(mockListHosts).toHaveBeenCalledTimes(1); // immediate sweep on re-arm
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockListHosts).toHaveBeenCalledTimes(2);

    app.hostHeartbeatTracker?.recordSuccess("h1");
    expect(app.hostHeartbeatTracker?.getHealth("h1").status).toBe("online");

    app.reconfigureHostHeartbeat?.(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockListHosts).toHaveBeenCalledTimes(2);
    // Nothing checks the host any more, so it must not keep reading online.
    expect(app.hostHeartbeatTracker?.getHealth("h1").status).toBe("pending");

    cleanup();
    expect(app.reconfigureHostHeartbeat).toBeUndefined();
  });
});
