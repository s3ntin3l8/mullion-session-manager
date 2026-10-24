import { describe, it, expect, vi, afterEach } from "vitest";
import type * as ChildProcess from "node:child_process";

/**
 * `runShellCapture` is the shared spawn/timeout/kill machinery behind the
 * login-shell probe (`login-shell.ts`) and the interactive-shell resolver
 * (`user-shell-env.ts`) — issue #1833.
 *
 * It has to be safe to call from a test that stands in for `spawn`, and safe
 * when its deadline fires.
 */

const spawnMock = vi.fn();

// The original module is spread through, so anything else in this test's
// module graph that imports from node:child_process still gets the real
// exports — only `spawn` is replaced.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

import { runShellCapture } from "../../src/services/shell-spawn.js";

/** A stand-in for a spawned child, with the pieces the helper touches. */
function fakeChild(overrides: Record<string, unknown> = {}) {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const stdoutHandlers: Record<string, (chunk: Buffer) => void> = {};
  return {
    child: {
      stdout: {
        on: (event: string, fn: (chunk: Buffer) => void) => {
          stdoutHandlers[event] = fn;
        },
        off: vi.fn(),
      },
      on: (event: string, fn: (...args: unknown[]) => void) => {
        handlers[event] = fn;
      },
      kill: vi.fn(),
      exitCode: 0,
      signalCode: null,
      ...overrides,
    },
    handlers,
    stdoutHandlers,
  };
}

const baseOptions = {
  shell: "/bin/bash",
  args: ["-lc", "echo hello"],
  env: {} as NodeJS.ProcessEnv,
  timeoutMs: 5_000,
  killEscalationMs: 2_000,
  trim: true,
};

describe("runShellCapture", () => {
  afterEach(() => {
    vi.useRealTimers();
    spawnMock.mockReset();
  });

  it("resolves the script's stdout, trimmed", async () => {
    const { child, handlers, stdoutHandlers } = fakeChild();
    spawnMock.mockImplementation(() => child);

    const promise = runShellCapture(baseOptions);
    stdoutHandlers.data?.(Buffer.from("hello\n"));
    handlers.close?.();

    expect(await promise).toBe("hello");
  });

  it("resolves the RAW stdout when trim is off", async () => {
    // The interactive-shell resolver needs the raw text: it carries its
    // sentinel markers.
    const { child, handlers, stdoutHandlers } = fakeChild();
    spawnMock.mockImplementation(() => child);

    const promise = runShellCapture({ ...baseOptions, trim: false });
    stdoutHandlers.data?.(Buffer.from("  hello  "));
    handlers.close?.();

    expect(await promise).toBe("  hello  ");
  });

  it("resolves null for an empty result when trim is on, and an empty string when it is off", async () => {
    const first = fakeChild();
    spawnMock.mockImplementation(() => first.child);
    const trimmed = runShellCapture(baseOptions);
    first.handlers.close?.();
    expect(await trimmed).toBeNull();

    const second = fakeChild();
    spawnMock.mockImplementation(() => second.child);
    const raw = runShellCapture({ ...baseOptions, trim: false });
    second.handlers.close?.();
    expect(await raw).toBe("");
  });

  it("resolves null and reports the failure when the shell cannot be launched", async () => {
    const { child, handlers } = fakeChild();
    spawnMock.mockImplementation(() => child);

    const onError = vi.fn();
    const promise = runShellCapture({ ...baseOptions, onError });
    handlers.error?.(new Error("spawn ENOENT"));

    expect(await promise).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    // No `pid` — the spawn itself failed.
    expect(onError.mock.calls[0]?.[1]).toBe(false);
  });

  // The child's 'error' event does not only mean the spawn failed: a KILL
  // that fails produces one too (the deadline's SIGTERM, against a shell that
  // refuses it). Node leaves `pid` undefined when the spawn failed and sets it
  // once the child is really running, and the caller needs to tell those
  // apart — "failed to spawn" is the wrong thing to log about the second.
  it("tells onError whether the child ever started", async () => {
    const started = fakeChild({ pid: 4321 });
    spawnMock.mockImplementation(() => started.child);

    const onError = vi.fn();
    const promise = runShellCapture({ ...baseOptions, onError });
    started.handlers.error?.(new Error("kill EPERM"));

    expect(await promise).toBeNull();
    expect(onError.mock.calls[0]?.[1]).toBe(true);
  });

  // The regression this pins (issue #1845): the helper settles its promise
  // from the child's 'error' event, and settling cancels the deadline that
  // would have ended the child. So a child that had actually STARTED and then
  // failed was left running for the rest of the process's life — nothing else
  // would ever end it.
  //
  // The helper's contract is now "when this settles, the child is dead or is
  // about to be killed", so the error path ends a live child the same way the
  // deadline does.
  it("ends a child that fails after it started (issue #1845)", async () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const { child, handlers } = fakeChild({
      kill,
      pid: 4321,
      exitCode: null,
      signalCode: null,
    });
    spawnMock.mockImplementation(() => child);

    const promise = runShellCapture(baseOptions);
    const assertion = expect(promise).resolves.toBeNull();

    // The child fails BEFORE the deadline.
    handlers.error?.(new Error("kill EPERM"));

    // It is ended rather than left running: SIGTERM first (kill() with no
    // argument — SIGTERM is the default signal).
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill.mock.calls[0]?.[0]).toBeUndefined();

    // And if it ignores that, the escalation still fires.
    await vi.advanceTimersByTimeAsync(baseOptions.killEscalationMs);
    expect(kill).toHaveBeenCalledWith("SIGKILL");

    await assertion;
  });

  it("does not kill a child that never started", async () => {
    const kill = vi.fn();
    // No `pid`: the spawn itself failed, so there is no child to end.
    const { child, handlers } = fakeChild({ kill, exitCode: null, signalCode: null });
    spawnMock.mockImplementation(() => child);

    const promise = runShellCapture(baseOptions);
    handlers.error?.(new Error("spawn ENOENT"));

    expect(await promise).toBeNull();
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not kill a child that already exited", async () => {
    const kill = vi.fn();
    // A pid, but the process is already gone (exitCode is set) — there is
    // nothing left to signal.
    const { child, handlers } = fakeChild({ kill, pid: 4321, exitCode: 0, signalCode: null });
    spawnMock.mockImplementation(() => child);

    const promise = runShellCapture(baseOptions);
    handlers.error?.(new Error("kill EPERM"));

    expect(await promise).toBeNull();
    expect(kill).not.toHaveBeenCalled();
  });

  it("calls onTimeout when the deadline fires", async () => {
    vi.useFakeTimers();
    const { child } = fakeChild({ kill: undefined });
    spawnMock.mockImplementation(() => child);

    const onTimeout = vi.fn();
    const promise = runShellCapture({ ...baseOptions, onTimeout });
    const assertion = expect(promise).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(baseOptions.timeoutMs);

    expect(onTimeout).toHaveBeenCalledTimes(1);
    await assertion;
  });

  // The regression this pins: on the deadline, the probe kills the child. A
  // stand-in for `spawn` may have no `kill` at all — and an unguarded
  // `child.kill()` inside a TIMER callback throws an UNHANDLED exception,
  // which is fatal to the whole process, not just to the probe. That is
  // exactly what happened when `test/plugins/hooks.test.ts` replaced
  // `node:child_process`'s `spawn` with a stand-in: the full suite reported
  // "TypeError: child.kill is not a function" as an uncaught exception.
  it("resolves null on the deadline without throwing, even for a child with no kill()", async () => {
    vi.useFakeTimers();
    const { child } = fakeChild({
      // No `kill` at all — the shape a test double takes.
      kill: undefined,
    });
    spawnMock.mockImplementation(() => child);

    const promise = runShellCapture(baseOptions);
    const assertion = expect(promise).resolves.toBeNull();

    // Past the deadline AND its SIGKILL escalation.
    await vi.advanceTimersByTimeAsync(8_000);

    await assertion;
  });

  it("escalates to SIGKILL when the child is still alive after the grace period", async () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const { child } = fakeChild({ kill, exitCode: null, signalCode: null });
    spawnMock.mockImplementation(() => child);

    const promise = runShellCapture(baseOptions);
    const assertion = expect(promise).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(baseOptions.timeoutMs);
    // SIGTERM first — `kill()` with no argument, because SIGTERM is the
    // default signal.
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill.mock.calls[0]?.[0]).toBeUndefined();

    await vi.advanceTimersByTimeAsync(baseOptions.killEscalationMs);
    expect(kill).toHaveBeenCalledWith("SIGKILL");

    await assertion;
  });

  // The regression this pins: after the deadline has fired and the child has
  // been SIGTERMed, an 'error' on the child (a SIGTERM that failed with
  // EPERM, say) must NOT cancel the pending SIGKILL escalation. The child
  // ignored our cooperative attempt to end it, and it may well still be
  // alive — cancelling the escalation there leaves the runaway shell running.
  it("still escalates to SIGKILL when the child errors after the deadline", async () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    // `pid` set, so the error path's "a child that started" branch really
    // runs here: the escalation is already armed, so arming it again is a
    // no-op and the SIGKILL still comes — and the SIGTERM is NOT sent twice.
    const { child, handlers } = fakeChild({
      kill,
      pid: 4321,
      exitCode: null,
      signalCode: null,
    });
    spawnMock.mockImplementation(() => child);

    const onError = vi.fn();
    const promise = runShellCapture({ ...baseOptions, onError });
    const assertion = expect(promise).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(baseOptions.timeoutMs);
    expect(kill).toHaveBeenCalledTimes(1); // SIGTERM

    // The kill failed. The child may still be running.
    handlers.error?.(new Error("kill EPERM"));
    expect(onError).toHaveBeenCalledTimes(1);
    // The child has already been asked to stop — no second SIGTERM.
    expect(kill).toHaveBeenCalledTimes(1);

    // The escalation is still armed — the child is still alive.
    await vi.advanceTimersByTimeAsync(baseOptions.killEscalationMs);
    expect(kill).toHaveBeenCalledWith("SIGKILL");

    await assertion;
  });

  // Real timers here: the point is whether the escalation timer HOLDS THE
  // PROCESS OPEN, which is what `hasRef()` reports.
  const captureTimers = async (
    options: Partial<typeof baseOptions>,
  ): Promise<Array<NodeJS.Timeout>> => {
    const timers: NodeJS.Timeout[] = [];
    const original = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      const timer = original(fn, ms, ...rest) as NodeJS.Timeout;
      timers.push(timer);
      return timer;
    }) as unknown as typeof globalThis.setTimeout);
    try {
      const { child } = fakeChild({ kill: vi.fn(), exitCode: null, signalCode: null });
      spawnMock.mockImplementation(() => child);
      await runShellCapture({
        ...baseOptions,
        timeoutMs: 5,
        killEscalationMs: 60_000,
        ...options,
      });
      return timers;
    } finally {
      spy.mockRestore();
    }
  };

  it("unrefs the escalation timer when asked, so it cannot hold the process open", async () => {
    const timers = await captureTimers({ unrefEscalationTimer: true });
    // timers[0] is the deadline, timers[1] the SIGKILL escalation.
    expect(timers).toHaveLength(2);
    expect(timers[1]?.hasRef()).toBe(false);
  });

  it("leaves the escalation timer referenced by default, so the SIGKILL still gets its chance", async () => {
    const timers = await captureTimers({});
    expect(timers).toHaveLength(2);
    expect(timers[1]?.hasRef()).toBe(true);
  });
});
