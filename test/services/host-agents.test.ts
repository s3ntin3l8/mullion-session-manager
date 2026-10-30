import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DetectedAgent } from "../../src/services/agent-detect.js";

// Local detection and the remote client are stubbed (no login shell, no
// network), the way test/services/agent-detect.test.ts stubs child_process.
const getCachedAgents = vi.fn();
vi.mock("../../src/services/agent-detect.js", () => ({
  getCachedAgents: (...args: unknown[]) => getCachedAgents(...args),
}));
const client = { detectAgents: vi.fn(), resolveConfig: vi.fn() };
vi.mock("../../src/services/remote-host-client.js", async () => {
  class HostRequestError extends Error {
    constructor(
      public hostId: string,
      public statusCode: number,
    ) {
      super(`status ${statusCode}`);
    }
  }
  return { getRemoteHostClient: () => client, HostRequestError };
});

const {
  HostAgentTracker,
  availableAgentBins,
  isOlderVersion,
  refreshLocalAgents,
  refreshRemoteHostAgents,
} = await import("../../src/services/host-agents.js");
const { HostRequestError } = await import("../../src/services/remote-host-client.js");

function agent(bin: string, available: boolean, kind: "agent" | "shell" = "agent"): DetectedAgent {
  return {
    id: `${kind}:${bin}`,
    title: bin,
    command: bin,
    kind,
    available,
    path: available ? `/usr/bin/${bin}` : null,
    emits: [],
  };
}

function fakeApp(tracker: InstanceType<typeof HostAgentTracker> | undefined) {
  return {
    hostAgentTracker: tracker,
    config: { HOST_AGENTS_TTL_SECONDS: 600 },
    log: { debug: vi.fn(), warn: vi.fn() },
  } as unknown as FastifyInstance;
}

describe("host agent tracker (issue #2240)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps only available agents, never shells", () => {
    expect(
      availableAgentBins([
        agent("bash", true, "shell"),
        agent("claude", true),
        agent("codex", false),
      ]),
    ).toEqual(["claude"]);
  });

  it("goes stale after the TTL, and when nothing is cached", () => {
    const tracker = new HostAgentTracker();
    expect(tracker.isStale("h", 1000)).toBe(true);
    tracker.record("h", { agents: [], mullionVersion: null }, 1000);
    expect(tracker.isStale("h", 500, 1400)).toBe(false);
    expect(tracker.isStale("h", 500, 1500)).toBe(true);
    tracker.invalidateHost("h");
    expect(tracker.get("h")).toBeUndefined();
  });

  it("prunes deleted hosts but keeps the local entry", () => {
    const tracker = new HostAgentTracker();
    tracker.record("local", { agents: [], mullionVersion: "1" });
    tracker.record("gone", { agents: [], mullionVersion: "1" });
    tracker.pruneMissing(new Set(["kept"]));
    expect(tracker.get("gone")).toBeUndefined();
    expect(tracker.get("local")).toBeDefined();
  });

  it("compares dotted versions", () => {
    expect(isOlderVersion("0.3.9", "0.3.10")).toBe(true);
    expect(isOlderVersion("0.3.50", "0.3.50")).toBe(false);
    expect(isOlderVersion("1.0.0", "0.9.9")).toBe(false);
    expect(isOlderVersion("v0.3.1", "0.3.2")).toBe(true);
    expect(isOlderVersion("unknown", "0.3.2")).toBe(false);
  });

  it("fills a remote host from detectAgents() and resolveConfig().version", async () => {
    const tracker = new HostAgentTracker();
    client.detectAgents.mockResolvedValue([agent("claude", true), agent("codex", false)]);
    client.resolveConfig.mockResolvedValue({ version: "0.3.40" });
    await refreshRemoteHostAgents(fakeApp(tracker), "mac");
    expect(tracker.get("mac")).toMatchObject({ agents: ["claude"], mullionVersion: "0.3.40" });
  });

  it("records an old agent (404 on the list) as unknown, not as having none", async () => {
    const tracker = new HostAgentTracker();
    client.detectAgents.mockRejectedValue(new HostRequestError("mac", 404, ""));
    client.resolveConfig.mockResolvedValue({ version: "0.2.0" });
    await refreshRemoteHostAgents(fakeApp(tracker), "mac");
    expect(tracker.get("mac")).toMatchObject({ agents: null, mullionVersion: "0.2.0" });
  });

  it("keeps the previous entry when the host is unreachable, and survives a version failure", async () => {
    const tracker = new HostAgentTracker();
    tracker.record("mac", { agents: ["claude"], mullionVersion: "0.3.40" });
    client.detectAgents.mockRejectedValue(new HostRequestError("mac", 502, ""));
    await expect(refreshRemoteHostAgents(fakeApp(tracker), "mac")).rejects.toThrow();
    expect(tracker.get("mac")?.agents).toEqual(["claude"]);

    client.detectAgents.mockResolvedValue([agent("codex", true)]);
    client.resolveConfig.mockRejectedValue(new Error("down"));
    await refreshRemoteHostAgents(fakeApp(tracker), "mac");
    expect(tracker.get("mac")).toMatchObject({ agents: ["codex"], mullionVersion: null });
  });

  it("does not stack a second refresh on a host that is still being read", async () => {
    const tracker = new HostAgentTracker();
    let release!: () => void;
    client.detectAgents.mockReturnValue(
      new Promise<DetectedAgent[]>((r) => (release = () => r([]))),
    );
    client.resolveConfig.mockResolvedValue({ version: "1" });
    const first = refreshRemoteHostAgents(fakeApp(tracker), "mac");
    await refreshRemoteHostAgents(fakeApp(tracker), "mac");
    expect(client.detectAgents).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(tracker.refreshing.has("mac")).toBe(false);
  });

  it("does nothing without a tracker (an agent process)", async () => {
    await refreshRemoteHostAgents(fakeApp(undefined), "mac");
    refreshLocalAgents(fakeApp(undefined));
    expect(client.detectAgents).not.toHaveBeenCalled();
    expect(getCachedAgents).not.toHaveBeenCalled();
  });

  it("fills the local host from getCachedAgents() once, then within the TTL", async () => {
    const tracker = new HostAgentTracker();
    const app = fakeApp(tracker);
    getCachedAgents.mockResolvedValue([agent("claude", true)]);
    refreshLocalAgents(app);
    await vi.waitFor(() => expect(tracker.get("local")?.agents).toEqual(["claude"]));
    refreshLocalAgents(app);
    expect(getCachedAgents).toHaveBeenCalledTimes(1);
  });

  it("leaves the local host unknown when detection fails", async () => {
    const tracker = new HostAgentTracker();
    getCachedAgents.mockRejectedValue(new Error("no shell"));
    refreshLocalAgents(fakeApp(tracker));
    await vi.waitFor(() => expect(getCachedAgents).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(tracker.get("local")).toBeUndefined();
  });
});
