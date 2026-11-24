// Must come before any import that could load "node:child_process" — see
// test/helpers/mock-pty.ts's header. The constructor spawns `adb start-server`;
// a test must never let a real one fire (AGENTS.md, issue #1137).
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as ChildProcess from "node:child_process";
import { spawn as spawnChildProcess } from "node:child_process";
import os from "node:os";
import { DeviceManager } from "../../src/services/device-manager.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

function opts(overrides: Partial<ConstructorParameters<typeof DeviceManager>[0]> = {}) {
  return {
    enabled: true,
    adbPath: "/usr/bin/adb",
    adbServerPort: 5037,
    emulatorPath: "",
    scrcpyServerPath: "",
    sessionsDir: os.tmpdir(),
    ...overrides,
  };
}

const startServerCalls = () =>
  vi
    .mocked(spawnChildProcess)
    .mock.calls.filter((c) => (c[1] as readonly string[] | undefined)?.[0] === "start-server");

describe("DeviceManager adb start-server (#3436)", () => {
  beforeEach(() => {
    vi.mocked(spawnChildProcess).mockClear();
  });

  it("starts no adb server, and refuses Android kinds, when adbPath is empty", async () => {
    const results: unknown[] = [];
    const manager = new DeviceManager(
      opts({ adbPath: "", onAdbServerStart: (r) => results.push(r) }),
    );
    expect(startServerCalls()).toHaveLength(0);
    expect(results).toEqual([]);
    await expect(
      manager.getOrCreate({
        id: "7",
        kind: "physical",
        avdName: null,
        serial: "192.168.1.23:37251",
        label: null,
        port: null,
      }),
    ).rejects.toThrow(/Android devices are not configured/);
  });

  it("reports a synchronous spawn throw instead of crashing the constructor", () => {
    const results: Array<{ ok: boolean; error?: Error }> = [];
    vi.mocked(spawnChildProcess).mockImplementationOnce((() => {
      throw new TypeError("The argument 'file' cannot be empty");
    }) as typeof spawnChildProcess);
    expect(
      () => new DeviceManager(opts({ onAdbServerStart: (r) => results.push(r) })),
    ).not.toThrow();
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
  });
});
