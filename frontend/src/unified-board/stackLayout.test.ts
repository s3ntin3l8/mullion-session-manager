import { describe, it, expect } from "vitest";
import { makeTask } from "../test/fixtures.js";
import {
  STACKED_BELOW_WIDTH,
  boardStacks,
  initialOpenSections,
  stackSections,
} from "./stackLayout.js";

describe("boardStacks", () => {
  it("is room for three 160px lanes, their two gaps and the padding", () => {
    expect(STACKED_BELOW_WIDTH).toBe(540);
  });

  it("stacks below the threshold and keeps lanes at or above it", () => {
    expect(boardStacks(378)).toBe(true);
    expect(boardStacks(539)).toBe(true);
    expect(boardStacks(540)).toBe(false);
    expect(boardStacks(1200)).toBe(false);
  });

  it("keeps lanes while the width is unmeasured", () => {
    expect(boardStacks(0)).toBe(false);
  });
});

describe("stackSections", () => {
  it("lists active statuses first, then Backlog and Done, with Claimed folded in", () => {
    const sections = stackSections([
      makeTask({ id: 1, status: "backlog" }),
      makeTask({ id: 2, status: "claimed" }),
      makeTask({ id: 3, status: "in_progress" }),
      makeTask({ id: 4, status: "done" }),
    ]);
    expect(sections.map((s) => s.id)).toEqual([
      "reviewing",
      "in_progress",
      "ready",
      "backlog",
      "done",
    ]);
    expect(sections[1].tasks.map((t) => t.id)).toEqual([3, 2]);
  });

  it("adds Failed after the active statuses only while it holds a task", () => {
    const sections = stackSections([makeTask({ id: 1, status: "failed" })]);
    expect(sections.map((s) => s.id)).toEqual([
      "reviewing",
      "in_progress",
      "ready",
      "failed",
      "backlog",
      "done",
    ]);
    expect(sections[3].needsYou).toBe(true);
  });

  it("marks a section holding a task that needs the owner", () => {
    const sections = stackSections([
      makeTask({ id: 1, status: "reviewing", approvalState: "awaiting-human" }),
      makeTask({ id: 2, status: "ready" }),
    ]);
    expect(sections.find((s) => s.id === "reviewing")?.needsYou).toBe(true);
    expect(sections.find((s) => s.id === "ready")?.needsYou).toBe(false);
  });
});

describe("initialOpenSections", () => {
  it("opens all but Backlog and Done", () => {
    expect([...initialOpenSections(null)].sort()).toEqual(
      ["failed", "in_progress", "ready", "reviewing"].sort(),
    );
  });

  it("opens the selected task's section even when it starts collapsed", () => {
    expect(initialOpenSections("backlog").has("backlog")).toBe(true);
    expect(initialOpenSections("backlog").has("done")).toBe(false);
  });
});
