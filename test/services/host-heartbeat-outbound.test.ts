import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type * as SettingsModule from "../../src/services/settings.js";

const listHosts = vi.hoisted(() => vi.fn());
const probe = vi.hoisted(() => vi.fn(async (_hostId: string) => "down" as const));

vi.mock("../../src/services/host-registry.js", () => ({
  LOCAL_HOST_ID: "local",
  listHosts,
}));

vi.mock("../../src/services/remote-host-client.js", () => ({
  getRemoteHostClient: (_app: unknown, hostId: string) => ({ probe: () => probe(hostId) }),
}));

vi.mock("../../src/services/settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SettingsModule>();
  return { ...actual, getStoredSettings: () => actual.DEFAULT_SETTINGS };
});

import { HostHeartbeatTracker, startHostHeartbeat } from "../../src/services/host-heartbeat.js";

describe("outbound host heartbeat after a primary restart (#3183)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("probes previously seen identity hosts without a connected channel while new hosts stay pending", async () => {
    vi.useFakeTimers();
    listHosts.mockReturnValue([
      { id: "seen", baseUrl: null, hasMachineIdentity: true, lastSeenAt: new Date(0) },
      { id: "new", baseUrl: null, hasMachineIdentity: true, lastSeenAt: null },
      { id: "unregistered", baseUrl: null, hasMachineIdentity: false, lastSeenAt: new Date(0) },
    ]);
    const app = {
      log: { error: vi.fn(), warn: vi.fn() },
      config: { HOST_HEARTBEAT_INTERVAL_SECONDS: 30 },
      agentChannels: new Map(),
    } as unknown as FastifyInstance;
    const tracker = new HostHeartbeatTracker();
    expect(tracker.getHealth("seen").status).toBe("pending");

    const cleanup = startHostHeartbeat(app, tracker);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(probe).toHaveBeenCalledExactlyOnceWith("seen");
      expect(tracker.getHealth("seen").status).toBe("degraded");

      await vi.advanceTimersByTimeAsync(60_000);
      expect(probe).toHaveBeenCalledTimes(3);
      expect(tracker.getHealth("seen").status).toBe("offline");
      expect(tracker.getHealth("new").status).toBe("pending");
      expect(tracker.getHealth("unregistered").status).toBe("pending");
      expect(probe.mock.calls.every(([hostId]) => hostId === "seen")).toBe(true);
    } finally {
      cleanup();
    }
  });
});
