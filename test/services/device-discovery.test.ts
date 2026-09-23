import { describe, it, expect, vi } from "vitest";
import { DeviceDiscoveryService } from "../../src/services/device-discovery.js";

// Issue #1378 — the mDNS scanner that surfaces nearby Android phones for
// the new "Pair a phone" modal. The real bonjour-service Browser opens a
// UDP multicast socket and reacts to live mDNS traffic — that's
// unverifiable in this suite (and would be flaky if it were). Every test
// here drives the service through its `__debugHandleServiceForTest` seam
// instead, which feeds the same up/down handlers the real Browser would
// invoke, so the cache-matching / group-by-host / TXT-merge logic gets
// exercised without a live responder.
//
// bonjour-service is mocked at the module level below so a real UDP socket
// never opens during tests — `find()` returns a stub Browser whose
// `on()`/`stop()` no-op, and the cache stays empty until a test injects a
// service event directly.

vi.mock("bonjour-service", () => {
  const BrowserStub = function () {
    return { on: () => undefined, stop: () => undefined };
  };
  // Match the real library's export shape (default-exported class with
  // namespaced re-exports) just enough that the import-and-construct line
  // in device-discovery.ts works.
  return {
    default: function BonjourStub() {
      return { find: () => new BrowserStub(), destroy: () => undefined };
    },
  };
});

function emitUp(
  service: DeviceDiscoveryService,
  type: string,
  payload: {
    name: string;
    host: string;
    port: number;
    txt?: Record<string, string>;
  },
): void {
  service.__debugHandleServiceForTest(type, {
    name: payload.name,
    type,
    host: payload.host,
    port: payload.port,
    txt: payload.txt,
  });
}

function emitDown(
  service: DeviceDiscoveryService,
  type: string,
  payload: { name: string; host: string; port: number },
): void {
  service.__debugHandleDownForTest(type, payload);
}

describe("DeviceDiscoveryService", () => {
  it("returns an empty snapshot when disabled", () => {
    const svc = new DeviceDiscoveryService({ enabled: false, intervalMs: 2500 });
    svc.start();
    expect(svc.getDiscovered()).toEqual([]);
    svc.stop();
  });

  it("groups pairing + connect from the same host under one entry", () => {
    const svc = new DeviceDiscoveryService({ enabled: true, intervalMs: 2500 });
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
    const svc = new DeviceDiscoveryService({ enabled: true, intervalMs: 2500 });
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
    const svc = new DeviceDiscoveryService({ enabled: true, intervalMs: 2500 });
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
    const svc = new DeviceDiscoveryService({ enabled: true, intervalMs: 2500 });
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

  it("ignores events with no resolvable host", () => {
    const svc = new DeviceDiscoveryService({ enabled: true, intervalMs: 2500 });
    svc.start();
    emitUp(svc, "_adb-tls-pairing._tcp", { name: "?", host: "", port: 41234 });
    expect(svc.getDiscovered()).toEqual([]);
    svc.stop();
  });

  it("ignores events for unknown service types", () => {
    const svc = new DeviceDiscoveryService({ enabled: true, intervalMs: 2500 });
    svc.start();
    emitUp(svc, "_http._tcp", {
      name: "irrelevant",
      host: "192.168.1.99",
      port: 80,
    });
    expect(svc.getDiscovered()).toEqual([]);
    svc.stop();
  });

  it("falls back to the first address when `host` is unset", () => {
    const svc = new DeviceDiscoveryService({ enabled: true, intervalMs: 2500 });
    svc.start();
    svc.__debugHandleServiceForTest("_adb-tls-pairing._tcp", {
      name: "Pixel",
      type: "_adb-tls-pairing._tcp",
      port: 41234,
      addresses: ["192.168.1.55"],
      txt: {},
    });
    expect(svc.getDiscovered()[0].host).toBe("192.168.1.55");
    svc.stop();
  });

  it("getById round-trips the entry by host", () => {
    const svc = new DeviceDiscoveryService({ enabled: true, intervalMs: 2500 });
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

  it("fires onChange callbacks for up/down/update transitions", () => {
    const changes: Array<{ kind: string; id?: string; host?: string }> = [];
    const svc = new DeviceDiscoveryService({
      enabled: true,
      intervalMs: 2500,
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
    // First pairing event creates the entry (up); the connect event is
    // ALSO "up" because a second mDNS service from the same host arrived
    // (semantically: a new service came online). Each subsequent single-
    // service down is "update" — the host is still partially visible — and
    // the last one, which leaves the entry empty, is "down".
    expect(changes).toEqual([
      { kind: "up", host: "192.168.1.23" },
      { kind: "up", host: "192.168.1.23" },
      { kind: "update", host: "192.168.1.23" },
      { kind: "down", id: "192.168.1.23" },
    ]);
    svc.stop();
  });

  it("stop() is idempotent and never throws", () => {
    const svc = new DeviceDiscoveryService({ enabled: true, intervalMs: 2500 });
    svc.start();
    svc.stop();
    expect(() => svc.stop()).not.toThrow();
  });

  it("start() is idempotent", () => {
    const svc = new DeviceDiscoveryService({ enabled: true, intervalMs: 2500 });
    svc.start();
    expect(() => svc.start()).not.toThrow();
    svc.stop();
  });
});
