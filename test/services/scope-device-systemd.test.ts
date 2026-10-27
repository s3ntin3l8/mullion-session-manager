import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import type * as DeviceProcess from "../../src/services/device-process.js";

// Issue #1854 — the Linux device-scope backend is the pre-migration inline launch
// moved behind ScopeBackend. device-manager*.test.ts cover it end to end; this file
// pins the seam-level contract (resolve/reject/onExit timing and the delegation).

const spawnCalls: Array<{ file: string; args: string[] }> = [];
let exitHook: ((child: EventEmitter) => void) | null = null;
let lastChild: EventEmitter | null = null;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((file: string, args: string[]) => {
      spawnCalls.push({ file, args });
      const child = new EventEmitter();
      lastChild = child;
      setImmediate(() => exitHook?.(child));
      return child;
    }),
  };
});

const stopDeviceScope = vi.fn(async () => {});
const isDeviceAliveStateBatch = vi.fn(async (_d: unknown, _i: unknown, ids: string[]) =>
  Object.fromEntries(ids.map((id) => [id, "alive"])),
);
vi.mock("../../src/services/device-process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof DeviceProcess>()),
  stopDeviceScope: (...a: unknown[]) => (stopDeviceScope as (...x: unknown[]) => unknown)(...a),
  isDeviceAliveStateBatch: (...a: unknown[]) =>
    (isDeviceAliveStateBatch as (...x: unknown[]) => unknown)(...a),
}));

const { SystemdDeviceScopeBackend } = await import("../../src/services/scope/device-systemd.js");

const spec = (over: Record<string, unknown> = {}) => ({
  id: "3",
  argv: ["/sdk/emulator/emulator", "-avd", "dev35"],
  cwd: "/tmp",
  env: {},
  timeoutMs: 1000,
  label: "device bootstrap",
  ...over,
});

beforeEach(() => {
  spawnCalls.length = 0;
  exitHook = null;
  lastChild = null;
  stopDeviceScope.mockClear();
  isDeviceAliveStateBatch.mockClear();
});

describe("SystemdDeviceScopeBackend", () => {
  it("wraps the program in systemd-run --user --scope with the marker Description", async () => {
    const backend = new SystemdDeviceScopeBackend({ sessionsDir: "/sess" });
    await backend.start(spec());
    const { file, args } = spawnCalls[0];
    expect(file).toBe("systemd-run");
    expect(args.slice(0, 3)).toEqual(["--user", "--scope", "--collect"]);
    expect(args[args.indexOf("--description") + 1]).toMatch(
      /^mullion-device -m \/sess\/3\.device$/,
    );
    expect(args.slice(args.indexOf("--") + 1)).toEqual(["/sdk/emulator/emulator", "-avd", "dev35"]);
  });

  it("rejects when the supervisor exits non-zero before the launch settles, naming the unit", async () => {
    exitHook = (child) => child.emit("exit", 1);
    const backend = new SystemdDeviceScopeBackend({ sessionsDir: "/sess" });
    await expect(backend.start(spec())).rejects.toThrow(
      /^device bootstrap exited with code 1 \(unit crs-device-[0-9a-f]+-3\)$/,
    );
  });

  it("rejects on a spawn error before the launch settles", async () => {
    exitHook = (child) => child.emit("error", new Error("spawn systemd-run ENOENT"));
    const backend = new SystemdDeviceScopeBackend({ sessionsDir: "/sess" });
    await expect(backend.start(spec())).rejects.toThrow(/ENOENT/);
  });

  it("resolves on a zero exit inside the bootstrap window", async () => {
    exitHook = (child) => child.emit("exit", 0);
    const backend = new SystemdDeviceScopeBackend({ sessionsDir: "/sess" });
    await expect(backend.start(spec())).resolves.toBeUndefined();
  });

  it("reports a later exit and a later error through onExit", async () => {
    const onExit = vi.fn();
    const backend = new SystemdDeviceScopeBackend({ sessionsDir: "/sess" });
    await backend.start(spec({ onExit }));
    lastChild?.emit("exit", 2);
    expect(onExit).toHaveBeenCalledWith({
      code: 2,
      scopeName: expect.stringMatching(/^crs-device-[0-9a-f]+-3$/),
    });
    lastChild?.emit("error", new Error("late"));
    expect(onExit).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: null, error: expect.any(Error) }),
    );
  });

  it("delegates liveness and stop to device-process, and lists no processes", async () => {
    const backend = new SystemdDeviceScopeBackend({ sessionsDir: "/sess" });
    expect(await backend.isAliveBatch(["1", "2"])).toEqual({ "1": "alive", "2": "alive" });
    expect(isDeviceAliveStateBatch).toHaveBeenCalledWith(
      new Set(["/sess"]),
      expect.stringMatching(/^[0-9a-f]+$/),
      ["1", "2"],
    );
    await backend.stop("1");
    expect(stopDeviceScope).toHaveBeenCalledWith(new Set(["/sess"]), expect.any(String), "1");
    expect(await backend.listProcesses()).toEqual([]);
  });
});
