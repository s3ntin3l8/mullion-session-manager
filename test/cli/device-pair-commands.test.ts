import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { runCommand } from "../../src/cli/core.mjs";

function fakeIo() {
  const written: Buffer[] = [];
  return {
    stdin: new EventEmitter(),
    stdout: { write: vi.fn((chunk: Buffer | string) => written.push(Buffer.from(chunk))) },
    stderr: { write: vi.fn() },
    written,
    getSize: () => ({ cols: 80, rows: 24 }),
    onResize: () => () => {},
    onInterrupt: () => {},
    setRawMode: vi.fn(),
    env: {},
    gitTarget: (): { repo?: string; branch?: string } => ({}),
  };
}

function fakeClient(overrides: Partial<{ request: unknown }> = {}) {
  return {
    tokenSource: "MULLION_AUTH_TOKEN",
    close: vi.fn(),
    request: vi.fn(async () => ({ ok: true })),
    openStream: vi.fn(),
    ...overrides,
  };
}

describe("mullion device --host (#3399)", () => {
  it("device pair forwards --host as hostId (#3399)", async () => {
    const client = fakeClient();
    await runCommand(["device", "pair", "192.168.1.23:41234", "123456", "--host", "h-pi"], {
      client,
      io: fakeIo(),
    });
    expect(client.request).toHaveBeenCalledWith("device.pair", {
      pairingAddress: "192.168.1.23:41234",
      pairingCode: "123456",
      hostId: "h-pi",
    });
  });

  it("device pair accepts --host before the positionals too", async () => {
    const client = fakeClient();
    await runCommand(["device", "pair", "--host", "h-pi", "192.168.1.23:41234", "123456"], {
      client,
      io: fakeIo(),
    });
    expect(client.request).toHaveBeenCalledWith("device.pair", {
      pairingAddress: "192.168.1.23:41234",
      pairingCode: "123456",
      hostId: "h-pi",
    });
  });

  it("device discovered and pair-and-connect forward --host as hostId (#3399)", async () => {
    const client = fakeClient();
    await runCommand(["device", "discovered", "--host", "h-pi"], { client, io: fakeIo() });
    expect(client.request).toHaveBeenCalledWith("device.discovered", { hostId: "h-pi" });
    await runCommand(
      [
        "device",
        "pair-and-connect",
        "--discovery-id",
        "1.2.3.4",
        "--pairing-code",
        "123456",
        "--host",
        "h-pi",
      ],
      { client, io: fakeIo() },
    );
    expect(client.request).toHaveBeenLastCalledWith("device.pair-and-connect", {
      pairingCode: "123456",
      discoveryId: "1.2.3.4",
      hostId: "h-pi",
    });
  });
});
