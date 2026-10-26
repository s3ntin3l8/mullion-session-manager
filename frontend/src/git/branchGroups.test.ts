import { describe, expect, it } from "vitest";
import type { GitBranchInfo, GitWorktreeInfo } from "../api/types.js";
import { buildMullionLinks } from "../hooks/useMullionLinks.js";
import { makeProject, makeTask } from "../test/fixtures.js";
import { groupBranches, isPrunable, mergeChip, relativeAgeSeconds } from "./branchGroups.js";

const links = (tasks = [] as ReturnType<typeof makeTask>[]) =>
  buildMullionLinks({ project: makeProject({ id: 1 }), sessions: [], tasks });
const b = (name: string, over: Partial<GitBranchInfo> = {}): GitBranchInfo => ({
  name,
  isCurrent: false,
  ...over,
});

describe("relativeAgeSeconds", () => {
  it("orders git's relative dates and sorts the unknown last", () => {
    expect(relativeAgeSeconds("5 minutes ago")).toBeLessThan(relativeAgeSeconds("2 hours ago"));
    expect(relativeAgeSeconds("1 day ago")).toBeLessThan(relativeAgeSeconds("3 weeks ago"));
    expect(relativeAgeSeconds("2 years ago")).toBeGreaterThan(relativeAgeSeconds("11 months ago"));
    expect(relativeAgeSeconds("1 second ago")).toBe(1);
    expect(relativeAgeSeconds(undefined)).toBe(Number.MAX_SAFE_INTEGER);
    expect(relativeAgeSeconds("garbage")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("groupBranches", () => {
  const base = {
    worktrees: [] as GitWorktreeInfo[],
    defaultBranch: "origin/main",
    links: links(),
    openPrBranches: new Set<string>(),
  };

  it("claims each branch once, in order, sorted by recency", () => {
    const groups = groupBranches(
      [
        b("main", { isCurrent: true, mergeState: "ancestor" }),
        b("pr-old", { lastCommitRelative: "2 days ago" }),
        b("pr-new", { lastCommitRelative: "1 hour ago" }),
        b("mullion/task-3-a", { pr: { number: 1, state: "open", url: "u" } }),
        b("done", { mergeState: "pr-merged" }),
        b("closed", { mergeState: "pr-closed" }),
        b("plain"),
      ],
      { ...base, openPrBranches: new Set(["pr-old", "pr-new"]) },
    );
    expect(groups.map((g) => [g.id, g.branches.map((x) => x.name)])).toEqual([
      ["current", ["main"]],
      ["pr", ["pr-new", "pr-old"]],
      ["task", ["mullion/task-3-a"]],
      ["prunable", ["done"]],
      ["other", ["closed", "plain"]],
    ]);
  });

  it("treats a branch a task owns by record as a task branch, and applies the filter", () => {
    const owned = links([makeTask({ id: 4, projectId: 1, branchName: "custom-name" })]);
    const groups = groupBranches([b("custom-name"), b("Other")], { ...base, links: owned });
    expect(groups[0]?.id).toBe("task");
    expect(groupBranches([b("custom-name"), b("Other")], { ...base, filter: "oth" })).toHaveLength(
      1,
    );
    expect(groupBranches([b("x")], { ...base, filter: "zzz" })).toEqual([]);
  });

  it("an open PR from branch.pr alone also groups", () => {
    const g = groupBranches([b("x", { pr: { number: 2, state: "open", url: "u" } })], base);
    expect(g[0]?.id).toBe("pr");
  });
});

describe("isPrunable", () => {
  const wt: GitWorktreeInfo[] = [
    { path: "/r", branch: "main", isMain: true },
    { path: "/r/.wt/w", branch: "in-wt", isMain: false },
  ];
  it("mirrors the server's guards", () => {
    const l = links();
    const p = (x: GitBranchInfo) => isPrunable(x, wt, "origin/main", l);
    expect(p(b("a", { mergeState: "ancestor" }))).toBe(true);
    expect(p(b("a", { mergeState: "upstream-gone" }))).toBe(true);
    expect(p(b("a", { mergeState: "pr-closed" }))).toBe(false);
    expect(p(b("a"))).toBe(false);
    expect(p(b("a", { mergeState: "ancestor", isCurrent: true }))).toBe(false);
    expect(p(b("main", { mergeState: "ancestor" }))).toBe(false);
    expect(p(b("in-wt", { mergeState: "ancestor" }))).toBe(false);
    expect(p(b("mullion/task-1", { mergeState: "ancestor" }))).toBe(false);
  });
});

describe("mergeChip", () => {
  it("words every state, with the PR in the tooltip", () => {
    expect(mergeChip("ancestor").label).toBe("merged");
    expect(mergeChip("upstream-gone").short).toBe("gone");
    expect(mergeChip("pr-merged", { number: 9 }).title).toContain("#9");
    expect(mergeChip("pr-merged").title).toBe("Its PR was merged");
    expect(mergeChip("pr-closed", { number: 9 }).tone).toBe("neutral");
    expect(mergeChip("pr-closed").title).toContain("closed unmerged");
  });
});
