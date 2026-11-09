import { describe, it, expect } from "vitest";
import {
  BLOCKED_STACK_MIN,
  columnItems,
  epicColourSlot,
  epicColourVar,
  epicProgress,
  epicUrl,
  groupLanes,
  isCardDensity,
  isGroupBy,
  laneKeyOf,
} from "./taskLanes.js";
import { NO_EPIC } from "./taskFilters.js";
import { makeTask } from "../test/fixtures.js";

const epic = (n: number, title: string | null = `Epic ${n}`) => ({
  parentIssueNumber: n,
  parentIssueRepo: "acme/widgets",
  parentIssueTitle: title,
});
const blockedBy = (...numbers: number[]) => ({
  blockedState: "blocked" as const,
  blockers: numbers.map((number) => ({
    owner: "acme",
    repo: "widgets",
    number,
    title: `b${number}`,
    htmlUrl: `https://github.com/acme/widgets/issues/${number}`,
  })),
});

describe("settings guards", () => {
  it("accepts only the known group-by and density values", () => {
    expect(["none", "epic", "project"].every(isGroupBy)).toBe(true);
    expect(isGroupBy("status")).toBe(false);
    expect(isGroupBy(null)).toBe(false);
    expect(isCardDensity("compact") && isCardDensity("comfortable")).toBe(true);
    expect(isCardDensity("tiny")).toBe(false);
  });
});

describe("epic colour", () => {
  it("is a stable slot in 1..6 per epic key", () => {
    for (const key of ["acme/widgets#1", "acme/widgets#2", "x/y#99", "a#0"]) {
      const slot = epicColourSlot(key);
      expect(slot).toBeGreaterThanOrEqual(1);
      expect(slot).toBeLessThanOrEqual(6);
      expect(epicColourSlot(key)).toBe(slot);
    }
  });

  it("spreads different epics over more than one slot", () => {
    const slots = new Set(
      Array.from({ length: 30 }, (_, i) => epicColourSlot(`acme/widgets#${i}`)),
    );
    expect(slots.size).toBeGreaterThan(1);
  });

  it("names the --lane token for a task with an epic and nothing without one", () => {
    expect(epicColourVar(makeTask({ ...epic(10) }))).toBe(
      `var(--lane-${epicColourSlot("acme/widgets#10")})`,
    );
    expect(epicColourVar(makeTask({}))).toBeNull();
  });

  it("builds the epic's GitHub URL", () => {
    expect(epicUrl(makeTask({ ...epic(10) }))).toBe("https://github.com/acme/widgets/issues/10");
    expect(epicUrl(makeTask({}))).toBeNull();
  });
});

describe("groupLanes", () => {
  const projectsById = new Map([
    [1, { name: "demo" }],
    [2, { name: "other" }],
  ]);

  it("returns one untitled lane holding everything when ungrouped", () => {
    const tasks = [makeTask({ id: 1 }), makeTask({ id: 2 })];
    expect(groupLanes(tasks, "none", projectsById)).toEqual([{ key: "", title: "", tasks }]);
  });

  it("groups by epic sorted by title with No epic last, keeping task order", () => {
    const tasks = [
      makeTask({ id: 1, ...epic(20, "Zeta") }),
      makeTask({ id: 2 }),
      makeTask({ id: 3, ...epic(10, "Alpha") }),
      makeTask({ id: 4, ...epic(20, "Zeta") }),
    ];
    const lanes = groupLanes(tasks, "epic", projectsById);
    expect(lanes.map((l) => l.title)).toEqual(["#10 Alpha", "#20 Zeta", "No epic"]);
    expect(lanes[1].tasks.map((t) => t.id)).toEqual([1, 4]);
    expect(lanes[2].key).toBe(NO_EPIC);
  });

  it("upgrades a lane first seen without its epic title", () => {
    const tasks = [
      makeTask({ id: 1, ...epic(10, null) }),
      makeTask({ id: 2, ...epic(10, "Late title") }),
    ];
    expect(groupLanes(tasks, "epic", projectsById)[0].title).toBe("#10 Late title");
  });

  it("titles a title-less epic lane by its number alone", () => {
    expect(
      groupLanes([makeTask({ id: 1, ...epic(10, null) })], "epic", projectsById)[0].title,
    ).toBe("#10");
  });

  it("groups by project name, falling back for an unknown project", () => {
    const tasks = [
      makeTask({ id: 1, projectId: 2 }),
      makeTask({ id: 2, projectId: 1 }),
      makeTask({ id: 3, projectId: 9 }),
    ];
    expect(groupLanes(tasks, "project", projectsById).map((l) => l.title)).toEqual([
      "demo",
      "other",
      "Project 9",
    ]);
  });

  it("keys a task's lane the same way the lanes do", () => {
    const t = makeTask({ id: 1, projectId: 2, ...epic(10) });
    expect(laneKeyOf(t, "epic")).toBe("acme/widgets#10");
    expect(laneKeyOf(t, "project")).toBe("2");
    expect(laneKeyOf(t, "none")).toBe("");
    expect(laneKeyOf(makeTask({}), "epic")).toBe(NO_EPIC);
  });
});

describe("epicProgress", () => {
  it("is null for an epic with no tasks", () => {
    expect(epicProgress([], "acme/widgets#10")).toBeNull();
  });

  it("counts done child tasks when the epic itself is not on the board", () => {
    const tasks = [
      makeTask({ id: 1, status: "done", ...epic(10) }),
      makeTask({ id: 2, status: "ready", ...epic(10) }),
      makeTask({ id: 3, status: "ready", ...epic(10) }),
    ];
    expect(epicProgress(tasks, "acme/widgets#10")).toEqual({ done: 1, total: 3, basis: "done" });
  });

  it("prefers the epic task's own sub-issue counts", () => {
    const tasks = [
      makeTask({
        id: 99,
        issueNumber: 10,
        htmlUrl: "https://github.com/acme/widgets/issues/10",
        subIssueTotal: 9,
        subIssueCompleted: 3,
      }),
      makeTask({ id: 1, ...epic(10) }),
    ];
    expect(epicProgress(tasks, "acme/widgets#10")).toEqual({ done: 3, total: 9, basis: "closed" });
  });

  it("treats missing completed counts as zero and ignores a same-number issue in another repo", () => {
    const tasks = [
      makeTask({
        id: 99,
        issueNumber: 10,
        htmlUrl: "https://github.com/acme/widgets/issues/10",
        subIssueTotal: 4,
        subIssueCompleted: null,
      }),
      makeTask({
        id: 98,
        issueNumber: 10,
        htmlUrl: "https://github.com/other/repo/issues/10",
        subIssueTotal: 7,
        subIssueCompleted: 7,
      }),
      makeTask({ id: 1, ...epic(10) }),
    ];
    expect(epicProgress(tasks, "acme/widgets#10")).toEqual({ done: 0, total: 4, basis: "closed" });
  });
});

describe("columnItems", () => {
  it("keeps every card in place when nothing is blocked", () => {
    const tasks = [makeTask({ id: 1 }), makeTask({ id: 2 })];
    expect(columnItems(tasks)).toEqual([
      { kind: "card", task: tasks[0], index: 0 },
      { kind: "card", task: tasks[1], index: 1 },
    ]);
  });

  it(`stacks ${BLOCKED_STACK_MIN}+ cards with the same blockers at the first member, keeping indexes`, () => {
    const tasks = [
      makeTask({ id: 1 }),
      makeTask({ id: 2, ...blockedBy(7) }),
      makeTask({ id: 3 }),
      makeTask({ id: 4, ...blockedBy(7) }),
      makeTask({ id: 5, ...blockedBy(7) }),
    ];
    const items = columnItems(tasks);
    expect(items.map((i) => i.kind)).toEqual(["card", "stack", "card"]);
    const stack = items[1];
    if (stack.kind !== "stack") throw new Error("expected a stack");
    expect(stack.firstIndex).toBe(1);
    expect(stack.members.map((m) => [m.task.id, m.index])).toEqual([
      [2, 1],
      [4, 3],
      [5, 4],
    ]);
    expect(items[2]).toMatchObject({ kind: "card", index: 2 });
  });

  it("does not stack fewer than the minimum, or cards with different blocker sets", () => {
    const two = [makeTask({ id: 1, ...blockedBy(7) }), makeTask({ id: 2, ...blockedBy(7) })];
    expect(columnItems(two).every((i) => i.kind === "card")).toBe(true);
    const mixed = [
      makeTask({ id: 1, ...blockedBy(7) }),
      makeTask({ id: 2, ...blockedBy(7, 8) }),
      makeTask({ id: 3, ...blockedBy(8) }),
    ];
    expect(columnItems(mixed).every((i) => i.kind === "card")).toBe(true);
  });

  it("treats the same blockers in a different order as one set", () => {
    const tasks = [
      makeTask({ id: 1, ...blockedBy(7, 8) }),
      makeTask({ id: 2, ...blockedBy(8, 7) }),
      makeTask({ id: 3, ...blockedBy(7, 8) }),
    ];
    expect(columnItems(tasks).map((i) => i.kind)).toEqual(["stack"]);
  });

  it("never stacks a task whose blocker has no link, or one that is not blocked", () => {
    const unlinked = {
      blockedState: "blocked" as const,
      blockers: [{ owner: "", repo: "", number: 0, title: "hidden", htmlUrl: null }],
    };
    const tasks = [
      makeTask({ id: 1, ...unlinked }),
      makeTask({ id: 2, ...unlinked }),
      makeTask({ id: 3, ...unlinked }),
      makeTask({ id: 4, blockedState: "clear", blockers: blockedBy(7).blockers }),
    ];
    expect(columnItems(tasks).every((i) => i.kind === "card")).toBe(true);
  });
});
