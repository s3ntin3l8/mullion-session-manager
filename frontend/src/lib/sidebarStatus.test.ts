import { describe, expect, it } from "vitest";
import type { GitStatus, NotificationEvent, SubagentInfo } from "../api/index.js";
import {
  backgroundTaskLetter,
  fileChangeDotClass,
  fileChangeLetter,
  isSubagentLive,
  sessionGitDotClass,
  sessionPrDotClass,
  subagentDotClass,
  summarizeFileChanges,
} from "./sidebarStatus.js";

function makeGitStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: "main",
    hash: "abc123",
    ahead: 0,
    behind: 0,
    files: [],
    isClean: true,
    hasConflicts: false,
    ...overrides,
  };
}

function makeSubagent(overrides: Partial<SubagentInfo> = {}): SubagentInfo {
  return {
    agentId: "agent-1",
    agentType: "reviewer",
    startedAt: 1000,
    endedAt: null,
    summary: null,
    fileChanges: 0,
    toolFailures: 0,
    eventCount: 0,
    ...overrides,
  };
}

function makeFileChangeEvent(
  seq: number,
  path: string,
  action: "modify" | "create" | "delete",
): NotificationEvent {
  return { seq, sessionId: 1, kind: "file_change", ts: seq, payload: { path, action } };
}

describe("sessionGitDotClass", () => {
  it("returns conflict when hasConflicts is true, regardless of isClean", () => {
    expect(sessionGitDotClass(makeGitStatus({ hasConflicts: true, isClean: true }))).toBe(
      "conflict",
    );
  });

  it("returns clean when there are no conflicts and the tree is clean", () => {
    expect(sessionGitDotClass(makeGitStatus({ isClean: true }))).toBe("clean");
  });

  it("returns dirty when there are no conflicts but the tree isn't clean", () => {
    expect(sessionGitDotClass(makeGitStatus({ isClean: false }))).toBe("dirty");
  });
});

describe("sessionPrDotClass", () => {
  it("maps success -> good, failure -> bad, in_progress -> pending, null -> none", () => {
    expect(sessionPrDotClass("success")).toBe("good");
    expect(sessionPrDotClass("failure")).toBe("bad");
    expect(sessionPrDotClass("in_progress")).toBe("pending");
    expect(sessionPrDotClass(null)).toBe("none");
  });
});

describe("isSubagentLive / subagentDotClass", () => {
  it("is live (and dot is pending) when endedAt is null", () => {
    const subagent = makeSubagent({ endedAt: null });
    expect(isSubagentLive(subagent)).toBe(true);
    expect(subagentDotClass(subagent)).toBe("pending");
  });

  it("is not live (and dot is good) once endedAt is set", () => {
    const subagent = makeSubagent({ endedAt: 2000 });
    expect(isSubagentLive(subagent)).toBe(false);
    expect(subagentDotClass(subagent)).toBe("good");
  });
});

describe("backgroundTaskLetter", () => {
  it("uppercases the first letter of the type", () => {
    expect(backgroundTaskLetter("shell")).toBe("S");
    expect(backgroundTaskLetter("mcp")).toBe("M");
  });

  it("falls back to ? for an empty or non-string type", () => {
    expect(backgroundTaskLetter("")).toBe("?");
    // validateBackgroundTasksField only guarantees a non-null object, not
    // that `type` is a non-empty string — exercise that malformed-input path.
    expect(backgroundTaskLetter(undefined as unknown as string)).toBe("?");
  });
});

describe("summarizeFileChanges", () => {
  it("returns [] for undefined events", () => {
    expect(summarizeFileChanges(undefined)).toEqual([]);
  });

  it("ignores non-file_change events and malformed file_change payloads", () => {
    const events: NotificationEvent[] = [
      { seq: 1, sessionId: 1, kind: "attention", ts: 1, payload: {} },
      {
        seq: 2,
        sessionId: 1,
        kind: "file_change",
        ts: 2,
        payload: { path: 123, action: "modify" },
      },
      {
        seq: 3,
        sessionId: 1,
        kind: "file_change",
        ts: 3,
        payload: { path: "a.ts", action: "rename" },
      },
    ];
    expect(summarizeFileChanges(events)).toEqual([]);
  });

  it("collapses repeated touches to one path, keeping the latest action/seq and a running count", () => {
    const events = [
      makeFileChangeEvent(1, "a.ts", "create"),
      makeFileChangeEvent(2, "a.ts", "modify"),
      makeFileChangeEvent(3, "b.ts", "modify"),
      makeFileChangeEvent(4, "a.ts", "modify"),
    ];
    const result = summarizeFileChanges(events);
    expect(result).toEqual([
      { path: "a.ts", action: "modify", count: 3, lastSeq: 4 },
      { path: "b.ts", action: "modify", count: 1, lastSeq: 3 },
    ]);
  });

  it("sorts by most-recently-touched path first", () => {
    const events = [
      makeFileChangeEvent(1, "old.ts", "modify"),
      makeFileChangeEvent(2, "new.ts", "create"),
    ];
    const result = summarizeFileChanges(events);
    expect(result.map((r) => r.path)).toEqual(["new.ts", "old.ts"]);
  });
});

describe("fileChangeDotClass / fileChangeLetter", () => {
  it("maps create -> good/A, delete -> bad/D, modify -> pending/M", () => {
    expect(fileChangeDotClass("create")).toBe("good");
    expect(fileChangeLetter("create")).toBe("A");
    expect(fileChangeDotClass("delete")).toBe("bad");
    expect(fileChangeLetter("delete")).toBe("D");
    expect(fileChangeDotClass("modify")).toBe("pending");
    expect(fileChangeLetter("modify")).toBe("M");
  });
});
