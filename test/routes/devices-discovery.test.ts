import { describe, it, expect, vi, beforeEach } from "vitest";
// Mock setup mirrors test/routes/devices.test.ts's own (see that file's
// header for why the order matters — `vi.mock` calls here MUST come before
// any import that could transitively load "node-pty" or "node:child_process").
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import type * as ChildProcess from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildTestApp } from "../helpers/app.js";
import { closeDb } from "../../src/db/client.js";
import type { DeviceDiscoveryService } from "../../src/services/device-discovery.js";

// `bonjour-service` opens a UDP multicast socket on construction — the
// same reason AGENTS.md mocks `node:child_process` for tests, applied
// here to a library that uses raw sockets. Stub the default export so a
// real socket never binds during tests; the discovery service itself is
// exercised through `__debugHandleServiceForTest` (see
// test/services/device-discovery.test.ts for the pattern).
//
// The mock captures every `find()` call so route tests can assert on the
// (non-)existence of mDNS traffic — specifically that `DEVICE_ENABLED=false`
// never causes a Bonjour instance to be constructed.
type FindCall = { type?: string };
const routeFindCalls: FindCall[] = [];
const routeBonjourCtorCalls = vi.fn();
vi.mock("bonjour-service", () => {
  return {
    default: function BonjourStub() {
      routeBonjourCtorCalls();
      return {
        find: (opts: FindCall) => {
          routeFindCalls.push(opts);
          return { on: () => undefined, stop: () => undefined };
        },
        destroy: () => undefined,
      };
    },
  };
});

const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const tmpDb = path.join(os.tmpdir(), `devices-discovery-test-${process.pid}.db`);

describe("devices discovery + pair-and-connect routes", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.DEVICE_ENABLED = "true";
  });

  // Helper: seed the in-process discovery cache by reaching into the
  // devicePlugin-decorated service. We avoid the actual mDNS path so the
  // suite stays deterministic — bonjour-service is mocked out above, and
  // the route never reads from a real responder anyway.
  function seedDiscovery(
    app: Awaited<ReturnType<typeof buildTestApp>>,
    payload: {
      id?: string;
      name?: string;
      host?: string;
      pairingPort?: number;
      connectPort?: number;
    },
  ): void {
    const discovery = app.deviceDiscovery as DeviceDiscoveryService;
    const host = payload.host ?? "192.168.1.23";
    const name = payload.name ?? "Pixel 7";
    if (payload.pairingPort !== undefined) {
      discovery.__debugHandleServiceForTest("_adb-tls-pairing._tcp", {
        name,
        type: "_adb-tls-pairing._tcp",
        fqdn: `${name}._adb-tls-pairing._tcp.local`,
        host,
        port: payload.pairingPort,
        txt: { name },
      });
    }
    if (payload.connectPort !== undefined) {
      discovery.__debugHandleServiceForTest("_adb-tls-connect._tcp", {
        name,
        type: "_adb-tls-connect._tcp",
        fqdn: `${name}._adb-tls-connect._tcp.local`,
        host,
        port: payload.connectPort,
        txt: { name },
      });
    }
    // Touch `id` so unused-arg lints don't complain when the test
    // passes only one of the two port kinds.
    void payload.id;
  }

  describe("GET /api/devices/discovered", () => {
    it("returns an empty array when nothing has been advertised", async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/devices/discovered" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it("does NOT construct a Bonjour instance or call find() when DEVICE_ENABLED=false (Hermes suggestion on #1381)", async () => {
      delete process.env.DEVICE_ENABLED;
      const findCallsBefore = routeFindCalls.length;
      const ctorCallsBefore = routeBonjourCtorCalls.mock.calls.length;
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/devices/discovered" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
      // Combined gate in src/plugins/device.ts: a default install with
      // DEVICE_ENABLED=false must never open a UDP socket or emit 5353
      // queries. Both metrics here are cumulative across the whole
      // process — the test asserts nothing was added during this
      // particular buildApp() invocation.
      expect(routeBonjourCtorCalls.mock.calls.length).toBe(ctorCallsBefore);
      expect(routeFindCalls.length).toBe(findCallsBefore);
      // Restore for sibling tests that DO want DEVICE_ENABLED.
      process.env.DEVICE_ENABLED = "true";
      await app.close();
    });

    it("returns the cached discovery snapshot grouped by SRV hostname", async () => {
      const app = await buildTestApp();
      seedDiscovery(app, { name: "Pixel 7", pairingPort: 41234, connectPort: 37251 });
      const res = await app.inject({ method: "GET", url: "/api/devices/discovered" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({
        id: "192.168.1.23",
        name: "Pixel 7",
        host: "192.168.1.23",
        pairingAddress: "192.168.1.23:41234",
        connectAddress: "192.168.1.23:37251",
      });
    });

    it("returns an empty array when DEVICE_DISCOVERY_ENABLED is false", async () => {
      process.env.DEVICE_DISCOVERY_ENABLED = "false";
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/devices/discovered" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
      delete process.env.DEVICE_DISCOVERY_ENABLED;
    });
  });

  describe("POST /api/devices/pair-and-connect", () => {
    it("rejects when DEVICE_ENABLED is off", async () => {
      delete process.env.DEVICE_ENABLED;
      const app = await buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/devices/pair-and-connect",
        payload: { discoveryId: "192.168.1.23", pairingCode: "123456" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a malformed pairing code", async () => {
      const app = await buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/devices/pair-and-connect",
        payload: {
          pairingAddress: "192.168.1.23:41234",
          connectAddress: "192.168.1.23:37251",
          pairingCode: "12",
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects when neither discoveryId nor pairingAddress is supplied", async () => {
      const app = await buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/devices/pair-and-connect",
        payload: { pairingCode: "123456" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an unknown discoveryId", async () => {
      const app = await buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/devices/pair-and-connect",
        payload: { discoveryId: "10.0.0.99", pairingCode: "123456" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("skips pair() and goes straight to connect when the cache has only a connect service (paired-before reconnect case)", async () => {
      const app = await buildTestApp();
      seedDiscovery(app, { name: "Pixel 7", connectPort: 37251 });
      const pair = vi.spyOn(app.device, "pair").mockResolvedValueOnce(undefined);
      const getOrCreate = vi.spyOn(app.device, "getOrCreate").mockResolvedValueOnce({} as never);

      const res = await app.inject({
        method: "POST",
        url: "/api/devices/pair-and-connect",
        payload: { discoveryId: "192.168.1.23", pairingCode: "123456" },
      });
      expect(res.statusCode).toBe(201);
      // Pairing is skipped because the discovery cache never saw a
      // pairing service for this host — the phone isn't in pairing mode.
      expect(pair).not.toHaveBeenCalled();
      expect(getOrCreate).toHaveBeenCalledWith(
        expect.objectContaining({ serial: "192.168.1.23:37251" }),
      );
    });

    it("rejects manual mode without a connectAddress", async () => {
      const app = await buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/devices/pair-and-connect",
        payload: { pairingAddress: "192.168.1.23:41234", pairingCode: "123456" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("creates a physical row, calls pair(), and starts a Device from the cached discovery entry", async () => {
      const app = await buildTestApp();
      seedDiscovery(app, { name: "Pixel 7", pairingPort: 41234, connectPort: 37251 });
      const pair = vi.spyOn(app.device, "pair").mockResolvedValueOnce(undefined);
      const getOrCreate = vi.spyOn(app.device, "getOrCreate").mockResolvedValueOnce({
        // Returned Device object is opaque to the route — only
        // `get(id)?.toInfo()` is consulted after this returns, and we
        // don't read it in this test.
        id: "0",
      } as never);

      const res = await app.inject({
        method: "POST",
        url: "/api/devices/pair-and-connect",
        payload: { discoveryId: "192.168.1.23", pairingCode: "123456", name: "Bob's Pixel" },
      });
      expect(res.statusCode).toBe(201);
      expect(pair).toHaveBeenCalledWith("192.168.1.23:41234", "123456");
      expect(getOrCreate).toHaveBeenCalledTimes(1);
      expect(getOrCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "physical",
          serial: "192.168.1.23:37251",
        }),
      );
      const body = res.json();
      expect(body).toMatchObject({
        kind: "physical",
        serial: "192.168.1.23:37251",
        name: "Bob's Pixel",
        status: "active",
      });
    });

    it("always attempts pair() in manual mode, even with no discovery cache entries", async () => {
      const app = await buildTestApp();
      const pair = vi.spyOn(app.device, "pair").mockResolvedValueOnce(undefined);
      const getOrCreate = vi.spyOn(app.device, "getOrCreate").mockResolvedValueOnce({} as never);

      const res = await app.inject({
        method: "POST",
        url: "/api/devices/pair-and-connect",
        payload: {
          pairingAddress: "192.168.1.99:41234",
          connectAddress: "192.168.1.99:37251",
          pairingCode: "123456",
        },
      });
      expect(res.statusCode).toBe(201);
      expect(pair).toHaveBeenCalledWith("192.168.1.99:41234", "123456");
      expect(getOrCreate).toHaveBeenCalledTimes(1);
    });

    it("surfaces a pair() failure as 400 and rolls back the row so a retry can succeed", async () => {
      const app = await buildTestApp();
      seedDiscovery(app, { name: "Pixel 7", pairingPort: 41234, connectPort: 37251 });
      vi.spyOn(app.device, "pair").mockRejectedValueOnce(new Error("wrong code"));
      const res = await app.inject({
        method: "POST",
        url: "/api/devices/pair-and-connect",
        payload: { discoveryId: "192.168.1.23", pairingCode: "123456" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("wrong code");

      // Row is rolled back: a wrong code is the common typo case and the
      // user will immediately retry — leaving the row would make that
      // retry hit the collision guard with a confusing 409. The insert
      // still happened BEFORE the await pair() (closing the double-click
      // race), and the rollback is synchronous after the guard has either
      // let a concurrent request through (it inserted its own row) or
      // 409'd it.
      const list = await app.inject({ method: "GET", url: "/api/devices" });
      expect(list.json()).toEqual([]);
    });

    it("returns 409 when an active physical row already owns the same connect address", async () => {
      const app = await buildTestApp();
      // Pre-seed an active row at the same address the route would use.
      app.db
        .insert((await import("../../src/db/schema.js")).devices)
        .values({
          kind: "physical",
          serial: "192.168.1.23:37251",
          avdName: null,
          projectId: null,
          name: null,
        })
        .run();
      seedDiscovery(app, { name: "Pixel 7", pairingPort: 41234, connectPort: 37251 });
      vi.spyOn(app.device, "pair").mockResolvedValueOnce(undefined);

      const res = await app.inject({
        method: "POST",
        url: "/api/devices/pair-and-connect",
        payload: { discoveryId: "192.168.1.23", pairingCode: "123456" },
      });
      expect(res.statusCode).toBe(409);
    });

    it("honors a user-supplied connectAddress override on top of the cached entry", async () => {
      const app = await buildTestApp();
      seedDiscovery(app, { name: "Pixel 7", pairingPort: 41234, connectPort: 37251 });
      vi.spyOn(app.device, "pair").mockResolvedValueOnce(undefined);
      const getOrCreate = vi.spyOn(app.device, "getOrCreate").mockResolvedValueOnce({} as never);

      const res = await app.inject({
        method: "POST",
        url: "/api/devices/pair-and-connect",
        payload: {
          discoveryId: "192.168.1.23",
          pairingCode: "123456",
          connectAddress: "192.168.1.23:55555",
        },
      });
      expect(res.statusCode).toBe(201);
      expect(getOrCreate).toHaveBeenCalledWith(
        expect.objectContaining({ serial: "192.168.1.23:55555" }),
      );
    });

    it("rejects a cached pairingAddress that fails isValidDeviceAddress, evicts the entry, and 400s (W1 on #1381)", async () => {
      const app = await buildTestApp();
      // Seed with a literal IPv6 host: resolveHost falls back to
      // service.host when addresses[] is empty, so the grouped
      // pairingAddress becomes "fe80::1:41234" — which
      // DEVICE_ADDRESS_PATTERN rejects (the host part contains `:`).
      // DeviceManager.pair()'s doc says the route validates before pair()
      // is reached — that must hold on the cached branch too, or the `:`
      // in `host:pair:<code>:<address>` framing gets corrupted.
      seedDiscovery(app, {
        name: "Pixel 7",
        host: "fe80::1",
        pairingPort: 41234,
        connectPort: 37251,
      });
      const discovery = app.deviceDiscovery as DeviceDiscoveryService;
      expect(discovery.getById("fe80::1")?.pairingAddress).toBe("fe80::1:41234");

      const pair = vi.spyOn(app.device, "pair");
      const res = await app.inject({
        method: "POST",
        url: "/api/devices/pair-and-connect",
        payload: { discoveryId: "fe80::1", pairingCode: "123456" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("invalid address");
      expect(pair).not.toHaveBeenCalled();
      // The poisoned entry was evicted so the next picker open gets a
      // fresh scan rather than the same bad data.
      expect(discovery.getById("fe80::1")).toBeUndefined();
      expect(discovery.getDiscovered()).toEqual([]);
    });

    it("rejects a cached connectAddress that fails isValidDeviceAddress (W1 on #1381)", async () => {
      const app = await buildTestApp();
      // Connect-only entry (no pairing service) with an IPv6 host — the
      // connectAddress fails validation even though pairingAddress is
      // undefined (nothing to validate there).
      seedDiscovery(app, {
        name: "Pixel 7",
        host: "fe80::1",
        connectPort: 37251,
      });
      const discovery = app.deviceDiscovery as DeviceDiscoveryService;
      expect(discovery.getById("fe80::1")?.connectAddress).toBe("fe80::1:37251");

      const res = await app.inject({
        method: "POST",
        url: "/api/devices/pair-and-connect",
        payload: { discoveryId: "fe80::1", pairingCode: "123456" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("invalid address");
      expect(discovery.getById("fe80::1")).toBeUndefined();
    });

    it("concurrent double-click yields exactly one 201 and one 409, never two rows (W3 on #1381)", async () => {
      const app = await buildTestApp();
      seedDiscovery(app, { name: "Pixel 7", pairingPort: 41234, connectPort: 37251 });

      // Block pair() on a deferred promise so both requests are in flight
      // simultaneously — request A inserts its row (sync, before await
      // pair), then B's synchronous collision guard finds it and 409s.
      let releasePair!: () => void;
      const pairGate = new Promise<void>((resolve) => {
        releasePair = resolve;
      });
      vi.spyOn(app.device, "pair").mockImplementation(async () => {
        await pairGate;
        return undefined;
      });
      vi.spyOn(app.device, "getOrCreate").mockResolvedValue({} as never);

      const payload = { discoveryId: "192.168.1.23", pairingCode: "123456" };
      const reqA = app.inject({ method: "POST", url: "/api/devices/pair-and-connect", payload });
      // Give A a tick to pass the guard + insert + reach the blocked pair().
      await new Promise((r) => setTimeout(r, 10));
      const reqB = app.inject({ method: "POST", url: "/api/devices/pair-and-connect", payload });
      const [resB] = await Promise.all([reqB]);
      expect(resB.statusCode).toBe(409);
      releasePair();
      const [resA] = await Promise.all([reqA]);
      expect(resA.statusCode).toBe(201);

      const list = await app.inject({ method: "GET", url: "/api/devices" });
      expect(list.json()).toHaveLength(1);
    });
  });

  // Defensive: ensure each test cleans up its DB before the next one
  // (vitest's beforeEach sets DATABASE_URL but doesn't close the previous
  // handle — see test/helpers/app.ts header comment for why).
  afterEach(async () => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.DEVICE_ENABLED;
  });
});
