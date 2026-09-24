import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeviceDiscoveryService } from "../../src/services/device-discovery.js";

// Issue #1378 — the mDNS scanner that surfaces nearby Android phones for
// the new "Pair a phone" modal. The real bonjour-service Browser opens a
// UDP multicast socket and reacts to live mDNS traffic — that's
// unverifiable in this suite (and would be flaky if it were). Most tests
// here drive the service through its `__debugHandleServiceForTest` seam,
// which feeds the same up/down handlers the real Browser would invoke, so
// the cache-matching / group-by-host / TXT-merge / resolveHost logic gets
// exercised without a live responder.
//
// A handful of tests verify the bonjour-service contract itself —
// specifically, that `find()` is called with the short type form
// (`adb-tls-pairing`, `adb-tls-connect`) and not the full
// `_adb-tls-pairing._tcp` (the latter would build a malformed browse name
// and never match a real advertisement, see Hermes's critical review note
// on PR #1381). Those tests use a tracking mock that captures every
// `find()` argument.

// Tracking bonjour-service mock: returns a Browser stub whose `on`/`stop`
// are no-ops, and records every `find()` argument so we can assert the
// shape that the real library was handed. Reset between tests.
type FindCall = { type?: string };
let findCalls: FindCall[] = [];
const stopCalls = vi.fn();
const destroyCalls = vi.fn();

function makeBrowserStub() {
  return { on: () => undefined, stop: () => stopCalls() };
}

vi.mock("bonjour-service", () => {
  return {
    default: function BonjourStub() {
      return {
        find: (opts: FindCall) => {
          findCalls.push(opts);
          return makeBrowserStub();
        },
        destroy: () => destroyCalls(),
      };
    },
  };
});

function resetTracker() {
  findCalls = [];
  stopCalls.mockClear();
  destroyCalls.mockClear();
}

beforeEach(() => {
  resetTracker();
});

function emitUp(
  service: DeviceDiscoveryService,
  type: string,
  payload: {
    name: string;
    host: string;
    port: number;
    txt?: Record<string, string>;
    addresses?: string[];
    /** Stable fqdn — derived from name+type when omitted, matching what
     * bonjour-service surfaces from the SRV record. */
    fqdn?: string;
  },
): void {
  service.__debugHandleServiceForTest(type, {
    name: payload.name,
    type,
    fqdn: payload.fqdn ?? `${payload.name}.${type}.local`,
    host: payload.host,
    port: payload.port,
    addresses: payload.addresses,
    txt: payload.txt,
  });
}

function emitDown(
  service: DeviceDiscoveryService,
  type: string,
  payload: { name: string; host: string; port: number; fqdn?: string },
): void {
  service.__debugHandleDownForTest(type, {
    name: payload.name,
    type,
    fqdn: payload.fqdn ?? `${payload.name}.${type}.local`,
    host: payload.host,
    port: payload.port,
  });
}

describe("DeviceDiscoveryService", () => {
  describe("bonjour-service contract (Hermes critical review on #1381)", () => {
    it("calls find() with the SHORT type form ('adb-tls-pairing'), not the full '_adb-tls-pairing._tcp'", () => {
      const svc = new DeviceDiscoveryService({ enabled: true });
      svc.start();
      const types = findCalls.map((c) => c.type);
      expect(types).toContain("adb-tls-pairing");
      expect(types).not.toContain("_adb-tls-pairing._tcp");
      svc.stop();
    });

    it("calls find() once for the connect service with the SHORT type form", () => {
      const svc = new DeviceDiscoveryService({ enabled: true });
      svc.start();
      const types = findCalls.map((c) => c.type);
      expect(types).toContain("adb-tls-connect");
      expect(types).not.toContain("_adb-tls-connect._tcp");
      svc.stop();
    });

    it("calls find() exactly twice — one per adb service type — and no more", () => {
      const svc = new DeviceDiscoveryService({ enabled: true });
      svc.start();
      expect(findCalls).toHaveLength(2);
      svc.stop();
    });

    it("does NOT call find() when enabled is false (no UDP socket, no query traffic)", () => {
      const svc = new DeviceDiscoveryService({ enabled: false });
      svc.start();
      expect(findCalls).toEqual([]);
      svc.stop();
    });
  });

  describe("resolveHost (Hermes warning on #1381)", () => {
    it("prefers the first IPv4 entry of addresses[] over service.host (the SRV-target .local hostname)", () => {
      // Mirror what bonjour-service actually surfaces: host is the mDNS
      // hostname, addresses[] is the A/AAAA-record list. Without the fix
      // this would resolve to "Android.local" and the adb address would
      // come out as "Android.local:41234".
      const svc = new DeviceDiscoveryService({ enabled: true });
      svc.start();
      svc.__debugHandleServiceForTest("_adb-tls-pairing._tcp", {
        name: "Pixel",
        type: "_adb-tls-pairing._tcp",
        fqdn: "Pixel._adb-tls-pairing._tcp.local",
        host: "Android.local",
        port: 41234,
        addresses: ["192.168.1.42", "fe80::1ff:fe23:4567:890a"],
        txt: {},
      });
      expect(svc.getDiscovered()[0]).toMatchObject({
        host: "192.168.1.42",
        pairingAddress: "192.168.1.42:41234",
      });
      svc.stop();
    });

    it("picks IPv4 out of a v4-then-v6 addresses[] ordering", () => {
      const svc = new DeviceDiscoveryService({ enabled: true });
      svc.start();
      svc.__debugHandleServiceForTest("_adb-tls-pairing._tcp", {
        name: "Pixel",
        type: "_adb-tls-pairing._tcp",
        fqdn: "Pixel._adb-tls-pairing._tcp.local",
        host: "Android.local",
        port: 41234,
        addresses: ["fe80::1ff:fe23:4567:890a", "192.168.1.42"],
        txt: {},
      });
      expect(svc.getDiscovered()[0].host).toBe("192.168.1.42");
      svc.stop();
    });

    it("skips the entry when addresses[] has entries but NONE is IPv4 (W2 on #1381 — an IPv6 literal is not dialable by Android's IPv4-only adb listener and would be rejected by DEVICE_ADDRESS_PATTERN)", () => {
      const svc = new DeviceDiscoveryService({ enabled: true });
      svc.start();
      svc.__debugHandleServiceForTest("_adb-tls-pairing._tcp", {
        name: "Pixel",
        type: "_adb-tls-pairing._tcp",
        fqdn: "Pixel._adb-tls-pairing._tcp.local",
        host: "Android.local",
        port: 41234,
        addresses: ["fe80::1ff:fe23:4567:890a"],
        txt: {},
      });
      // No IPv4 in addresses → resolveHost returns undefined → the entry
      // is never cached (getDiscovered stays empty). This contradicts the
      // old addresses[0] fallback, which produced
      // "fe80::…:41234" — a value DEVICE_ADDRESS_PATTERN rejects.
      expect(svc.getDiscovered()).toEqual([]);
      svc.stop();
    });

    it("falls back to service.host when addresses[] is empty (first 'up' event before A-record resolves)", () => {
      const svc = new DeviceDiscoveryService({ enabled: true });
      svc.start();
      svc.__debugHandleServiceForTest("_adb-tls-pairing._tcp", {
        name: "Pixel",
        type: "_adb-tls-pairing._tcp",
        fqdn: "Pixel._adb-tls-pairing._tcp.local",
        host: "192.168.1.55",
        port: 41234,
        // No addresses — only the hostname resolved so far.
        txt: {},
      });
      expect(svc.getDiscovered()[0].host).toBe("192.168.1.55");
      svc.stop();
    });

    it("re-keys from hostname to IPv4 when the A-record lands (srv-update), emitting down for the old host and up for the new (W4 on #1381)", () => {
      const changes: Array<{ kind: string; id?: string; host?: string }> = [];
      const svc = new DeviceDiscoveryService({
        enabled: true,
        onChange: (change) => {
          if (change.kind === "down") changes.push({ kind: change.kind, id: change.id });
          else changes.push({ kind: change.kind, host: change.device.host });
        },
      });
      svc.start();
      // First event: no A-record yet → hostname fallback.
      emitUp(svc, "_adb-tls-pairing._tcp", {
        name: "Pixel",
        host: "Android.local",
        port: 41234,
        addresses: [],
      });
      expect(svc.getDiscovered()[0].host).toBe("Android.local");
      // srv-update: A-record arrives → resolveHost now returns the IPv4.
      // The cache is keyed by fqdn, so this updates the SAME record; the
      // grouped view re-keys from hostname to IP. Consumers see down for
      // the phantom hostname entry and up for the dialable IP.
      emitUp(svc, "_adb-tls-pairing._tcp", {
        name: "Pixel",
        host: "Android.local",
        port: 41234,
        addresses: ["192.168.1.42"],
      });
      expect(svc.getDiscovered()[0]).toMatchObject({
        id: "192.168.1.42",
        host: "192.168.1.42",
        pairingAddress: "192.168.1.42:41234",
      });
      expect(changes).toEqual([
        { kind: "up", host: "Android.local" },
        { kind: "down", id: "Android.local" },
        { kind: "up", host: "192.168.1.42" },
      ]);
      svc.stop();
    });

    it("ignores invalid IPv4-shaped entries (out-of-range octets)", () => {
      const svc = new DeviceDiscoveryService({ enabled: true });
      svc.start();
      svc.__debugHandleServiceForTest("_adb-tls-pairing._tcp", {
        name: "Pixel",
        type: "_adb-tls-pairing._tcp",
        fqdn: "Pixel._adb-tls-pairing._tcp.local",
        host: "Android.local",
        port: 41234,
        addresses: ["999.1.1.1", "not-an-ip", "192.168.1.42"],
        txt: {},
      });
      // "999.1.1.1" and "not-an-ip" are not valid IPv4 — the function
      // should skip them and land on the one valid v4 entry.
      expect(svc.getDiscovered()[0].host).toBe("192.168.1.42");
      svc.stop();
    });
  });

  describe("getDiscovered (Hermes suggestion on #1381)", () => {
    it("returns defensive copies — mutating the returned array does not affect the cache", () => {
      const svc = new DeviceDiscoveryService({ enabled: true });
      svc.start();
      emitUp(svc, "_adb-tls-pairing._tcp", {
        name: "Pixel 7",
        host: "192.168.1.23",
        port: 41234,
      });
      const snap = svc.getDiscovered();
      // Tamper with the snapshot — the cache should be unaffected, and a
      // second snapshot should not reflect the mutation.
      snap[0].name = "mutated";
      (snap[0] as { pairingAddress: string | undefined }).pairingAddress = "1.2.3.4:5";
      expect(svc.getDiscovered()[0].name).toBe("Pixel 7");
      expect(svc.getDiscovered()[0].pairingAddress).toBe("192.168.1.23:41234");
      svc.stop();
    });

    it("returns an empty snapshot when disabled", () => {
      const svc = new DeviceDiscoveryService({ enabled: false });
      svc.start();
      expect(svc.getDiscovered()).toEqual([]);
      svc.stop();
    });
  });

  describe("up vs update semantics (Hermes suggestion on #1381)", () => {
    it("emits `up` only on the FIRST service event for a fresh host", () => {
      const changes: Array<string> = [];
      const svc = new DeviceDiscoveryService({
        enabled: true,
        onChange: (c) => changes.push(c.kind),
      });
      svc.start();
      emitUp(svc, "_adb-tls-pairing._tcp", {
        name: "Pixel",
        host: "192.168.1.23",
        port: 41234,
      });
      expect(changes).toEqual(["up"]);
      svc.stop();
    });

    it("emits `update` on the SECOND service event for an already-known host", () => {
      const changes: Array<string> = [];
      const svc = new DeviceDiscoveryService({
        enabled: true,
        onChange: (c) => changes.push(c.kind),
      });
      svc.start();
      emitUp(svc, "_adb-tls-pairing._tcp", {
        name: "Pixel",
        host: "192.168.1.23",
        port: 41234,
      });
      emitUp(svc, "_adb-tls-connect._tcp", {
        name: "Pixel",
        host: "192.168.1.23",
        port: 37251,
      });
      // First event: fresh host → up. Second event: same host already
      // cached → update. Consumers can tell "something new showed up"
      // from "the picture changed" now.
      expect(changes).toEqual(["up", "update"]);
      svc.stop();
    });
  });

  describe("cache grouping + TXT merge (pre-existing coverage)", () => {
    it("groups pairing + connect from the same host under one entry", () => {
      const svc = new DeviceDiscoveryService({ enabled: true });
      svc.start();
      emitUp(svc, "_adb-tls-pairing._tcp", {
        name: "Pixel 7",
        host: "192.168.1.23",
        port: 41234,
        txt: { name: "Pixel 7", model: "GP4BC", device: "ABC123", product: "panther" },
      });
      emitUp(svc, "_adb-tls-connect._tcp", {
        name: "Pixel 7",
        host: "192.168.1.23",
        port: 37251,
        txt: { name: "Pixel 7", model: "GP4BC", device: "ABC123", product: "panther" },
      });
      const discovered = svc.getDiscovered();
      expect(discovered).toHaveLength(1);
      expect(discovered[0]).toMatchObject({
        id: "192.168.1.23",
        name: "Pixel 7",
        host: "192.168.1.23",
        pairingAddress: "192.168.1.23:41234",
        connectAddress: "192.168.1.23:37251",
        device: "ABC123",
        model: "GP4BC",
        product: "panther",
      });
      svc.stop();
    });

    it("prefers the TXT `name` field over the service's own name", () => {
      const svc = new DeviceDiscoveryService({ enabled: true });
      svc.start();
      emitUp(svc, "_adb-tls-pairing._tcp", {
        name: "android-7",
        host: "192.168.1.23",
        port: 41234,
        txt: { name: "Bob's Phone" },
      });
      expect(svc.getDiscovered()[0].name).toBe("Bob's Phone");
      svc.stop();
    });

    it("keeps an entry visible while at least one of pairing/connect is alive", () => {
      const svc = new DeviceDiscoveryService({ enabled: true });
      svc.start();
      emitUp(svc, "_adb-tls-pairing._tcp", {
        name: "Pixel 7",
        host: "192.168.1.23",
        port: 41234,
      });
      emitUp(svc, "_adb-tls-connect._tcp", {
        name: "Pixel 7",
        host: "192.168.1.23",
        port: 37251,
      });
      emitDown(svc, "_adb-tls-pairing._tcp", {
        name: "Pixel 7",
        host: "192.168.1.23",
        port: 41234,
      });
      const discovered = svc.getDiscovered();
      expect(discovered).toHaveLength(1);
      expect(discovered[0].pairingAddress).toBeUndefined();
      expect(discovered[0].connectAddress).toBe("192.168.1.23:37251");
      svc.stop();
    });

    it("drops the entry entirely once both services go down", () => {
      const svc = new DeviceDiscoveryService({ enabled: true });
      svc.start();
      emitUp(svc, "_adb-tls-pairing._tcp", {
        name: "Pixel 7",
        host: "192.168.1.23",
        port: 41234,
      });
      emitUp(svc, "_adb-tls-connect._tcp", {
        name: "Pixel 7",
        host: "192.168.1.23",
        port: 37251,
      });
      emitDown(svc, "_adb-tls-pairing._tcp", {
        name: "Pixel 7",
        host: "192.168.1.23",
        port: 41234,
      });
      emitDown(svc, "_adb-tls-connect._tcp", {
        name: "Pixel 7",
        host: "192.168.1.23",
        port: 37251,
      });
      expect(svc.getDiscovered()).toEqual([]);
      svc.stop();
    });

    it("fires onChange callbacks for the full up → update → update → down lifecycle", () => {
      const changes: Array<{ kind: string; id?: string; host?: string }> = [];
      const svc = new DeviceDiscoveryService({
        enabled: true,
        onChange: (change) => {
          if (change.kind === "down") {
            changes.push({ kind: change.kind, id: change.id });
          } else {
            changes.push({ kind: change.kind, host: change.device.host });
          }
        },
      });
      svc.start();
      emitUp(svc, "_adb-tls-pairing._tcp", {
        name: "Pixel",
        host: "192.168.1.23",
        port: 41234,
      });
      emitUp(svc, "_adb-tls-connect._tcp", {
        name: "Pixel",
        host: "192.168.1.23",
        port: 37251,
      });
      emitDown(svc, "_adb-tls-pairing._tcp", {
        name: "Pixel",
        host: "192.168.1.23",
        port: 41234,
      });
      emitDown(svc, "_adb-tls-connect._tcp", {
        name: "Pixel",
        host: "192.168.1.23",
        port: 37251,
      });
      // First pairing event creates the entry (up); the connect event on
      // the SAME host is `update`, not up (it's not a new device). Each
      // subsequent single-service down is `update` (host still partially
      // visible) and the last one, which leaves the entry empty, is
      // `down`.
      expect(changes).toEqual([
        { kind: "up", host: "192.168.1.23" },
        { kind: "update", host: "192.168.1.23" },
        { kind: "update", host: "192.168.1.23" },
        { kind: "down", id: "192.168.1.23" },
      ]);
      svc.stop();
    });

    it("ignores events with no resolvable host", () => {
      const svc = new DeviceDiscoveryService({ enabled: true });
      svc.start();
      emitUp(svc, "_adb-tls-pairing._tcp", { name: "?", host: "", port: 41234 });
      expect(svc.getDiscovered()).toEqual([]);
      svc.stop();
    });

    it("ignores events for unknown service types", () => {
      const svc = new DeviceDiscoveryService({ enabled: true });
      svc.start();
      emitUp(svc, "_http._tcp", {
        name: "irrelevant",
        host: "192.168.1.99",
        port: 80,
      });
      expect(svc.getDiscovered()).toEqual([]);
      svc.stop();
    });

    it("getById round-trips the entry by host", () => {
      const svc = new DeviceDiscoveryService({ enabled: true });
      svc.start();
      emitUp(svc, "_adb-tls-pairing._tcp", {
        name: "Pixel",
        host: "192.168.1.23",
        port: 41234,
      });
      expect(svc.getById("192.168.1.23")?.host).toBe("192.168.1.23");
      expect(svc.getById("nope")).toBeUndefined();
      svc.stop();
    });

    it("evict(id) drops every service record whose resolved host is id (W1's cache-poisoning escape hatch)", () => {
      const svc = new DeviceDiscoveryService({ enabled: true });
      svc.start();
      emitUp(svc, "_adb-tls-pairing._tcp", {
        name: "Pixel",
        host: "192.168.1.23",
        port: 41234,
      });
      emitUp(svc, "_adb-tls-connect._tcp", {
        name: "Pixel",
        host: "192.168.1.23",
        port: 37251,
      });
      expect(svc.getDiscovered()).toHaveLength(1);
      svc.evict("192.168.1.23");
      expect(svc.getDiscovered()).toEqual([]);
      // Evicting an unknown id is a no-op.
      svc.evict("10.0.0.99");
      expect(svc.getDiscovered()).toEqual([]);
      svc.stop();
    });
  });

  describe("lifecycle (pre-existing coverage)", () => {
    it("stop() is idempotent and never throws", () => {
      const svc = new DeviceDiscoveryService({ enabled: true });
      svc.start();
      svc.stop();
      expect(() => svc.stop()).not.toThrow();
    });

    it("start() is idempotent", () => {
      const svc = new DeviceDiscoveryService({ enabled: true });
      svc.start();
      expect(() => svc.start()).not.toThrow();
      svc.stop();
    });

    it("stop() destroys the Bonjour instance (releases the UDP socket)", () => {
      const svc = new DeviceDiscoveryService({ enabled: true });
      svc.start();
      svc.stop();
      expect(destroyCalls).toHaveBeenCalledTimes(1);
      expect(stopCalls).toHaveBeenCalled();
    });

    it("start() after stop() constructs a FRESH Bonjour instance (stop() nulls this.bonjour — S5 on #1381)", () => {
      // On bonjour-service@1.4.4, find() after destroy() returns a Browser
      // on an already-closed socket without throwing — discovery would go
      // silently dead. Nulling this.bonjour in stop() forces a new
      // construction on the next start().
      const svc = new DeviceDiscoveryService({ enabled: true });
      svc.start();
      expect(findCalls).toHaveLength(2);
      svc.stop();
      expect(destroyCalls).toHaveBeenCalledTimes(1);
      svc.start();
      // Two more find() calls — one per type — against a NEW instance.
      expect(findCalls).toHaveLength(4);
      svc.stop();
      expect(destroyCalls).toHaveBeenCalledTimes(2);
    });
  });
});
