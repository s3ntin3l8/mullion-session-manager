import { describe, it, expect } from "vitest";
import { makeTask } from "../test/fixtures.js";
import {
  FACETS_AUTO_MIN_PROJECTS,
  FACETS_AUTO_MIN_WIDTH,
  NO_EPIC,
  NO_FILTERS,
  activeFilterCount,
  agentLabel,
  agentOptions,
  epicOptions,
  facetsOpen,
  isFacetsSetting,
  isQuickView,
  matchesQuickView,
  matchesText,
  noEpicCount,
  quickViewCounts,
  scopeTasks,
} from "./taskFilters.js";

const epic = (n: number, title: string | null, total: number | null = null, done = 0) => ({
  parentIssueNumber: n,
  parentIssueRepo: "acme/widgets",
  parentIssueTitle: title,
  subIssueTotal: total,
  subIssueCompleted: total === null ? null : done,
});

describe("matchesQuickView", () => {
  it("all matches everything", () => {
    expect(matchesQuickView(makeTask({}), "all")).toBe(true);
  });

  it("needs-me follows needsYouReason (a failed task, an awaiting-approval task)", () => {
    expect(matchesQuickView(makeTask({ status: "failed" }), "needs-me")).toBe(true);
    expect(
      matchesQuickView(
        makeTask({ status: "reviewing", approvalState: "awaiting-human" }),
        "needs-me",
      ),
    ).toBe(true);
    expect(matchesQuickView(makeTask({ status: "ready" }), "needs-me")).toBe(false);
  });

  it("running is the running bucket: claimed or in progress, not waiting, not archived", () => {
    expect(matchesQuickView(makeTask({ status: "in_progress" }), "running")).toBe(true);
    expect(matchesQuickView(makeTask({ status: "claimed" }), "running")).toBe(true);
    expect(
      matchesQuickView(makeTask({ status: "claimed", failureReason: "host offline" }), "running"),
    ).toBe(false);
    expect(
      matchesQuickView(
        makeTask({ status: "in_progress", archivedAt: "2026-01-01T00:00:00.000Z" }),
        "running",
      ),
    ).toBe(false);
  });

  it("blocked follows blockedState", () => {
    expect(matchesQuickView(makeTask({ blockedState: "blocked" }), "blocked")).toBe(true);
    expect(matchesQuickView(makeTask({ blockedState: "unresolved" }), "blocked")).toBe(false);
  });

  it("awaiting-merge is a done task with an open PR", () => {
    expect(
      matchesQuickView(makeTask({ status: "done", prNumber: 4, mergedAt: null }), "awaiting-merge"),
    ).toBe(true);
    expect(
      matchesQuickView(
        makeTask({ status: "done", prNumber: 4, mergedAt: "2026-01-01T00:00:00.000Z" }),
        "awaiting-merge",
      ),
    ).toBe(false);
  });
});

describe("matchesText", () => {
  it("matches everything for an empty or blank query", () => {
    expect(matchesText(makeTask({}), "")).toBe(true);
    expect(matchesText(makeTask({}), "   ")).toBe(true);
  });

  it("matches the title case-insensitively", () => {
    expect(matchesText(makeTask({ title: "Fix The Thing" }), "the thing")).toBe(true);
    expect(matchesText(makeTask({ title: "Fix The Thing" }), "other")).toBe(false);
  });

  it("matches the issue number and the PR number, with or without a leading #", () => {
    const t = makeTask({ title: "x", issueNumber: 12, prNumber: 34 });
    expect(matchesText(t, "12")).toBe(true);
    expect(matchesText(t, "#12")).toBe(true);
    expect(matchesText(t, "#34")).toBe(true);
    expect(matchesText(t, "35")).toBe(false);
  });

  it("does not match a number against the task id or a partial number", () => {
    const t = makeTask({ id: 99, title: "x", issueNumber: 123 });
    expect(matchesText(t, "99")).toBe(false);
    expect(matchesText(t, "12")).toBe(false);
  });
});

describe("scopeTasks and quickViewCounts", () => {
  const tasks = [
    makeTask({ id: 1, projectId: 1, status: "ready", title: "a", ...epic(10, "A") }),
    makeTask({ id: 2, projectId: 2, status: "ready", title: "b", agentCommand: "claude" }),
    makeTask({ id: 3, projectId: 1, status: "in_progress", title: "c" }),
    makeTask({ id: 4, projectId: 1, status: "done", archivedAt: "2026-01-01T00:00:00.000Z" }),
  ];

  it("hides archived tasks unless asked", () => {
    expect(scopeTasks(tasks, NO_FILTERS).map((t) => t.id)).toEqual([1, 2, 3]);
    expect(scopeTasks(tasks, { ...NO_FILTERS, showArchived: true }).map((t) => t.id)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("narrows by project, epic (including No epic), agent and text together", () => {
    expect(scopeTasks(tasks, { ...NO_FILTERS, projectIds: [1] }).map((t) => t.id)).toEqual([1, 3]);
    expect(
      scopeTasks(tasks, { ...NO_FILTERS, epicKeys: ["acme/widgets#10"] }).map((t) => t.id),
    ).toEqual([1]);
    expect(scopeTasks(tasks, { ...NO_FILTERS, epicKeys: [NO_EPIC] }).map((t) => t.id)).toEqual([
      2, 3,
    ]);
    expect(scopeTasks(tasks, { ...NO_FILTERS, agents: ["claude"] }).map((t) => t.id)).toEqual([2]);
    expect(
      scopeTasks(tasks, { ...NO_FILTERS, projectIds: [1], text: "c" }).map((t) => t.id),
    ).toEqual([3]);
  });

  it("counts each quick view over the scoped set, not the view itself", () => {
    const counts = quickViewCounts(scopeTasks(tasks, NO_FILTERS));
    expect(counts.all).toBe(3);
    expect(counts.running).toBe(1);
    expect(counts.blocked).toBe(0);
    expect(counts["awaiting-merge"]).toBe(0);
  });
});

describe("epicOptions", () => {
  it("builds '#N title' options with progress, sorted, and counts tasks per epic", () => {
    const tasks = [
      makeTask({ id: 1, ...epic(20, "Beta", 5, 2) }),
      makeTask({ id: 2, ...epic(10, "Alpha", 4, 1) }),
      makeTask({ id: 3, ...epic(10, "Alpha", 4, 1) }),
      makeTask({ id: 4 }),
    ];
    expect(epicOptions(tasks)).toEqual([
      { key: "acme/widgets#10", label: "#10 Alpha", count: 2, done: 1, total: 4 },
      { key: "acme/widgets#20", label: "#20 Beta", count: 1, done: 2, total: 5 },
    ]);
    expect(noEpicCount(tasks)).toBe(1);
  });

  it("upgrades a '#N' placeholder once any task of that epic reports a title or progress", () => {
    const tasks = [
      makeTask({ id: 1, ...epic(10, null) }),
      makeTask({ id: 2, ...epic(10, "Alpha", 4, 1) }),
    ];
    expect(epicOptions(tasks)).toEqual([
      { key: "acme/widgets#10", label: "#10 Alpha", count: 2, done: 1, total: 4 },
    ]);
  });

  it("keeps the '#N' label while no title has landed", () => {
    expect(epicOptions([makeTask({ id: 1, ...epic(10, null) })])[0].label).toBe("#10");
  });
});

describe("agents", () => {
  it("labels by the binary of the launch command, else the agent, else auto", () => {
    expect(agentLabel(makeTask({ agentCommand: "/usr/bin/claude --x", agent: null }))).toBe(
      "claude",
    );
    expect(agentLabel(makeTask({ agentCommand: null, agent: "codex" }))).toBe("codex");
    expect(agentLabel(makeTask({ agentCommand: null, agent: null }))).toBe("auto");
  });

  it("counts tasks per agent, sorted by name", () => {
    expect(
      agentOptions([
        makeTask({ id: 1, agent: "codex", agentCommand: null }),
        makeTask({ id: 2, agent: null, agentCommand: null }),
        makeTask({ id: 3, agent: "codex", agentCommand: null }),
      ]),
    ).toEqual([
      { value: "auto", count: 1 },
      { value: "codex", count: 2 },
    ]);
  });
});

describe("facets setting", () => {
  it("validates persisted values", () => {
    expect(isFacetsSetting("auto")).toBe(true);
    expect(isFacetsSetting("sideways")).toBe(false);
    expect(isQuickView("blocked")).toBe(true);
    expect(isQuickView("nope")).toBe(false);
  });

  it("On and Off ignore the viewport; Auto needs a wide window or many projects", () => {
    expect(facetsOpen("on", 100, 1)).toBe(true);
    expect(facetsOpen("off", 5000, 50)).toBe(false);
    expect(facetsOpen("auto", FACETS_AUTO_MIN_WIDTH - 1, FACETS_AUTO_MIN_PROJECTS)).toBe(false);
    expect(facetsOpen("auto", FACETS_AUTO_MIN_WIDTH, 1)).toBe(true);
    expect(facetsOpen("auto", 800, FACETS_AUTO_MIN_PROJECTS + 1)).toBe(true);
  });
});

describe("activeFilterCount", () => {
  it("counts each active dimension once", () => {
    expect(activeFilterCount(NO_FILTERS, false)).toBe(0);
    expect(
      activeFilterCount(
        {
          projectIds: [1, 2],
          view: "blocked",
          epicKeys: ["a", "b"],
          agents: ["claude"],
          text: " x ",
          showArchived: true,
        },
        true,
      ),
    ).toBe(7);
  });
});
