import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DetectedAgent } from "../../src/services/agent-detect.js";

// Local detection and the remote client are stubbed (no login shell, no
// network), the way test/services/agent-detect.test.ts stubs child_process.
const getCachedAgents = vi.fn();
const getCachedCapabilities = vi.fn();
vi.mock("../../src/services/host-capabilities.js", () => ({
  getCachedCapabilities: (...args: unknown[]) => getCachedCapabilities(...args),
}));
vi.mock("../../src/services/agent-detect.js", () => ({
  getCachedAgents: (...args: unknown[]) => getCachedAgents(...args),
}));
const client = {
  detectAgents: vi.fn(),
  detectCapabilities: vi.fn(),
  resolveConfig: vi.fn(),
  detectProtocol: vi.fn(),
};
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
  hostLaunchOptions,
  gateLaunchOptions,
  gateOperation,
  hostSupports,
  PROTOCOL_READ_TIMEOUT_MS,
  PROTOCOL_READ_FAILURE_TTL_MS,
  protocolStatus,
  refreshHostProtocolSoon,
  refreshLocalAgents,
  refreshRemoteHostAgents,
  requireLaunchOptions,
  requireOperation,
  unsupportedOperation,
  ensureHostProtocol,
  ensureRemoteHostProtocols,
} = await import("../../src/services/host-agents.js");
const { HostHeartbeatTracker } = await import("../../src/services/host-heartbeat.js");
const { HostRequestError } = await import("../../src/services/remote-host-client.js");
const { AGENT_OPERATIONS, LEGACY_BASELINE, PROTOCOL_VERSION } =
  await import("../../src/shared/agent-protocol.js");

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

// This suite tests the unread/legacy behaviour itself (test/helpers/default-host-protocol.ts).
process.env.MULLION_TEST_REAL_PROTOCOL = "1";

function fakeApp(
  tracker: InstanceType<typeof HostAgentTracker> | undefined,
  heartbeatTracker?: InstanceType<typeof HostHeartbeatTracker>,
  hostRows?: Array<{ id: string; drained?: boolean; platform?: string }>,
) {
  return {
    hostAgentTracker: tracker,
    hostHeartbeatTracker: heartbeatTracker,
    db: {
      select: () => ({
        from: () => ({
          all: () =>
            (hostRows ?? []).map((h) => ({
              id: h.id,
              drained: h.drained ?? false,
              platform: h.platform ?? null,
            })),
        }),
      }),
    },
    config: { HOST_AGENTS_TTL_SECONDS: 600 },
    log: { debug: vi.fn(), warn: vi.fn() },
  } as unknown as FastifyInstance;
}

describe("host agent tracker (issue #2240)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.detectCapabilities.mockResolvedValue({ capabilities: [] });
    getCachedCapabilities.mockResolvedValue([]);
  });

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
    tracker.record("h", { agents: [], capabilities: null, mullionVersion: null }, 1000);
    expect(tracker.isStale("h", 500, 1400)).toBe(false);
    expect(tracker.isStale("h", 500, 1500)).toBe(true);
    tracker.invalidateHost("h");
    expect(tracker.get("h")).toBeUndefined();
  });

  it("prunes deleted hosts but keeps the local entry", () => {
    const tracker = new HostAgentTracker();
    tracker.record("local", { agents: [], capabilities: null, mullionVersion: "1" });
    tracker.record("gone", { agents: [], capabilities: null, mullionVersion: "1" });
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
    expect(tracker.get("mac")).toMatchObject({
      agents: ["claude"],
      capabilities: [],
      mullionVersion: "0.3.40",
    });
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
    tracker.record("mac", { agents: ["claude"], capabilities: null, mullionVersion: "0.3.40" });
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

  it("drops a read that raced with a credential change", async () => {
    const tracker = new HostAgentTracker();
    let release!: () => void;
    client.detectAgents.mockReturnValue(
      new Promise<DetectedAgent[]>((r) => (release = () => r([agent("claude", true)]))),
    );
    client.resolveConfig.mockResolvedValue({ version: "1" });
    const pending = refreshRemoteHostAgents(fakeApp(tracker), "mac");
    tracker.invalidateHost("mac");
    release();
    await pending;
    expect(tracker.get("mac")).toBeUndefined();
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

  it("records a remote host's capabilities beside its agents", async () => {
    const tracker = new HostAgentTracker();
    client.detectAgents.mockResolvedValue([agent("claude", true)]);
    client.detectCapabilities.mockResolvedValue({ capabilities: ["xcode"] });
    client.resolveConfig.mockResolvedValue({ version: "1" });
    await refreshRemoteHostAgents(fakeApp(tracker), "mac");
    expect(tracker.get("mac")).toMatchObject({ agents: ["claude"], capabilities: ["xcode"] });
  });

  it("records an older agent (404 on capabilities) as unknown and keeps its agents", async () => {
    const tracker = new HostAgentTracker();
    client.detectAgents.mockResolvedValue([agent("claude", true)]);
    client.detectCapabilities.mockRejectedValue(new HostRequestError("mac", 404, ""));
    client.resolveConfig.mockResolvedValue({ version: "1" });
    await refreshRemoteHostAgents(fakeApp(tracker), "mac");
    expect(tracker.get("mac")).toMatchObject({ agents: ["claude"], capabilities: null });
  });

  it("keeps the previous capabilities when a later read fails (not a 404)", async () => {
    const tracker = new HostAgentTracker();
    tracker.record("mac", { agents: [], capabilities: ["xcode"], mullionVersion: null });
    client.detectAgents.mockResolvedValue([agent("claude", true)]);
    client.detectCapabilities.mockRejectedValue(new HostRequestError("mac", 502, ""));
    client.resolveConfig.mockResolvedValue({ version: "1" });
    await refreshRemoteHostAgents(fakeApp(tracker), "mac");
    expect(tracker.get("mac")).toMatchObject({ agents: ["claude"], capabilities: ["xcode"] });
  });

  it("keeps the agent list when the capabilities read fails", async () => {
    const tracker = new HostAgentTracker();
    client.detectAgents.mockResolvedValue([agent("codex", true)]);
    client.detectCapabilities.mockRejectedValue(new Error("boom"));
    client.resolveConfig.mockResolvedValue({ version: "1" });
    await refreshRemoteHostAgents(fakeApp(tracker), "mac");
    expect(tracker.get("mac")).toMatchObject({ agents: ["codex"], capabilities: null });
  });

  it("fills the local host's capabilities, and keeps its agents if that fails", async () => {
    const tracker = new HostAgentTracker();
    getCachedAgents.mockResolvedValue([agent("claude", true)]);
    getCachedCapabilities.mockResolvedValue(["android-emulator"]);
    refreshLocalAgents(fakeApp(tracker));
    await vi.waitFor(() =>
      expect(tracker.get("local")).toMatchObject({
        agents: ["claude"],
        capabilities: ["android-emulator"],
      }),
    );

    const failing = new HostAgentTracker();
    getCachedCapabilities.mockRejectedValue(new Error("probe"));
    refreshLocalAgents(fakeApp(failing));
    await vi.waitFor(() =>
      expect(failing.get("local")).toMatchObject({ agents: ["claude"], capabilities: null }),
    );
  });
});

describe("protocol negotiation (issue #2248)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.detectAgents.mockResolvedValue([]);
    client.detectCapabilities.mockResolvedValue({ capabilities: [] });
    client.resolveConfig.mockResolvedValue({ version: "0.3.1" });
  });

  it("negotiates independently of the release version", async () => {
    const tracker = new HostAgentTracker();
    const app = fakeApp(tracker);
    // A different release than the primary, same protocol, a subset of operations.
    client.resolveConfig.mockResolvedValue({ version: "0.1.0" });
    client.detectProtocol.mockResolvedValue({
      protocolVersion: PROTOCOL_VERSION,
      operations: ["sessions", "git"],
      launchOptions: ["env"],
    });
    await refreshRemoteHostAgents(app, "mac");
    expect(hostSupports(app, "mac", "git")).toBe(true);
    expect(hostSupports(app, "mac", "browser")).toBe(false);
    expect(hostLaunchOptions(app, "mac")).toEqual(["env"]);
    const status = protocolStatus(tracker.get("mac")?.protocol);
    expect(status).toMatchObject({ incompatible: false, legacy: false });
    expect(status?.missingOperations).toContain("browser");
    expect(status?.missingOperations).not.toContain("git");
  });

  it("flags a protocol outside the supported range as incompatible", async () => {
    const tracker = new HostAgentTracker();
    client.detectProtocol.mockResolvedValue({
      protocolVersion: PROTOCOL_VERSION + 1,
      operations: [...AGENT_OPERATIONS],
      launchOptions: [],
    });
    await refreshRemoteHostAgents(fakeApp(tracker), "mac");
    expect(protocolStatus(tracker.get("mac")?.protocol)).toMatchObject({
      incompatible: true,
      protocolVersion: PROTOCOL_VERSION + 1,
    });
  });

  it("maps a 404 to the legacy baseline", async () => {
    const tracker = new HostAgentTracker();
    const app = fakeApp(tracker);
    client.detectProtocol.mockRejectedValue(new HostRequestError("old", 404, ""));
    await refreshRemoteHostAgents(app, "old");
    expect(tracker.get("old")?.protocol).toMatchObject({ legacy: true });
    expect(hostSupports(app, "old", "sessions")).toBe(true);
    expect(hostSupports(app, "old", "updates")).toBe(false);
    expect(hostLaunchOptions(app, "old")).toEqual(LEGACY_BASELINE.launchOptions);
    expect(protocolStatus(tracker.get("old")?.protocol)).toMatchObject({
      legacy: true,
      protocolVersion: null,
      incompatible: false,
    });
  });

  it("treats an unnegotiated host as the legacy baseline, and keeps a reading on a transient failure", async () => {
    const tracker = new HostAgentTracker();
    const app = fakeApp(tracker);
    expect(hostSupports(app, "mac", "sessions")).toBe(true);
    expect(hostSupports(app, "mac", "updates")).toBe(false);
    expect(hostLaunchOptions(app, "mac")).toEqual(LEGACY_BASELINE.launchOptions);
    expect(protocolStatus(null)).toBeNull();
    client.detectProtocol.mockResolvedValue({
      protocolVersion: 1,
      operations: ["git"],
      launchOptions: [],
    });
    await refreshRemoteHostAgents(app, "mac");
    client.detectProtocol.mockRejectedValue(new HostRequestError("mac", 502, ""));
    await refreshRemoteHostAgents(app, "mac");
    expect(hostSupports(app, "mac", "git")).toBe(true);
  });

  it("reads the local host from this build's registry", () => {
    const app = fakeApp(new HostAgentTracker());
    expect(hostSupports(app, "local", "updates")).toBe(true);
    expect(hostLaunchOptions(app, "local")).toContain("skipPermissions");
  });

  it("drops the reading on URL/credential change and re-reads after an update", async () => {
    const tracker = new HostAgentTracker();
    const app = fakeApp(tracker);
    client.detectProtocol.mockResolvedValue({
      protocolVersion: 1,
      operations: ["git"],
      launchOptions: [],
    });
    await refreshRemoteHostAgents(app, "mac");
    tracker.invalidateHost("mac");
    expect(tracker.get("mac")).toBeUndefined();

    // A read that began before the credential change must not record.
    let release!: () => void;
    client.detectProtocol.mockReturnValue(
      new Promise(
        (r) => (release = () => r({ protocolVersion: 1, operations: [], launchOptions: [] })),
      ),
    );
    const inFlight = refreshRemoteHostAgents(app, "mac");
    tracker.invalidateHost("mac");
    release();
    await inFlight;
    expect(tracker.get("mac")).toBeUndefined();

    // After an update: stale immediately, then refreshed to the new build.
    client.detectProtocol.mockResolvedValue({
      protocolVersion: 1,
      operations: ["git"],
      launchOptions: [],
    });
    await refreshRemoteHostAgents(app, "mac");
    client.detectProtocol.mockResolvedValue({
      protocolVersion: 1,
      operations: ["git", "browser"],
      launchOptions: [],
    });
    refreshHostProtocolSoon(app, "mac");
    // The last known reading is still served while the refresh is pending.
    expect(tracker.get("mac")?.protocol).toMatchObject({ operations: ["git"] });
    expect(tracker.get("mac")?.protocolStale).toBe(true);
    expect(tracker.isStale("mac", 60_000)).toBe(true);
    await vi.waitFor(() => expect(hostSupports(app, "mac", "browser")).toBe(true));
  });
});

describe("requireOperation / requireLaunchOptions (issue #2569)", () => {
  function appWith(protocol: Record<string, unknown> | null) {
    const tracker = new HostAgentTracker();
    tracker.record("peer", {
      agents: null,
      capabilities: null,
      mullionVersion: null,
      protocol: protocol as never,
    });
    return fakeApp(tracker);
  }
  const current = {
    protocolVersion: PROTOCOL_VERSION,
    legacy: false,
    operations: ["sessions", "git"],
    launchOptions: ["env", "model"],
  };

  it("passes the local host, an un-negotiated host and a supported operation", () => {
    expect(requireOperation(appWith(null), "local", "browser")).toEqual({ ok: true });
    expect(requireOperation(appWith(current), "peer", "git")).toEqual({ ok: true });
  });

  it("reads an un-negotiated host as the legacy baseline", () => {
    expect(requireOperation(appWith(null), "peer", "sessions")).toEqual({ ok: true });
    expect(requireOperation(appWith(null), "peer", "updates")).toMatchObject({ ok: false });
  });

  it("refuses an operation the host lacks, naming it with the Update hint", () => {
    const gate = requireOperation(appWith(current), "peer", "browser");
    expect(gate).toMatchObject({ ok: false, code: "unsupported", missing: ["browser"] });
    expect(gate.ok === false && gate.updateHint).toMatch(/Update/);
    expect(gate.ok === false && gate.message).toContain("peer");
  });

  it("reads a legacy peer through the baseline and refuses every operation on an incompatible one", () => {
    const old = { ...LEGACY_BASELINE, legacy: true };
    expect(requireOperation(appWith(old), "peer", "sessions")).toEqual({ ok: true });
    expect(requireOperation(appWith(old), "peer", "updates")).toMatchObject({ ok: false });
    const future = { ...current, protocolVersion: PROTOCOL_VERSION + 1 };
    expect(requireOperation(appWith(future), "peer", "git")).toMatchObject({
      ok: false,
      message: expect.stringContaining("incompatible"),
    });
    // Update is the remedy for an incompatible protocol, so it is never blocked by one.
    expect(
      requireOperation(appWith({ ...future, operations: ["updates"] }), "peer", "updates"),
    ).toEqual({ ok: true });
  });

  it("refuses the launch options a host does not list, and only those", () => {
    const app = appWith(current);
    expect(requireLaunchOptions(app, "peer", ["env", "model"])).toEqual({ ok: true });
    expect(requireLaunchOptions(app, "peer", [])).toEqual({ ok: true });
    const gate = requireLaunchOptions(app, "peer", ["model", "gitIdentity", "githubAuth"]);
    expect(gate).toMatchObject({ ok: false, missing: ["gitIdentity", "githubAuth"] });
    expect(requireLaunchOptions(appWith(null), "peer", ["model"])).toMatchObject({
      ok: false,
      missing: ["model"],
    });
    expect(requireLaunchOptions(appWith(null), "peer", ["env"])).toEqual({ ok: true });
    expect(requireLaunchOptions(app, "local", ["model"])).toEqual({ ok: true });
  });

  it("builds the same refusal a 404 maps to", () => {
    expect(unsupportedOperation("peer", "git")).toMatchObject({
      code: "unsupported",
      missing: ["git"],
    });
  });
});

describe("bounded protocol read before a gate (issue #2596)", () => {
  const currentProtocol = {
    protocolVersion: PROTOCOL_VERSION,
    operations: ["sessions"],
    launchOptions: ["env", "model"],
  };
  beforeEach(() => {
    vi.clearAllMocks();
    client.detectAgents.mockResolvedValue([]);
    client.detectCapabilities.mockResolvedValue({ capabilities: [] });
    client.resolveConfig.mockResolvedValue({ version: "0.3.1" });
  });

  it("refuses a launch needing model on a legacy host and allows it on a current one", async () => {
    client.detectProtocol.mockRejectedValue(new HostRequestError("old", 404, ""));
    const legacy = fakeApp(new HostAgentTracker());
    expect(await gateLaunchOptions(legacy, "old", ["model"])).toMatchObject({
      ok: false,
      missing: ["model"],
    });

    client.detectProtocol.mockResolvedValue(currentProtocol);
    const current = fakeApp(new HostAgentTracker());
    expect(await gateLaunchOptions(current, "new", ["model"])).toEqual({ ok: true });
    expect(await gateOperation(current, "new", "sessions")).toEqual({ ok: true });
  });

  it("keeps a known protocol across a renewal", async () => {
    client.detectProtocol.mockResolvedValue(currentProtocol);
    const tracker = new HostAgentTracker();
    const app = fakeApp(tracker);
    await refreshRemoteHostAgents(app, "mac");
    tracker.markProtocolStale("mac");
    expect(tracker.get("mac")?.protocol).toMatchObject({ launchOptions: ["env", "model"] });
    expect(requireLaunchOptions(app, "mac", ["model"])).toEqual({ ok: true });
  });

  it("falls back to the baseline without caching when the read times out or fails", async () => {
    vi.useFakeTimers();
    try {
      client.detectAgents.mockReturnValue(new Promise(() => {}));
      const tracker = new HostAgentTracker();
      const app = fakeApp(tracker);
      const gate = gateLaunchOptions(app, "mac", ["model"]);
      await vi.advanceTimersByTimeAsync(PROTOCOL_READ_TIMEOUT_MS + 1);
      expect(await gate).toMatchObject({ ok: false, missing: ["model"] });
      expect(tracker.get("mac")).toBeUndefined();
      expect(tracker.ensuring.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }

    // A non-404 failure of the handshake: baseline for this decision, nothing cached.
    client.detectAgents.mockResolvedValue([]);
    client.detectProtocol.mockRejectedValue(new HostRequestError("mac", 502, ""));
    const tracker = new HostAgentTracker();
    const app = fakeApp(tracker);
    expect(await gateLaunchOptions(app, "mac", ["model"])).toMatchObject({ ok: false });
    expect(tracker.get("mac")?.protocol ?? null).toBeNull();
  });

  it("shares one read between concurrent gates", async () => {
    client.detectProtocol.mockResolvedValue(currentProtocol);
    const app = fakeApp(new HostAgentTracker());
    const gates = await Promise.all([
      gateLaunchOptions(app, "mac", ["model"]),
      gateLaunchOptions(app, "mac", ["model"]),
      gateOperation(app, "mac", "sessions"),
    ]);
    expect(gates).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(client.detectProtocol).toHaveBeenCalledTimes(1);
  });
});

describe("ensureRemoteHostProtocols and failure cooldown (issue #2625)", () => {
  const currentProtocol = {
    protocolVersion: PROTOCOL_VERSION,
    operations: ["sessions", "git"],
    launchOptions: ["env", "model"],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    client.detectAgents.mockResolvedValue([]);
    client.detectCapabilities.mockResolvedValue({ capabilities: [] });
    client.resolveConfig.mockResolvedValue({ version: "0.3.1" });
  });

  it("remembers failed protocol reads for 60 seconds and clears on success, renewal or online", () => {
    expect(PROTOCOL_READ_FAILURE_TTL_MS).toBe(60_000);
    const tracker = new HostAgentTracker();
    expect(tracker.hasRecentProtocolReadFailure("h1")).toBe(false);
    tracker.recordProtocolReadFailure("h1", 1000);
    expect(
      tracker.hasRecentProtocolReadFailure("h1", PROTOCOL_READ_FAILURE_TTL_MS, 1000 + 59_999),
    ).toBe(true);
    expect(
      tracker.hasRecentProtocolReadFailure("h1", PROTOCOL_READ_FAILURE_TTL_MS, 1000 + 60_000),
    ).toBe(false);

    // Stale mark (re-registration / renewal) clears it
    tracker.recordProtocolReadFailure("h1", 1000);
    tracker.markProtocolStale("h1");
    expect(tracker.hasRecentProtocolReadFailure("h1")).toBe(false);

    // Invalidation clears it
    tracker.recordProtocolReadFailure("h1", 1000);
    tracker.invalidateHost("h1");
    expect(tracker.hasRecentProtocolReadFailure("h1")).toBe(false);

    // Recording a protocol clears it
    tracker.recordProtocolReadFailure("h1", 1000);
    tracker.record("h1", {
      agents: null,
      capabilities: null,
      mullionVersion: null,
      protocol: { ...currentProtocol, legacy: false },
    });
    expect(tracker.hasRecentProtocolReadFailure("h1")).toBe(false);

    // pruneMissing prunes failure records
    tracker.recordProtocolReadFailure("h1", 1000);
    tracker.pruneMissing(new Set(["other"]));
    expect(tracker.hasRecentProtocolReadFailure("h1")).toBe(false);
  });

  it("with one unreachable host, a second Auto placement within 60 seconds does not wait", async () => {
    vi.useFakeTimers();
    try {
      client.detectAgents.mockImplementation(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new HostRequestError("unreachable-host", 504, "")), 5000);
          }),
      );
      const tracker = new HostAgentTracker();
      const heartbeatTracker = new HostHeartbeatTracker();
      const hostRows = [{ id: "unreachable-host" }];
      const app = fakeApp(tracker, heartbeatTracker, hostRows);

      // First Auto placement: ensureRemoteHostProtocols runs and waits on the bounded read
      const firstRun = ensureRemoteHostProtocols(app);
      await vi.advanceTimersByTimeAsync(PROTOCOL_READ_TIMEOUT_MS + 1);
      await firstRun;
      await vi.advanceTimersByTimeAsync(3000);

      expect(tracker.get("unreachable-host")).toBeUndefined();
      expect(tracker.hasRecentProtocolReadFailure("unreachable-host")).toBe(true);
      expect(client.detectAgents).toHaveBeenCalledTimes(1);

      // Second Auto placement 10 seconds later: skips the unreachable host without waiting
      await vi.advanceTimersByTimeAsync(10_000);
      client.detectAgents.mockClear();

      await ensureRemoteHostProtocols(app);
      expect(client.detectAgents).toHaveBeenCalledTimes(0);

      // After 60 seconds total, the cooldown expires and the next placement tries again
      await vi.advanceTimersByTimeAsync(50_000);
      const thirdRun = ensureRemoteHostProtocols(app);
      await vi.advanceTimersByTimeAsync(PROTOCOL_READ_TIMEOUT_MS + 1);
      await thirdRun;
      await vi.advanceTimersByTimeAsync(3000);
      expect(client.detectAgents).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a host the caller names is read despite a remembered failure", async () => {
    const tracker = new HostAgentTracker();
    const app = fakeApp(tracker, new HostHeartbeatTracker(), [{ id: "named-host" }]);
    tracker.recordProtocolReadFailure("named-host");

    await ensureRemoteHostProtocols(app);
    expect(client.detectAgents).toHaveBeenCalledTimes(0);

    await ensureRemoteHostProtocols(app, { target: { hostId: "named-host" } });
    expect(client.detectAgents).toHaveBeenCalledTimes(1);
  });

  it("hosts a platform target could match are read despite a remembered failure", async () => {
    const tracker = new HostAgentTracker();
    const app = fakeApp(tracker, new HostHeartbeatTracker(), [
      { id: "mac", platform: "darwin" },
      { id: "linux-box", platform: "linux" },
      { id: "unreported" },
    ]);
    for (const id of ["mac", "linux-box", "unreported"]) tracker.recordProtocolReadFailure(id);

    await ensureRemoteHostProtocols(app, { target: { platform: "Darwin" } });
    // The Mac and the host with no platform yet; not the Linux box.
    expect(client.detectAgents).toHaveBeenCalledTimes(2);
  });

  it("an offline host is not read at all", async () => {
    const tracker = new HostAgentTracker();
    const heartbeatTracker = new HostHeartbeatTracker();
    heartbeatTracker.markOffline("offline-host");
    const hostRows = [{ id: "offline-host" }];
    const app = fakeApp(tracker, heartbeatTracker, hostRows);

    await ensureRemoteHostProtocols(app);
    expect(client.detectAgents).toHaveBeenCalledTimes(0);
    expect(client.detectProtocol).toHaveBeenCalledTimes(0);
    expect(tracker.get("offline-host")).toBeUndefined();
  });

  it("a drained or parked host is not read at all", async () => {
    const tracker = new HostAgentTracker();
    const heartbeatTracker = new HostHeartbeatTracker();
    const hostRows = [{ id: "parked-host", drained: true }];
    const app = fakeApp(tracker, heartbeatTracker, hostRows);

    await ensureRemoteHostProtocols(app);
    expect(client.detectAgents).toHaveBeenCalledTimes(0);
    expect(client.detectProtocol).toHaveBeenCalledTimes(0);
    expect(tracker.get("parked-host")).toBeUndefined();
  });

  it("a host coming back online is read on the next placement", async () => {
    vi.useFakeTimers();
    try {
      client.detectAgents.mockImplementation(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new HostRequestError("peer", 504, "")), 5000);
          }),
      );
      const tracker = new HostAgentTracker();
      const heartbeatTracker = new HostHeartbeatTracker();
      heartbeatTracker.setOnOnline((id) => tracker.clearProtocolReadFailure(id));
      const hostRows = [{ id: "peer" }];
      const app = fakeApp(tracker, heartbeatTracker, hostRows);

      // Initial bounded read times out
      const firstRun = ensureRemoteHostProtocols(app);
      await vi.advanceTimersByTimeAsync(PROTOCOL_READ_TIMEOUT_MS + 1);
      await firstRun;
      await vi.advanceTimersByTimeAsync(3000);
      expect(tracker.hasRecentProtocolReadFailure("peer")).toBe(true);

      // Heartbeat sees the host online
      heartbeatTracker.recordSuccess("peer");
      expect(tracker.hasRecentProtocolReadFailure("peer")).toBe(false);

      // Next placement reads the host now that it came back online
      client.detectAgents.mockResolvedValue([]);
      client.detectProtocol.mockResolvedValue(currentProtocol);
      await ensureRemoteHostProtocols(app);

      expect(client.detectProtocol).toHaveBeenCalled();
      expect(tracker.get("peer")?.protocol).toMatchObject({ operations: ["sessions", "git"] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("an explicit launch on an unknown host still reads once", async () => {
    vi.useFakeTimers();
    try {
      client.detectAgents.mockImplementation(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new HostRequestError("peer", 504, "")), 5000);
          }),
      );
      const tracker = new HostAgentTracker();
      const heartbeatTracker = new HostHeartbeatTracker();
      const hostRows = [{ id: "peer" }];
      const app = fakeApp(tracker, heartbeatTracker, hostRows);

      // Initial placement times out, recording failure
      const placementRun = ensureRemoteHostProtocols(app);
      await vi.advanceTimersByTimeAsync(PROTOCOL_READ_TIMEOUT_MS + 1);
      await placementRun;
      await vi.advanceTimersByTimeAsync(3000);
      expect(tracker.hasRecentProtocolReadFailure("peer")).toBe(true);

      // Now an explicit launch happens targeting "peer" within the 60s window
      client.detectAgents.mockResolvedValue([]);
      client.detectProtocol.mockResolvedValue(currentProtocol);

      const gatePromise = gateLaunchOptions(app, "peer", ["model"]);
      expect(await gatePromise).toEqual({ ok: true });
      expect(client.detectProtocol).toHaveBeenCalledTimes(1);
      expect(tracker.get("peer")?.protocol).toMatchObject({ launchOptions: ["env", "model"] });
      expect(tracker.hasRecentProtocolReadFailure("peer")).toBe(false);
      expect(await ensureHostProtocol(app, "peer")).toMatchObject({
        launchOptions: ["env", "model"],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
