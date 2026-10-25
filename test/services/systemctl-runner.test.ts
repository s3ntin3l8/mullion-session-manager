import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { armKillEscalation } from "../../src/services/systemctl-runner.js";

// KILL_ESCALATION_MAX_MS in systemctl-runner.ts. Not exported — this test
// pins the cap the production comment promises (sdkmanager's 10 minutes).
const CAP_MS = 600_000;

/**
 * The double for the `Pick<ChildProcess, "kill" | "exitCode" | "signalCode">`
 * the escalation helper takes. `signalCode` is `NodeJS.Signals | null` in
 * the real type — a plain `string | null` would not satisfy it — and `kill`
 * takes the optional signal the helper sends.
 */
function fakeChild(): Pick<ChildProcess, "kill" | "exitCode" | "signalCode"> {
  return {
    kill: vi.fn((_signal?: NodeJS.Signals | number) => true),
    exitCode: null,
    signalCode: null,
  };
}

describe("armKillEscalation budget", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires at the given budget when it is inside the cap", () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const onTimeout = vi.fn();
    armKillEscalation(child, 15_000, onTimeout);

    vi.advanceTimersByTime(14_999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith();
  });

  it("clamps a budget above 10 minutes to the cap instead of the 5s default", () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const onTimeout = vi.fn();
    armKillEscalation(child, 15 * 60_000, onTimeout);

    vi.advanceTimersByTime(5_000);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CAP_MS - 5_000 - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("keeps the 5s default for a non-positive budget", () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const onTimeout = vi.fn();
    armKillEscalation(child, 0, onTimeout);

    vi.advanceTimersByTime(4_999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();
  });
});
