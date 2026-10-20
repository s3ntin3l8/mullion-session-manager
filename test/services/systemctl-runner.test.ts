import { afterEach, describe, expect, it, vi } from "vitest";
import { armKillEscalation } from "../../src/services/systemctl-runner.js";

// KILL_ESCALATION_MAX_MS in systemctl-runner.ts. Not exported — this test
// pins the cap the production comment promises (sdkmanager's 10 minutes).
const CAP_MS = 600_000;

function fakeChild() {
  return { kill: vi.fn(), exitCode: null as number | null, signalCode: null as string | null };
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
