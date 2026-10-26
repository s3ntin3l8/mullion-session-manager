// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { useDashboardStore } from "../store/index.js";
import { describe, expect, it } from "vitest";
import { buildMullionLinks, isTaskBranch, useMullionLinks } from "./useMullionLinks.js";
import { makeProject, makeSession, makeTask } from "../test/fixtures.js";
import type { GitHubPROrWithChecks } from "../api/types.js";

const project = makeProject({ id: 1, devServerUrl: "http://localhost:5173" });
const pr = (over: Partial<GitHubPROrWithChecks>): GitHubPROrWithChecks => ({
  number: 10,
  title: "t",
  htmlUrl: "u",
  author: null,
  headSha: "a",
  headBranch: "feat/x",
  baseBranch: "main",
  ciStatus: "success",
  actionsRuns: [],
  ...over,
});

describe("buildMullionLinks", () => {
  it("joins sessions by branch and worktree path, with dev server", () => {
    const s = makeSession({ id: 1, liveBranch: "feat/x", liveCwd: "/wt/x" });
    const links = buildMullionLinks({ project, sessions: [s], tasks: [] });
    expect(links.byBranch.get("feat/x")?.sessions[0]?.session.id).toBe(1);
    expect(links.byBranch.get("feat/x")?.devServer).toBe("http://localhost:5173");
    expect(links.byWorktree.get("/wt/x")?.sessions).toHaveLength(1);
    expect(links.byBranch.get("feat/x")?.taskOwned).toBe(false);
  });

  it("ignores other projects, dock and killed sessions", () => {
    const sessions = [
      makeSession({ id: 1, projectId: 2, liveBranch: "b" }),
      makeSession({ id: 2, kind: "dock", liveBranch: "b" }),
      makeSession({ id: 3, status: "killed", liveBranch: "b" }),
    ];
    expect(buildMullionLinks({ project, sessions, tasks: [] }).byBranch.size).toBe(0);
  });

  it("marks task-owned branches and attaches the task", () => {
    const task = makeTask({
      id: 7,
      branchName: "mullion/task-7",
      worktreePath: "/wt/t7",
      sessionId: 4,
    });
    const s = makeSession({ id: 4, liveBranch: "mullion/task-7", liveCwd: "/wt/t7" });
    const links = buildMullionLinks({ project, sessions: [s], tasks: [task] });
    expect(links.byBranch.get("mullion/task-7")).toMatchObject({ taskOwned: true, task });
    expect(links.byWorktree.get("/wt/t7")?.task).toBe(task);
    expect(isTaskBranch("mullion/task-9")).toBe(true);
    expect(isTaskBranch("feat/x")).toBe(false);
    // A task branch with no session still shows up, locked.
    const bare = buildMullionLinks({ project, sessions: [], tasks: [task] });
    expect(bare.byBranch.get("mullion/task-7")?.taskOwned).toBe(true);
    expect(bare.byWorktree.get("/wt/t7")?.taskOwned).toBe(true);
  });

  it("joins PRs via matchSessionPr — a task's PR number beats the branch", () => {
    const task = makeTask({ id: 7, sessionId: 4, prNumber: 21, branchName: "mullion/task-7" });
    const s = makeSession({ id: 4, liveBranch: "switched" });
    const plain = makeSession({ id: 5, liveBranch: "feat/x" });
    const prs = [pr({ number: 10 }), pr({ number: 21, headBranch: "other" })];
    const links = buildMullionLinks({ project, sessions: [s, plain], tasks: [task], prs });
    expect(links.byPr.get(21)?.sessions.map((l) => l.session.id)).toEqual([4]);
    expect(links.byPr.get(21)?.task).toBe(task);
    expect(links.byPr.get(10)?.sessions.map((l) => l.session.id)).toEqual([5]);
  });

  it("uses pr.taskId and relayReview for the PR entry", () => {
    const task = makeTask({ id: 3 });
    const prs = [
      pr({ taskId: 3, relayReview: { state: "requested", runId: "r1", status: "running" } }),
    ];
    const e = buildMullionLinks({ project, sessions: [], tasks: [task], prs }).byPr.get(10);
    expect(e?.task).toBe(task);
    expect(e?.reviewRun).toEqual({
      runId: "r1",
      state: "requested",
      status: "running",
      kind: "pull_request",
    });
  });

  it("falls back to /api/reviews runs and ignores relay state none", () => {
    const prs = [pr({ relayReview: { state: "none" } })];
    const reviewRuns = [
      { runId: "r9", status: "queued", prNumber: 10, repo: "o/r", headSha: "a" },
    ] as never;
    const e = buildMullionLinks({ project, sessions: [], tasks: [], prs, reviewRuns }).byPr.get(10);
    expect(e?.reviewRun?.runId).toBe("r9");
  });

  it("nests child sessions under their parent", () => {
    const parent = makeSession({ id: 1, liveBranch: "feat/x" });
    const child = makeSession({ id: 2, parentSessionId: 1, liveBranch: "feat/x" });
    const grand = makeSession({ id: 3, parentSessionId: 2 });
    const e = buildMullionLinks({
      project,
      sessions: [parent, child, grand],
      tasks: [],
    }).byBranch.get("feat/x");
    expect(e?.sessions).toHaveLength(1);
    expect(e?.sessions[0]?.children[0]?.session.id).toBe(2);
    expect(e?.sessions[0]?.children[0]?.children[0]?.session.id).toBe(3);
  });

  it("carries severity, attention and a pending promote request", () => {
    const s = makeSession({
      id: 1,
      liveBranch: "b",
      sessionStatusSeverity: "blocked",
      sessionStatusAttentionRequired: true,
      promoteState: "pending",
    });
    const e = buildMullionLinks({ project, sessions: [s], tasks: [] }).byBranch.get("b");
    expect(e?.sessions[0]).toMatchObject({ severity: "blocked", attention: true });
    expect(e?.promoteRequest?.id).toBe(1);
  });

  it("joins previews by branch and issues to task, sessions and triage", () => {
    const task = makeTask({ id: 5, issueNumber: 42, sessionId: 8 });
    const s = makeSession({ id: 8 });
    const preview = {
      slug: "p",
      kind: "project",
      projectId: 1,
      externalUrl: null,
      createdAt: "",
      branch: "feat/x",
    } as const;
    const issues = [
      { number: 42, triage: { state: "requested", runId: "t1", dispatchedAt: "" } },
      { number: 43 },
    ] as never;
    const links = buildMullionLinks({
      project,
      sessions: [s],
      tasks: [task],
      previews: [preview, { ...preview, projectId: 2, branch: "zzz" }],
      issues,
    });
    expect(links.byBranch.get("feat/x")?.preview?.slug).toBe("p");
    expect(links.byBranch.has("zzz")).toBe(false);
    expect(links.byIssue.get(42)?.task).toBe(task);
    expect(links.byIssue.get(42)?.sessions[0]?.session.id).toBe(8);
    expect(links.byIssue.get(42)?.reviewRun?.kind).toBe("issue");
    expect(links.byIssue.get(43)?.task).toBeNull();
  });
});

describe("useMullionLinks", () => {
  it("builds from the store's sessions, tasks, projects and PR list", () => {
    useDashboardStore.setState({
      projects: [project],
      sessions: [makeSession({ id: 1, liveBranch: "feat/x" })],
      tasks: [],
      prsByProject: {
        1: { prs: [pr({})], prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 } },
      },
    });
    const { result } = renderHook(() => useMullionLinks(1));
    expect(result.current.byPr.get(10)?.sessions).toHaveLength(1);
    expect(result.current.byBranch.get("feat/x")?.devServer).toBe("http://localhost:5173");
  });
});
