// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Session, Task } from "../api/types.js";
import { useDashboardStore } from "../store/index.js";
import { SidebarDetailSlotContext } from "../ui/sidebar/detailSlot.js";
import { RightSidebar } from "./RightSidebar.js";
import { TaskDetailView } from "./TaskDetailView.js";

vi.mock("../SessionTimeline.js", () => ({ SessionTimeline: () => <div data-testid="timeline" /> }));

const ref = (n: number) => ({
  owner: "o",
  repo: "r",
  number: n,
  title: `blocker ${n}`,
  htmlUrl: null,
});
let seq = 100;
const task = (o: Partial<Task>): Task => {
  seq += 1;
  return {
    id: seq,
    projectId: 4,
    projectName: "proj",
    issueNumber: seq,
    htmlUrl: `https://github.com/o/r/issues/${seq}`,
    prNumber: null,
    prTitle: null,
    title: `Task ${seq}`,
    body: null,
    status: "ready",
    approvalState: null,
    archivedAt: null,
    failureReason: null,
    blockedState: "clear",
    blockers: [],
    parentIssueNumber: null,
    parentIssueRepo: null,
    parentIssueTitle: null,
    subIssueTotal: null,
    subIssueCompleted: null,
    sessionId: null,
    reviewSessionId: null,
    reviewRunId: null,
    reviewFindings: null,
    reviewPhase: null,
    reReviewAt: null,
    autoReturnRounds: 0,
    autoReturnCapped: false,
    lastReviewVerdict: null,
    branchName: null,
    agent: null,
    agentCommand: null,
    seedDelivered: true,
    queuedAt: null,
    claimedAt: null,
    startedAt: null,
    reviewingAt: null,
    completedAt: null,
    mergedAt: null,
    mergeError: null,
    releaseError: null,
    ...o,
  } as unknown as Task;
};

const setTasks = (tasks: Task[], extra: Record<string, unknown> = {}) =>
  useDashboardStore.setState({
    selectedTaskId: null,
    taskMasterEnabled: true,
    tasks,
    sessions: [],
    projects: [{ id: 4, name: "proj" }] as never,
    prsByProject: {},
    refreshTasks: vi.fn().mockResolvedValue(undefined),
    ...extra,
  });

const renderDetail = (id: number, onBack = vi.fn()) =>
  render(<TaskDetailView taskId={id} onBack={onBack} />);

beforeEach(() => vi.restoreAllMocks());

describe("TaskDetailView layout", () => {
  it("shares the detail inset and boxes the state sections as cards", () => {
    const t = task({ status: "reviewing" });
    setTasks([t]);
    renderDetail(t.id);
    const root = screen.getByTestId("task-detail-view");
    expect(root).toHaveClass("sb-detail");
    const cards = Array.from(root.querySelectorAll("section.sb-sec--card")).map(
      (el) => el.querySelector(".sb-sec-name")?.textContent,
    );
    expect(cards).toEqual(expect.arrayContaining(["Review", "Details"]));
    const timeline = Array.from(root.querySelectorAll("section.sb-sec")).find(
      (el) => el.querySelector(".sb-sec-name")?.textContent === "Timeline",
    );
    expect(timeline).not.toHaveClass("sb-sec--card");
  });
});

describe("TaskDetailView keyboard access", () => {
  it("focuses Back when a task's detail appears, so Enter on a board card does not land nowhere", () => {
    const t = task({ title: "Reach me" });
    setTasks([t]);
    renderDetail(t.id);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Back" }));
  });

  it("moves focus again when another task replaces the one shown, and names it as a region", () => {
    const a = task({ title: "First one" });
    const b = task({ title: "Second one" });
    setTasks([a, b]);
    const { rerender } = renderDetail(a.id);
    expect(screen.getByRole("region", { name: /First one/ })).toBeTruthy();
    (document.activeElement as HTMLElement).blur();
    rerender(<TaskDetailView taskId={b.id} onBack={vi.fn()} />);
    expect(screen.getByRole("region", { name: /Second one/ })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Back" }));
  });

  it("does not steal focus on an unrelated re-render of the same task", () => {
    const t = task({ title: "Stay put" });
    setTasks([t]);
    const { rerender } = renderDetail(t.id);
    const other = document.createElement("button");
    document.body.appendChild(other);
    other.focus();
    rerender(<TaskDetailView taskId={t.id} onBack={vi.fn()} />);
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it("focuses Back on the not-found state too", () => {
    setTasks([]);
    renderDetail(999);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Back" }));
  });
});

describe("TaskDetailView keyboard access in the real right sidebar", () => {
  // DetailHeader portals the header (Back included) into the drawer's detail
  // slot, a sibling of the view body, so a lookup inside the view's own root
  // finds nothing there. These tests use the DOM shape the app really has.
  const actions = {
    onOpenGit: vi.fn(),
    onOpenGitHub: vi.fn(),
    onOpenFileEditor: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenAgentRules: vi.fn(),
    onOpenProjectBriefing: vi.fn(),
    onOpenProjectSetup: vi.fn(),
    onOpenDockConfig: vi.fn(),
    onOpenSkills: vi.fn(),
    onOpenTasks: vi.fn(),
  };

  it("focuses the portalled Back button when a card selects a task, so Enter does not land on <body>", () => {
    const t = task({ title: "Reach me from the board" });
    localStorage.clear();
    setTasks([t], {
      projects: [{ id: 4, name: "proj", cwd: "/x/proj", hostId: "local" }] as never,
      gitStatuses: {},
      sessions: [],
      rightSidebarView: "tasks",
      rightSidebarOpen: true,
      rightSidebarWidth: 340,
      rightSidebarProjectRequest: null,
      followedProjectId: null,
      selectedTaskId: t.id,
    });
    render(<RightSidebar tier="desktop" actions={actions as never} />);
    const slot = document.querySelector(".right-sidebar-detail-slot") as HTMLElement;
    expect(slot).toBeTruthy();
    const back = within(slot).getByRole("button", { name: "Back" });
    // Back lives outside the view root, in the slot...
    expect(screen.getByTestId("task-detail-view").contains(back)).toBe(false);
    // ...and still has focus.
    expect(document.activeElement).toBe(back);
  });

  it("finds Back in an injected detail slot, and still focuses it after the slot arrives late", () => {
    const t = task({ title: "Slot task" });
    setTasks([t]);
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    const ui = (s: HTMLElement | null) => (
      <SidebarDetailSlotContext.Provider value={s}>
        <TaskDetailView taskId={t.id} onBack={vi.fn()} />
      </SidebarDetailSlotContext.Provider>
    );
    const { rerender } = render(ui(null));
    rerender(ui(slot));
    expect(document.activeElement).toBe(within(slot).getByRole("button", { name: "Back" }));
    slot.remove();
  });
});

describe("TaskDetailView review reviewer", () => {
  const sessionsRow = (view: HTMLElement) => within(view).getByText("Sessions").nextElementSibling!;
  it("shows the Hermes run instead of 'reviewer: none'", () => {
    const t = task({ status: "reviewing", reviewRunId: "r1", reviewRunIngestedId: null } as never);
    setTasks([t]);
    renderDetail(t.id);
    const row = sessionsRow(screen.getByTestId("task-detail-view"));
    expect(row.textContent).toContain("Hermes · running");
    expect(row.textContent).not.toContain("reviewer: none");
  });
  it("says finished and not sent for the other run states", () => {
    const fin = task({ status: "reviewing", reviewRunId: "r", reviewRunIngestedId: "r" } as never);
    setTasks([fin]);
    const { unmount } = renderDetail(fin.id);
    expect(sessionsRow(screen.getByTestId("task-detail-view")).textContent).toContain("finished");
    unmount();
    const unsent = task({ status: "reviewing", reviewRunId: "r", reviewRunUnsent: true } as never);
    setTasks([unsent]);
    renderDetail(unsent.id);
    expect(sessionsRow(screen.getByTestId("task-detail-view")).textContent).toContain("not sent");
  });
  it("opens the PR in the GitHub tab when the task has one", async () => {
    const open = vi.fn();
    const t = task({
      status: "reviewing",
      reviewRunId: "r",
      reviewRunIngestedId: "r",
      prNumber: 7,
    } as never);
    setTasks([t], { openRightSidebarPr: open });
    renderDetail(t.id);
    await userEvent.click(screen.getByRole("button", { name: /Hermes · finished/ }));
    expect(open).toHaveBeenCalledWith(4, 7, { kind: "task", taskId: t.id });
  });
  it("keeps the reviewer session, and shows no Hermes chip, when both a session and a run exist", () => {
    const t = task({
      status: "reviewing",
      reviewSessionId: 55,
      reviewRunId: "r",
      reviewRunIngestedId: null,
    } as never);
    setTasks([t], {
      sessions: [{ id: 55, sessionStatus: "idle", sessionStatusDetail: null }] as never,
    });
    renderDetail(t.id);
    const row = sessionsRow(screen.getByTestId("task-detail-view"));
    expect(within(row as HTMLElement).getByRole("button", { name: /^reviewer · / })).toBeTruthy();
    expect(row.textContent).not.toContain("Hermes");
    expect(row.textContent).not.toContain("reviewer: none");
  });
  it("does not claim Hermes reviewed when the reviewer session is no longer in the store", () => {
    const t = task({
      status: "reviewing",
      reviewSessionId: 55,
      reviewRunId: "r",
      reviewRunIngestedId: "r",
    } as never);
    setTasks([t], { sessions: [] });
    renderDetail(t.id);
    const row = sessionsRow(screen.getByTestId("task-detail-view"));
    expect(row.textContent).toContain("reviewer: ended");
    expect(row.textContent).not.toContain("Hermes");
  });
  it("reads 'worker: ended' when the worker session is no longer in the store", () => {
    const t = task({ status: "reviewing", sessionId: 41 } as never);
    setTasks([t], { sessions: [] });
    renderDetail(t.id);
    const row = sessionsRow(screen.getByTestId("task-detail-view"));
    expect(row.textContent).toContain("worker: ended");
    expect(row.textContent).not.toContain("worker: none");
  });
  it("keeps 'reviewer: none' with neither a session nor a run", () => {
    const t = task({ status: "reviewing" });
    setTasks([t]);
    renderDetail(t.id);
    expect(screen.getByText("reviewer: none")).toBeTruthy();
  });
});

describe("TaskDetailView", () => {
  it("leads with the status block, then actions, details and the timeline", () => {
    const t = task({ status: "backlog", title: "Parked thing" });
    setTasks([t]);
    renderDetail(t.id);
    const view = screen.getByTestId("task-detail-view");
    expect(within(view).getByText("BACKLOG")).toBeTruthy();
    expect(within(view).getByText(/Parked\./)).toBeTruthy();
    expect(within(view).getByRole("button", { name: "Move to Ready" })).toBeTruthy();
    expect(within(view).getByText("Details")).toBeTruthy();
    expect(within(view).getByTestId("timeline")).toBeTruthy();
    // Section order: status block before details before timeline.
    const html = view.innerHTML;
    expect(html.indexOf("task-status-block")).toBeLessThan(html.indexOf("Details"));
    expect(html.indexOf("Details")).toBeLessThan(html.indexOf("timeline"));
  });

  it("shows a blocked task's blocker as a link that selects that task, with its siblings", async () => {
    const user = userEvent.setup();
    const blocker = task({
      status: "reviewing",
      issueNumber: 500,
      htmlUrl: "https://github.com/o/r/issues/500",
      title: "The blocker",
    });
    const a = task({ blockedState: "blocked", blockers: [ref(500)], title: "Blocked A" });
    const b = task({ blockedState: "blocked", blockers: [ref(500)], title: "Blocked B" });
    setTasks([blocker, a, b]);
    renderDetail(a.id);
    const view = screen.getByTestId("task-detail-view");
    expect(within(view).getByText("BLOCKED")).toBeTruthy();
    expect(within(view).getByText(/Starts automatically when/)).toBeTruthy();
    expect(within(view).getByText("Blocked by")).toBeTruthy();
    expect(within(view).getByText("Blocked B")).toBeTruthy();
    // The blocker reference selects the blocking task.
    await user.click(within(view).getAllByRole("button", { name: "#500" })[0]);
    expect(useDashboardStore.getState().selectedTaskId).toBe(blocker.id);
  });

  it("lists what a blocker blocks, three at first and the rest on demand", async () => {
    const user = userEvent.setup();
    const blocker = task({
      status: "reviewing",
      issueNumber: 500,
      htmlUrl: "https://github.com/o/r/issues/500",
    });
    const blocked = [1, 2, 3, 4, 5].map((n) =>
      task({ blockedState: "blocked", blockers: [ref(500)], title: `Waiting ${n}` }),
    );
    setTasks([blocker, ...blocked]);
    renderDetail(blocker.id);
    expect(screen.getByText("Blocks 5")).toBeTruthy();
    expect(screen.queryByText("Waiting 4")).toBeNull();
    await user.click(screen.getByRole("button", { name: "+ 2 more" }));
    expect(screen.getByText("Waiting 5")).toBeTruthy();
    const group = screen.getByText("Blocks 5").closest(".sb-hier-group") as HTMLElement;
    await user.click(within(group).getAllByRole("button", { name: /^#\d+$/ })[0]);
    expect(useDashboardStore.getState().selectedTaskId).toBe(blocked[0].id);
  });

  it("links the epic to its task when one tracks it, else to GitHub", () => {
    const epic = task({
      issueNumber: 900,
      htmlUrl: "https://github.com/o/r/issues/900",
      title: "Epic task",
    });
    const child = task({
      parentIssueNumber: 900,
      parentIssueRepo: "o/r",
      parentIssueTitle: "Epic title",
      subIssueTotal: null,
    });
    const orphan = task({
      parentIssueNumber: 77,
      parentIssueRepo: "elsewhere/repo",
      parentIssueTitle: "Elsewhere epic",
    });
    setTasks([epic, child, orphan]);
    const { unmount } = renderDetail(child.id);
    expect(screen.getByRole("button", { name: "#900" })).toBeTruthy();
    unmount();
    renderDetail(orphan.id);
    const link = screen.getByRole("link", { name: /#77/ });
    expect(link.getAttribute("href")).toBe("https://github.com/elsewhere/repo/issues/77");
    expect(screen.getByText("Elsewhere epic")).toBeTruthy();
  });

  it("opens an epic issue of a tracked repo in the GitHub tab, with Back returning to the task", async () => {
    const user = userEvent.setup();
    const openRightSidebarIssue = vi.fn();
    const child = task({
      parentIssueNumber: 77,
      parentIssueRepo: "o/r",
      parentIssueTitle: "Epic title",
    });
    setTasks([child], { openRightSidebarIssue });
    renderDetail(child.id);
    await user.click(screen.getByRole("link", { name: /#77/ }));
    expect(openRightSidebarIssue).toHaveBeenCalledWith(child.projectId, 77, {
      kind: "task",
      taskId: child.id,
    });
  });

  it("shows sub-issue progress for an epic and its child tasks", () => {
    const epic = task({
      issueNumber: 900,
      htmlUrl: "https://github.com/o/r/issues/900",
      subIssueTotal: 9,
      subIssueCompleted: 3,
    });
    const child = task({ parentIssueNumber: 900, parentIssueRepo: "o/r", title: "Child one" });
    setTasks([epic, child]);
    renderDetail(epic.id);
    expect(screen.getByText("3 of 9 complete")).toBeTruthy();
    expect(screen.getByText("Child one")).toBeTruthy();
  });

  it("shows the review state and opens the worker and reviewer sessions", async () => {
    const user = userEvent.setup();
    const openSessionInWorkspace = vi.fn();
    const t = task({
      status: "reviewing",
      approvalState: "awaiting-human",
      sessionId: 7,
      reviewSessionId: 8,
      autoReturnRounds: 2,
      autoReturnCapped: true,
      lastReviewVerdict: "REQUEST_CHANGES",
    });
    const sessions = [7, 8].map(
      (id) => ({ id, sessionStatus: "idle", sessionStatusDetail: null }) as unknown as Session,
    );
    setTasks([t], { sessions, openSessionInWorkspace });
    renderDetail(t.id);
    expect(screen.getByText("REVIEWING")).toBeTruthy();
    expect(screen.getByText(/Approve to merge/)).toBeTruthy();
    expect(screen.getByText("waiting for a human")).toBeTruthy();
    expect(screen.getByText(/2 auto-returns \(limit reached\)/)).toBeTruthy();
    expect(screen.getByText("REQUEST_CHANGES")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^worker/ }));
    expect(openSessionInWorkspace).toHaveBeenCalledWith(7);
    await user.click(screen.getByRole("button", { name: /^reviewer/ }));
    expect(openSessionInWorkspace).toHaveBeenCalledWith(8);
  });

  it("returns to the pull request it was reached from, otherwise to the list", async () => {
    const user = userEvent.setup();
    const t = task({ status: "reviewing", prNumber: 33, prTitle: "Fix it" });
    const onBack = vi.fn();
    const openRightSidebarPr = vi.fn();
    setTasks([t], { openRightSidebarPr });
    useDashboardStore.setState({
      sidebarHistory: [
        { to: { kind: "task", taskId: t.id }, back: { kind: "pr", projectId: 4, number: 33 } },
      ],
    });
    renderDetail(t.id, onBack);
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(openRightSidebarPr).toHaveBeenCalledWith(4, 33, null);
    expect(onBack).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("opens the pull request and the issue in the GitHub view", async () => {
    const user = userEvent.setup();
    const openRightSidebarPr = vi.fn();
    const openRightSidebarIssue = vi.fn();
    const t = task({ status: "reviewing", prNumber: 33, prTitle: "Fix it", issueNumber: 12 });
    setTasks([t], { openRightSidebarPr, openRightSidebarIssue });
    renderDetail(t.id);
    await user.click(screen.getByRole("button", { name: "PR #33" }));
    expect(openRightSidebarPr).toHaveBeenCalledWith(4, 33, { kind: "task", taskId: t.id });
    await user.click(screen.getByRole("button", { name: "#12" }));
    expect(openRightSidebarIssue).toHaveBeenCalledWith(4, 12, { kind: "task", taskId: t.id });
  });

  it("pops out to the docked panel and goes back", async () => {
    const user = userEvent.setup();
    const requestOpenTask = vi.fn();
    const onBack = vi.fn();
    const t = task({});
    setTasks([t], { requestOpenTask });
    renderDetail(t.id, onBack);
    await user.click(screen.getByRole("button", { name: "Pop out to a docked panel" }));
    expect(requestOpenTask).toHaveBeenCalledWith(t.id);
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalled();
  });

  it("collapses a long body behind Show more", async () => {
    const user = userEvent.setup();
    const t = task({ body: `start ${"word ".repeat(120)}END` });
    setTasks([t]);
    renderDetail(t.id);
    const text = screen.getByText(/END/).closest("[id^='task-body-']") as HTMLElement;
    expect(text.className).toContain("sb-body-text--clamped");
    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(text.className).not.toContain("sb-body-text--clamped");
    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(text.className).toContain("sb-body-text--clamped");
  });

  it("says a done task's merge failed instead of 'nothing left to do'", () => {
    const t = task({ status: "done", prNumber: 5, mergeError: "required check failing on main" });
    setTasks([t]);
    renderDetail(t.id);
    expect(
      screen.getByText(/Approved, but the merge failed: required check failing on main/),
    ).toBeTruthy();
    expect(screen.queryByText(/Nothing left to do/)).toBeNull();
  });

  it("hides the step tracker for a failed task and shows why it failed", () => {
    const t = task({ status: "failed", failureReason: "budget exceeded" });
    setTasks([t]);
    renderDetail(t.id);
    expect(screen.queryByRole("list", { name: "Progress" })).toBeNull();
    expect(screen.getAllByText("budget exceeded").length).toBeGreaterThan(0);
  });

  it("marks the current step and folds Claimed into In progress", () => {
    const t = task({ status: "claimed", sessionId: 3 });
    setTasks([t]);
    renderDetail(t.id);
    const steps = screen.getByRole("list", { name: "Progress" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(5);
    expect(within(steps).getByText("In progress").closest("li")?.getAttribute("aria-current")).toBe(
      "step",
    );
    expect(screen.getByText("IN PROGRESS")).toBeTruthy();
  });
});
