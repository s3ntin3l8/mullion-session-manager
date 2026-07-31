import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isBackgroundTaskOutstanding,
  filterOutstandingBackgroundTasks,
  TERMINAL_STATUSES,
} from "../../src/services/background-tasks.js";
import type { BackgroundTask } from "../../src/services/hook-protocol.js";

function task(status: unknown, overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "t1",
    type: "shell",
    status: status as string,
    description: "tail logs",
    ...overrides,
  };
}

describe("isBackgroundTaskOutstanding", () => {
  it("treats a running task as outstanding", () => {
    expect(isBackgroundTaskOutstanding(task("running"))).toBe(true);
  });

  it.each(["completed", "failed", "stopped", "killed", "cancelled", "error", "done"])(
    "treats a %s task as terminal (not outstanding)",
    (status) => {
      expect(isBackgroundTaskOutstanding(task(status))).toBe(false);
    },
  );

  it("normalizes case and whitespace before matching", () => {
    expect(isBackgroundTaskOutstanding(task("  Completed  "))).toBe(false);
    expect(isBackgroundTaskOutstanding(task("COMPLETED"))).toBe(false);
  });

  it("treats a missing status as outstanding (conservative default)", () => {
    const noStatus = {
      id: "t1",
      type: "shell",
      description: "tail logs",
    } as unknown as BackgroundTask;
    expect(isBackgroundTaskOutstanding(noStatus)).toBe(true);
  });

  it("treats an unrecognized status as outstanding", () => {
    expect(isBackgroundTaskOutstanding(task("queued"))).toBe(true);
  });

  it("treats a non-string status as outstanding", () => {
    expect(isBackgroundTaskOutstanding(task(42))).toBe(true);
  });
});

describe("filterOutstandingBackgroundTasks", () => {
  it("keeps only outstanding entries", () => {
    const tasks = [task("running", { id: "a" }), task("completed", { id: "b" })];
    expect(filterOutstandingBackgroundTasks(tasks)).toEqual([tasks[0]]);
  });

  it("returns an empty array when everything is terminal", () => {
    expect(filterOutstandingBackgroundTasks([task("completed"), task("failed")])).toEqual([]);
  });
});

// Hermes review, PR #453 — frontend/src/eventDescriptions.ts keeps its own
// hand-mirrored copy of this module's terminal-status set (it can't import
// this file directly — separate npm workspace, no backend module access).
// Pins the two sets together with a textual read rather than a live import,
// so a status added to one but not the other fails CI instead of silently
// drifting.
describe("TERMINAL_STATUSES parity with frontend/src/eventDescriptions.ts", () => {
  it("matches TERMINAL_BACKGROUND_TASK_STATUSES exactly", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(dir, "../../frontend/src/eventDescriptions.ts"), "utf8");
    const match = source.match(/TERMINAL_BACKGROUND_TASK_STATUSES = new Set\(\[([\s\S]*?)\]\)/);
    expect(match).not.toBeNull();
    const frontendStatuses = new Set(
      [...(match?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    );
    expect(frontendStatuses.size).toBeGreaterThan(0);
    expect(frontendStatuses).toEqual(TERMINAL_STATUSES);
  });
});
