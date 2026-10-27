import { describe, it, expect } from "vitest";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { isPortInUse, isValidPort } from "../../src/services/port-probe.js";

describe("isValidPort", () => {
  it("accepts integers 1–65535 only", () => {
    expect(isValidPort(1)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
    for (const bad of [0, 65536, 1.5, "80", null, undefined, NaN]) {
      expect(isValidPort(bad)).toBe(false);
    }
  });
});

describe("isPortInUse", () => {
  it("is true while a listener holds the port and false once it is released", async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    expect(await isPortInUse(port)).toBe(true);
    await new Promise((r) => server.close(r));
    expect(await isPortInUse(port)).toBe(false);
  });

  it("falls back to a connect probe when the bind cannot answer (EADDRNOTAVAIL)", async () => {
    // 192.0.2.1 (TEST-NET-1) is not a local address: the bind fails with
    // EADDRNOTAVAIL, the connect then fails/times out → "free".
    expect(await isPortInUse(65000, "192.0.2.1", 100)).toBe(false);
  });
});
