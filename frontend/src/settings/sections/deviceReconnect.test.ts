import { describe, expect, it } from "vitest";
import type { Device, DiscoveredDevice } from "../../api/index.js";
import { findReconnectSuggestions, hostOf } from "./deviceReconnect.js";

function row(id: number, serial: string | null, over: Partial<Device> = {}): Device {
  return {
    id,
    hostId: "local",
    projectId: null,
    name: null,
    kind: "physical",
    avdName: null,
    serial,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    live: null,
    ...over,
  };
}

function disc(host: string, port: number | null, over: Partial<DiscoveredDevice> = {}) {
  return {
    id: `${host}-${port}`,
    name: "Pixel 7",
    host,
    connectAddress: port === null ? undefined : `${host}:${port}`,
    discoveredAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } satisfies DiscoveredDevice;
}

describe("hostOf", () => {
  it("splits host:port, handles bracketed IPv6, rejects junk", () => {
    expect(hostOf("192.168.1.23:37251")).toBe("192.168.1.23");
    expect(hostOf("[fe80::1]:5555")).toBe("fe80::1");
    expect(hostOf("nocolon")).toBeNull();
    expect(hostOf(null)).toBeNull();
  });
});

describe("findReconnectSuggestions (issue #1380)", () => {
  it("suggests the rediscovered address for a same-host row on a new port", () => {
    const res = findReconnectSuggestions(
      [row(1, "192.168.1.23:37251")],
      [disc("192.168.1.23", 40111)],
    );
    expect(res.get(1)?.candidates.map((c) => c.connectAddress)).toEqual(["192.168.1.23:40111"]);
    expect(res.get(1)?.ambiguous).toBe(false);
  });

  it("does not prompt when the stored address is still advertised", () => {
    const res = findReconnectSuggestions(
      [row(1, "192.168.1.23:37251")],
      [disc("192.168.1.23", 37251)],
    );
    expect(res.size).toBe(0);
  });

  it("ignores emulators, killed rows, connect-less entries and other hosts", () => {
    const res = findReconnectSuggestions(
      [
        row(1, null, { kind: "emulator", avdName: "x" }),
        row(2, "192.168.1.23:1", { status: "killed" }),
        row(3, "192.168.1.30:37251"),
      ],
      [disc("192.168.1.23", 40111), disc("192.168.1.30", null)],
    );
    expect(res.size).toBe(0);
  });

  it("falls back to the user-given name when the host changed", () => {
    const res = findReconnectSuggestions(
      [row(1, "192.168.1.23:37251", { name: "pixel 7" })],
      [disc("192.168.1.99", 40111)],
    );
    expect(res.get(1)?.candidates[0]?.host).toBe("192.168.1.99");
  });

  it("flags several candidates as ambiguous, name match first", () => {
    const res = findReconnectSuggestions(
      [row(1, "192.168.1.23:37251", { name: "Work" })],
      [
        disc("192.168.1.23", 40111, { id: "a", name: "Other" }),
        disc("192.168.1.23", 40222, { id: "b", name: "Work" }),
      ],
    );
    expect(res.get(1)?.ambiguous).toBe(true);
    expect(res.get(1)?.candidates.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("flags two stale rows on one host as ambiguous", () => {
    const res = findReconnectSuggestions(
      [row(1, "192.168.1.23:1111"), row(2, "192.168.1.23:2222")],
      [disc("192.168.1.23", 40111)],
    );
    expect(res.get(1)?.ambiguous).toBe(true);
    expect(res.get(2)?.ambiguous).toBe(true);
  });
});
