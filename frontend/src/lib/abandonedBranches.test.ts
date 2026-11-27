// #3229 — the branches a "Start fresh" abandoned (the column the board card
// and the task sidebar read).
import { describe, it, expect } from "vitest";
import { describeAbandonedBranch, parseAbandonedBranches } from "./abandonedBranches.js";

describe("parseAbandonedBranches", () => {
  it("reads the recorded abandonments, oldest first", () => {
    const raw = JSON.stringify([
      { hostId: "macbook", branch: "mullion/task-1-a" },
      { hostId: null, branch: "mullion/task-1-a-attempt-2" },
    ]);
    expect(parseAbandonedBranches(raw)).toEqual([
      { hostId: "macbook", branch: "mullion/task-1-a" },
      { hostId: null, branch: "mullion/task-1-a-attempt-2" },
    ]);
  });

  it("reads anything unparseable as nothing abandoned, never as a crash", () => {
    expect(parseAbandonedBranches(null)).toEqual([]);
    expect(parseAbandonedBranches(undefined)).toEqual([]);
    expect(parseAbandonedBranches("")).toEqual([]);
    expect(parseAbandonedBranches("not json")).toEqual([]);
    expect(parseAbandonedBranches('{"branch":"x"}')).toEqual([]);
    expect(parseAbandonedBranches("[{}]")).toEqual([]);
    expect(parseAbandonedBranches('["x"]')).toEqual([]);
  });
});

describe("describeAbandonedBranch", () => {
  it("names the branch and the host it was left on", () => {
    const raw = JSON.stringify([
      { hostId: "macbook", branch: "mullion/task-1-a" },
      { hostId: "linux", branch: "mullion/task-1-a-attempt-2" },
    ]);
    expect(describeAbandonedBranch(raw)).toBe("mullion/task-1-a-attempt-2 on linux");
  });

  it("names the branch alone when it was abandoned on this machine", () => {
    const raw = JSON.stringify([{ hostId: null, branch: "mullion/task-1-a" }]);
    expect(describeAbandonedBranch(raw)).toBe("mullion/task-1-a");
  });

  it("has nothing to say when nothing was abandoned", () => {
    expect(describeAbandonedBranch(null)).toBeNull();
    expect(describeAbandonedBranch("[]")).toBeNull();
  });
});
