import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Issue #3427 — the project dev-server port across the hosts its dock sessions run on.
const remote = vi.hoisted(() => ({ resolveDevServerPort: vi.fn() }));
vi.mock("../../src/services/remote-host-client.js", () => ({
  getRemoteHostClient: () => remote,
}));
const local = vi.hoisted(() => ({ detect: vi.fn() }));
vi.mock("../../src/services/dev-server-detect.js", () => ({
  detectDevServerPortForSessionIds: local.detect,
}));

const { detectDevServerPortAcrossHosts, clearRemoteDevServerPortCacheForTests } =
  await import("../../src/services/dev-server-remote.js");

function fakeApp(offline: string[] = []): FastifyInstance {
  return {
    log: { warn: vi.fn() },
    hostHeartbeatTracker: {
      getHealth: (id: string) => ({ status: offline.includes(id) ? "offline" : "online" }),
    },
  } as unknown as FastifyInstance;
}

describe("detectDevServerPortAcrossHosts", () => {
  beforeEach(() => {
    clearRemoteDevServerPortCacheForTests();
    remote.resolveDevServerPort.mockReset();
    local.detect.mockReset().mockReturnValue(null);
  });

  it("is null with no sessions", async () => {
    expect(await detectDevServerPortAcrossHosts(fakeApp(), undefined)).toBeNull();
  });

  it("prefers a local session's port without asking an agent", async () => {
    local.detect.mockReturnValue("3000");
    const byHost = new Map([
      ["local", ["1"]],
      ["mac", ["2"]],
    ]);
    expect(await detectDevServerPortAcrossHosts(fakeApp(), byHost)).toBe("3000");
    expect(remote.resolveDevServerPort).not.toHaveBeenCalled();
  });

  it("asks the agent for the sessions it holds, and caches the answer for 10 s", async () => {
    remote.resolveDevServerPort.mockResolvedValue({ port: "5173" });
    const byHost = new Map([["mac", ["2", "3"]]]);
    expect(await detectDevServerPortAcrossHosts(fakeApp(), byHost)).toBe("5173");
    expect(await detectDevServerPortAcrossHosts(fakeApp(), byHost)).toBe("5173");
    expect(remote.resolveDevServerPort).toHaveBeenCalledTimes(1);
    expect(remote.resolveDevServerPort).toHaveBeenCalledWith(["2", "3"]);
  });

  it("degrades to null for an offline host, a failing agent, or an agent with no port", async () => {
    const byHost = new Map([["mac", ["2"]]]);
    expect(await detectDevServerPortAcrossHosts(fakeApp(["mac"]), byHost)).toBeNull();
    expect(remote.resolveDevServerPort).not.toHaveBeenCalled();
    remote.resolveDevServerPort.mockRejectedValue(new Error("404"));
    expect(await detectDevServerPortAcrossHosts(fakeApp(), byHost)).toBeNull();
    clearRemoteDevServerPortCacheForTests();
    remote.resolveDevServerPort.mockResolvedValue({ port: null });
    expect(await detectDevServerPortAcrossHosts(fakeApp(), byHost)).toBeNull();
  });
});
