import { describe, it, expect } from "vitest";
import type { SessionInfo } from "../../src/services/pty-manager.js";
import {
  isShellTailHandoff,
  isShellTailNudgeDue,
  SHELL_TAIL_NUDGE_MS,
} from "../../src/services/task-turn-signals.js";

const MIN = 60_000;
const NOW = 1_700_000_000_000;
const CLAIMED = new Date(NOW - 60 * MIN);
const SHELL_JOB = { id: "b1", type: "shell", status: "running", description: "wait loop" };
const AGENT_JOB = { id: "a1", type: "agent", status: "running", description: "subagent" };

function makeInfo(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    workFinishedAt: NOW - 25 * MIN,
    lastTurnEndedAt: NOW - 25 * MIN,
    outstandingBackgroundTasks: [SHELL_JOB],
    ...over,
  } as SessionInfo;
}

describe("task-turn-signals shell tail nudge threshold", () => {
  it("exports SHELL_TAIL_NUDGE_MS as 20 minutes", () => {
    expect(SHELL_TAIL_NUDGE_MS).toBe(20 * MIN);
  });

  it("is false before SHELL_TAIL_NUDGE_MS even when isShellTailHandoff is true", () => {
    const info = makeInfo({
      workFinishedAt: NOW - 10 * MIN,
      lastTurnEndedAt: NOW - 10 * MIN,
    });
    expect(isShellTailHandoff("background", info, { claimedAt: CLAIMED }, NOW)).toBe(true);
    expect(isShellTailNudgeDue("background", info, { claimedAt: CLAIMED }, NOW)).toBe(false);
  });

  it("is true at and past SHELL_TAIL_NUDGE_MS when only shell jobs remain", () => {
    const atBoundary = makeInfo({
      workFinishedAt: NOW - SHELL_TAIL_NUDGE_MS,
      lastTurnEndedAt: NOW - SHELL_TAIL_NUDGE_MS,
    });
    expect(isShellTailNudgeDue("background", atBoundary, { claimedAt: CLAIMED }, NOW)).toBe(true);
    expect(isShellTailNudgeDue("tool_failure", atBoundary, { claimedAt: CLAIMED }, NOW)).toBe(true);
    expect(isShellTailNudgeDue("needs_input", atBoundary, { claimedAt: CLAIMED }, NOW)).toBe(true);
  });

  it("is false for non-shell-tail statuses, non-shell jobs, or pre-claim turns", () => {
    const info = makeInfo();
    expect(isShellTailNudgeDue("api_error", info, { claimedAt: CLAIMED }, NOW)).toBe(false);
    expect(isShellTailNudgeDue("finished", info, { claimedAt: CLAIMED }, NOW)).toBe(false);
    expect(
      isShellTailNudgeDue(
        "background",
        makeInfo({ outstandingBackgroundTasks: [SHELL_JOB, AGENT_JOB] }),
        { claimedAt: CLAIMED },
        NOW,
      ),
    ).toBe(false);
    expect(
      isShellTailNudgeDue("background", info, { claimedAt: new Date(NOW - 5 * MIN) }, NOW),
    ).toBe(false);
  });
});
