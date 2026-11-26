import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as RemoteHostClientModule from "../../src/services/remote-host-client.js";
import type { HostProbeResult } from "../../src/services/host-heartbeat.js";

// Issue #3515 — an outbound-only agent (no baseUrl) that is marked offline by
// a deregister and then reconnects must read `online` after the next sweep, and
// Settings' Test must record what it finds. The probe is the one seam faked
// here: everything from the sweep timer to GET /api/hosts is the real app.

type Probe = () => Promise<HostProbeResult>;
const probes = vi.hoisted(() => new Map<string, Probe>());
const probeCalls = vi.hoisted(() => new Map<string, number>());
const capacityHangs = vi.hoisted(() => new Set<string>());

vi.mock("../../src/services/remote-host-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteHostClientModule>();
  return {
    ...actual,
    getRemoteHostClient: (app: Parameters<typeof actual.getRemoteHostClient>[0], id: string) => {
      const probe = probes.get(id);
      if (!probe) return actual.getRemoteHostClient(app, id);
      return {
        probe: () => {
          probeCalls.set(id, (probeCalls.get(id) ?? 0) + 1);
          return probe();
        },
        resolveCapacity: () =>
          capacityHangs.has(id) ? new Promise(() => undefined) : Promise.resolve(null),
      } as unknown as ReturnType<typeof actual.getRemoteHostClient>;
    },
  };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { heartbeatCapacityDeadlineMs, heartbeatProbeDeadlineMs } =
  await import("../../src/services/remote-host-client-core.js");

const tmpDb = path.join(os.tmpdir(), `hosts-health-reconnect-${process.pid}.db`);
const SECRET = "reconnect-secret"; // pragma: allowlist secret
const never = () => new Promise<HostProbeResult>(() => undefined);

describe("host health after a deregister and a reconnect (#3515)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_ENROLLMENT_SECRET = SECRET;
    process.env.MULLION_ENROLLMENT_AUTO_APPROVE_CIDRS = "127.0.0.1/32";
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_ENROLLMENT_SECRET;
    delete process.env.MULLION_ENROLLMENT_AUTO_APPROVE_CIDRS;
  });
  afterEach(() => {
    // Stops the fake-timer sweep before the real timers come back.
    app.reconfigureHostHeartbeat?.(0);
    vi.useRealTimers();
    for (const id of probes.keys()) app.agentChannels.delete(id);
    probes.clear();
    probeCalls.clear();
    capacityHangs.clear();
  });

  /** An outbound-only agent: a machine identity and no address. */
  async function registerOutboundAgent(hostname: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/register",
      payload: { token: SECRET, hostname, wantsMachineCredential: true },
    });
    expect(res.statusCode).toBe(200);
    const registered = res.json() as { host_id: string; session_id: string };
    connectChannel(registered.host_id);
    return registered;
  }

  /** The agent's outbound channel is up (the sweep probes an outbound host over it). */
  function connectChannel(hostId: string) {
    app.agentChannels.set(hostId, {
      hostId,
      connectedAt: Date.now(),
      carriedOperations: [],
    } as unknown as Parameters<typeof app.agentChannels.set>[1]);
  }

  async function healthOf(hostId: string): Promise<string | undefined> {
    const res = await app.inject({ method: "GET", url: "/api/hosts" });
    return (res.json() as Array<{ id: string; health: string }>).find((h) => h.id === hostId)
      ?.health;
  }

  /** Re-arms the real sweep on fake timers (arm() runs one sweep at once). */
  function startSweepOnFakeTimers() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    app.reconfigureHostHeartbeat!(30);
  }

  it("reads online after the next sweep, even when a probe in flight at the shutdown never settles", async () => {
    const { host_id: hostId, session_id: sessionId } = await registerOutboundAgent("mac");
    let probe: Probe = async () => "ok";
    probes.set(hostId, () => probe());
    startSweepOnFakeTimers();
    await vi.advanceTimersByTimeAsync(0);
    expect(await healthOf(hostId)).toBe("online");

    // The agent shuts down gracefully: deregister marks it offline at once,
    // and the probe of the sweep running at that moment never answers (the
    // channel it rode was closed under it).
    probe = never;
    await vi.advanceTimersByTimeAsync(29_000);
    const dereg = await app.inject({
      method: "POST",
      url: "/api/internal/deregister",
      payload: { hostId, sessionId },
    });
    expect(dereg.statusCode).toBe(204);
    expect(await healthOf(hostId)).toBe("offline");
    await vi.advanceTimersByTimeAsync(1_000);

    // It reconnects (the channel comes back): its probe answers again.
    app.agentChannels.delete(hostId);
    connectChannel(hostId);
    // The hung turn is bounded, so a later sweep reaches the host and records
    // the success.
    probe = async () => "ok";
    await vi.advanceTimersByTimeAsync(heartbeatProbeDeadlineMs() + 30_000);
    expect(await healthOf(hostId)).toBe("online");
  });

  it("keeps another host's health current while one host's probe never settles", async () => {
    const { host_id: stuck } = await registerOutboundAgent("stuck");
    const { host_id: other } = await registerOutboundAgent("other");
    probes.set(stuck, never);
    let otherProbe: HostProbeResult = "ok";
    probes.set(other, async () => otherProbe);
    startSweepOnFakeTimers();
    await vi.advanceTimersByTimeAsync(0);
    expect(await healthOf(other)).toBe("online");

    otherProbe = "down";
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await healthOf(other)).toBe("offline");
    // The stuck host's turns time out and count as misses.
    expect(await healthOf(stuck)).toBe("offline");
  });

  it("records Settings' Test result, so Test and placement agree", async () => {
    const { host_id: hostId, session_id: sessionId } = await registerOutboundAgent("tested");
    let result: HostProbeResult = "ok";
    probes.set(hostId, async () => result);
    startSweepOnFakeTimers();
    await vi.advanceTimersByTimeAsync(0);
    await app.inject({
      method: "POST",
      url: "/api/internal/deregister",
      payload: { hostId, sessionId },
    });
    expect(await healthOf(hostId)).toBe("offline");

    // A successful Test brings the host back without waiting on a sweep.
    let res = await app.inject({ method: "POST", url: `/api/hosts/${hostId}/ping` });
    expect(res.json()).toEqual({ online: true });
    expect(await healthOf(hostId)).toBe("online");

    // A failed one counts as a miss.
    result = "down";
    res = await app.inject({ method: "POST", url: `/api/hosts/${hostId}/ping` });
    expect(res.json()).toEqual({ online: false });
    expect(await healthOf(hostId)).toBe("degraded");

    // More failed clicks are not more sweep ticks: they never escalate it.
    await app.inject({ method: "POST", url: `/api/hosts/${hostId}/ping` });
    await app.inject({ method: "POST", url: `/api/hosts/${hostId}/ping` });
    expect(await healthOf(hostId)).toBe("degraded");

    // Busy keeps the previous verdict, and Test answers with that verdict
    // rather than "online": the two never disagree.
    app.hostHeartbeatTracker!.markOffline(hostId);
    result = "busy";
    res = await app.inject({ method: "POST", url: `/api/hosts/${hostId}/ping` });
    expect(res.json()).toEqual({ online: false });
    expect(await healthOf(hostId)).toBe("offline");
  });

  it("drops a sweep answer that is older than a verdict Test recorded meanwhile", async () => {
    const { host_id: hostId } = await registerOutboundAgent("raced");
    let answer!: (r: HostProbeResult) => void;
    let sweepProbe = true;
    probes.set(hostId, () =>
      sweepProbe ? new Promise<HostProbeResult>((r) => (answer = r)) : Promise.resolve("ok"),
    );
    startSweepOnFakeTimers();
    await vi.advanceTimersByTimeAsync(0);

    // While the sweep's probe is out, Test reaches the host.
    sweepProbe = false;
    const res = await app.inject({ method: "POST", url: `/api/hosts/${hostId}/ping` });
    expect(res.json()).toEqual({ online: true });

    // The sweep's probe then fails: an answer from before Test's, so dropped.
    answer("down");
    await vi.advanceTimersByTimeAsync(0);
    expect(await healthOf(hostId)).toBe("online");
  });

  it("bounds a capacity read that never settles without touching the verdict", async () => {
    const { host_id: hostId } = await registerOutboundAgent("slow-capacity");
    probes.set(hostId, async () => "ok");
    capacityHangs.add(hostId);
    startSweepOnFakeTimers();
    await vi.advanceTimersByTimeAsync(0);
    expect(await healthOf(hostId)).toBe("online");
    // Past the capacity deadline the turn ends, and the next tick probes again.
    const calls = probeCalls.get(hostId) ?? 0;
    await vi.advanceTimersByTimeAsync(heartbeatCapacityDeadlineMs() + 30_000);
    expect(probeCalls.get(hostId)).toBeGreaterThan(calls);
    expect(await healthOf(hostId)).toBe("online");
  });

  it("bounds a Test whose probe never settles, answering offline", async () => {
    const { host_id: hostId } = await registerOutboundAgent("wedged");
    probes.set(hostId, async () => "ok");
    startSweepOnFakeTimers();
    await vi.advanceTimersByTimeAsync(0);
    probes.set(hostId, never);
    const pending = app.inject({ method: "POST", url: `/api/hosts/${hostId}/ping` });
    await vi.advanceTimersByTimeAsync(heartbeatProbeDeadlineMs());
    expect((await pending).json()).toEqual({ online: false });
    expect(await healthOf(hostId)).toBe("degraded");
  });

  it("records nothing from Test while the heartbeat is off", async () => {
    const { host_id: hostId } = await registerOutboundAgent("idle");
    probes.set(hostId, async () => "ok");
    app.reconfigureHostHeartbeat!(0);
    const res = await app.inject({ method: "POST", url: `/api/hosts/${hostId}/ping` });
    expect(res.json()).toEqual({ online: true });
    expect(await healthOf(hostId)).toBe("pending");
  });
});
