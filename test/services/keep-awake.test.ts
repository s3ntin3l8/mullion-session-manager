import { describe, it, expect, vi, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { startKeepAwake, CAFFEINATE_ARGS } from "../../src/services/keep-awake.js";

// Issue #1719 (roadmap 8.5) — the `caffeinate` keep-awake.
//
// The spawn is INJECTED rather than module-mocked, so the arm/disarm
// lifecycle is driven directly with no global patching (AGENTS.md: mock
// node:child_process's spawn — issue #1137 — and injecting it is the
// cleanest way to do exactly that).

interface FakeChild {
  on(event: string, cb: (arg?: unknown) => void): FakeChild;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
  emit(event: string, arg?: unknown): void;
}

function fakeChild(): FakeChild {
  const handlers = new Map<string, (arg?: unknown) => void>();
  const child: FakeChild = {
    on(event, cb) {
      handlers.set(event, cb);
      return child;
    },
    kill: vi.fn(),
    unref: vi.fn(),
    emit(event, arg) {
      handlers.get(event)?.(arg);
    },
  };
  return child;
}

function mockApp(options: { keepAwake?: boolean; alive?: boolean } = {}): FastifyInstance {
  const alive = options.keepAwake ?? true;
  return {
    config: { MULLION_KEEP_AWAKE: alive },
    pty: { list: () => [{ id: "s1", alive: true }] },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as FastifyInstance;
}

describe("startKeepAwake", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is completely inert off darwin — no timer, no child", () => {
    vi.useFakeTimers();
    const spawnFn = vi.fn();
    const app = mockApp();

    const keepAwake = startKeepAwake(app, { platform: "linux", spawnFn: spawnFn as never });

    keepAwake.sync();
    vi.advanceTimersByTime(60_000);

    expect(spawnFn).not.toHaveBeenCalled();
    expect(keepAwake.isArmed()).toBe(false);
    keepAwake.stop();
  });

  it("is inert when MULLION_KEEP_AWAKE is off", () => {
    vi.useFakeTimers();
    const spawnFn = vi.fn();
    const app = mockApp({ keepAwake: false });

    const keepAwake = startKeepAwake(app, { platform: "darwin", spawnFn: spawnFn as never });

    keepAwake.sync();
    vi.advanceTimersByTime(60_000);

    expect(spawnFn).not.toHaveBeenCalled();
    expect(keepAwake.isArmed()).toBe(false);
    keepAwake.stop();
  });

  it("spawns caffeinate -dimsu -w <pid> while there are live sessions", () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const app = mockApp();

    const keepAwake = startKeepAwake(app, { platform: "darwin", spawnFn: spawnFn as never });
    keepAwake.sync();

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [command, args] = spawnFn.mock.calls[0] as [string, string[]];
    expect(command).toBe("caffeinate");
    expect(args).toEqual([...CAFFEINATE_ARGS, "-w", String(process.pid)]);
    // -w <pid> is load-bearing: launchd's AbandonProcessGroup=true means
    // launchd does NOT signal the job's children, so without it an
    // orphaned caffeinate would hold the assertion forever.
    expect(args).toContain("-w");
    expect(keepAwake.isArmed()).toBe(true);
    keepAwake.stop();
  });

  it("does not arm when there are no live sessions", () => {
    vi.useFakeTimers();
    const spawnFn = vi.fn(() => fakeChild());
    const app = mockApp();
    (app.pty as unknown as { list: () => unknown[] }).list = () => [];

    const keepAwake = startKeepAwake(app, { platform: "darwin", spawnFn: spawnFn as never });
    keepAwake.sync();

    expect(spawnFn).not.toHaveBeenCalled();
    expect(keepAwake.isArmed()).toBe(false);
    keepAwake.stop();
  });

  it("ignores an exited session — only a LIVE session holds the assertion", () => {
    vi.useFakeTimers();
    const spawnFn = vi.fn(() => fakeChild());
    const app = mockApp();
    (app.pty as unknown as { list: () => unknown[] }).list = () => [{ id: "s1", alive: false }];

    const keepAwake = startKeepAwake(app, { platform: "darwin", spawnFn: spawnFn as never });
    keepAwake.sync();

    expect(spawnFn).not.toHaveBeenCalled();
    keepAwake.stop();
  });

  it("terminates the child with SIGTERM when the last session goes away", () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const app = mockApp();
    let live = true;
    (app.pty as unknown as { list: () => unknown[] }).list = () => [{ id: "s1", alive: live }];

    const keepAwake = startKeepAwake(app, { platform: "darwin", spawnFn: spawnFn as never });
    keepAwake.sync();
    expect(keepAwake.isArmed()).toBe(true);

    live = false;
    keepAwake.sync();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(keepAwake.isArmed()).toBe(false);
    keepAwake.stop();
  });

  it("terminates the child when the service is stopped", () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);

    const keepAwake = startKeepAwake(mockApp(), { platform: "darwin", spawnFn: spawnFn as never });
    keepAwake.sync();
    keepAwake.stop();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(keepAwake.isArmed()).toBe(false);
    // stop() is idempotent.
    expect(() => keepAwake.stop()).not.toThrow();
  });

  it("tolerates a missing caffeinate binary: warns once, arms nothing, and does not throw", () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const app = mockApp();

    const keepAwake = startKeepAwake(app, { platform: "darwin", spawnFn: spawnFn as never });
    keepAwake.sync();
    expect(keepAwake.isArmed()).toBe(true);

    // The spawn fails asynchronously — node reports a missing binary through
    // the child's "error" event.
    child.emit("error", new Error("spawn caffeinate ENOENT"));

    expect(keepAwake.isArmed()).toBe(false);
    expect(app.log.warn).toHaveBeenCalledTimes(1);

    // A later tick must not re-warn, and must not re-arm.
    keepAwake.sync();
    vi.advanceTimersByTime(60_000);
    expect(app.log.warn).toHaveBeenCalledTimes(1);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    keepAwake.stop();
  });

  it("re-arms after the child exits on its own, so a killed caffeinate is replaced", () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const app = mockApp();

    const keepAwake = startKeepAwake(app, { platform: "darwin", spawnFn: spawnFn as never });
    keepAwake.sync();
    expect(spawnFn).toHaveBeenCalledTimes(1);

    // caffeinate exits by itself (e.g. its own -w target died).
    child.emit("exit", 0);
    expect(keepAwake.isArmed()).toBe(false);

    keepAwake.sync();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    keepAwake.stop();
  });

  it("keeps the assertion armed when the live-session list cannot be read", () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const app = mockApp();

    const keepAwake = startKeepAwake(app, { platform: "darwin", spawnFn: spawnFn as never });
    keepAwake.sync();
    expect(keepAwake.isArmed()).toBe(true);

    // A failure to read the session list must never disarm the keep-awake on
    // a guess — an armed-but-unnecessary assertion is far less harmful than a
    // disarmed machine that idles into the middle of a build.
    (app.pty as unknown as { list: () => unknown[] }).list = () => {
      throw new Error("pty exploded");
    };
    keepAwake.sync();

    expect(keepAwake.isArmed()).toBe(true);
    expect(app.log.error).toHaveBeenCalled();
    keepAwake.stop();
  });

  it("tolerates a kill() that throws — the child may already be gone", () => {
    vi.useFakeTimers();
    const child = fakeChild();
    child.kill.mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const spawnFn = vi.fn(() => child);
    const app = mockApp();

    const keepAwake = startKeepAwake(app, { platform: "darwin", spawnFn: spawnFn as never });
    keepAwake.sync();
    expect(keepAwake.isArmed()).toBe(true);

    // Disarming must not throw out of the timer callback.
    expect(() => keepAwake.stop()).not.toThrow();
    expect(app.log.debug).toHaveBeenCalled();
  });

  it("tolerates a spawn() that throws synchronously — warns once and arms nothing", () => {
    vi.useFakeTimers();
    const spawnFn = vi.fn(() => {
      throw new Error("spawn caffeinate EACCES");
    });
    const app = mockApp();

    const keepAwake = startKeepAwake(app, { platform: "darwin", spawnFn: spawnFn as never });
    expect(() => keepAwake.sync()).not.toThrow();

    expect(keepAwake.isArmed()).toBe(false);
    expect(app.log.warn).toHaveBeenCalledTimes(1);

    // A later tick must not re-warn, and must not re-arm.
    keepAwake.sync();
    vi.advanceTimersByTime(60_000);
    expect(app.log.warn).toHaveBeenCalledTimes(1);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    keepAwake.stop();
  });

  it("arms on its own timer, without an explicit sync()", () => {
    vi.useFakeTimers();
    const spawnFn = vi.fn(() => fakeChild());

    const keepAwake = startKeepAwake(mockApp(), {
      platform: "darwin",
      spawnFn: spawnFn as never,
      intervalMs: 10_000,
    });

    vi.advanceTimersByTime(10_000);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    keepAwake.stop();
  });
});
