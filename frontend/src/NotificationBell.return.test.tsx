// @vitest-environment jsdom
//
// The bell's status chips (#3461) and its return path (#3463), on the real
// store: a row opens its target and records the panel's section and chip, the
// next opening restores them once, the phone's back reopens it, and a mode
// change forgets it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NotificationBell } from "./NotificationBell.js";
import { useDashboardStore } from "./store/index.js";
import { api } from "./api/index.js";
import { makeSession, makeTask } from "./test/fixtures.js";
import { resetStore } from "./test/resetStore.js";
import type { NotificationEvent, Session } from "./api/index.js";

const at = (
  sessionId: number,
  seq: number,
  kind: NotificationEvent["kind"],
  payload: Record<string, unknown> = {},
): NotificationEvent => ({ seq, sessionId, kind, ts: 1_700_000_000_000 + seq, payload });

const bell = () => screen.getByRole("button", { name: /^Notifications,/ });
const rows = () => document.querySelectorAll(".notif-event-row:not(.notif-grouped-line)");

function seed() {
  useDashboardStore.setState({
    sessions: [
      makeSession({ id: 1, name: "asks", permissionState: "pending" }),
      makeSession({ id: 2, name: "plans", planState: "pending" }),
      makeSession({ id: 3, name: "broke", errorState: "api_error" }),
      makeSession({ id: 4, name: "done" }),
    ],
    events: {
      1: [at(1, 1, "permission_request", { tool: "Bash", summary: "git push" })],
      2: [at(2, 1, "plan_ready", { plan: "do it" })],
      3: [at(3, 1, "stop_failure", { error: "overloaded" })],
      4: [at(4, 1, "attention", { attention: true, signal: "agentIdle" })],
    },
    tasks: [
      makeTask({ id: 21, title: "Broken task", status: "failed", failureReason: "x" }),
      makeTask({
        id: 22,
        title: "Approve me",
        status: "reviewing",
        approvalState: "awaiting-human",
      }),
    ],
  });
}

function renderBell(onOpenSession = vi.fn<(s: Session) => void>()) {
  render(<NotificationBell onOpenSession={onOpenSession} onOpenBrowser={() => {}} sheet />);
  return onOpenSession;
}
const click = (el: Element) =>
  act(() => {
    fireEvent.click(el);
  });

describe("the bell's status chips (#3461)", () => {
  beforeEach(() => {
    resetStore();
    vi.spyOn(api, "ackAttention").mockResolvedValue(undefined as never);
    seed();
  });
  afterEach(() => vi.restoreAllMocks());

  it("opens on Needs you, offers a chip per category with an open row, and filters by it", () => {
    renderBell();
    click(bell());
    expect(screen.getByRole("button", { name: "Needs you 3" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(rows()).toHaveLength(3);
    for (const name of ["All", "Permission 1", "Plan 1", "Failed 1"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    // No question or review is open: no chip for them.
    expect(screen.queryByRole("button", { name: /^Question/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Review/ })).toBeNull();

    click(screen.getByRole("button", { name: "Plan 1" }));
    expect(rows()).toHaveLength(1);
    expect(screen.getByText("plans")).toBeInTheDocument();
    expect(screen.queryByText("asks")).toBeNull();

    // All: the decisions and the grouped lines.
    click(screen.getByRole("button", { name: "All" }));
    expect(rows()).toHaveLength(3);
    expect(screen.getByText("Earlier, no decision needed")).toBeInTheDocument();
  });

  it("opens on All when nothing needs a decision", () => {
    useDashboardStore.setState({ sessions: [makeSession({ id: 4, name: "done" })], tasks: [] });
    renderBell();
    click(bell());
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Earlier, no decision needed")).toBeInTheDocument();
  });

  it("filters the Tasks section by kind", () => {
    renderBell();
    click(bell());
    click(screen.getByRole("button", { name: /^Tasks/ }));
    expect(document.querySelectorAll(".notif-task-row")).toHaveLength(2);
    click(screen.getByRole("button", { name: "Review 1" }));
    expect(document.querySelectorAll(".notif-task-row")).toHaveLength(1);
    expect(screen.getByText("Approve me")).toBeInTheDocument();
  });
});

describe("the bell's return path (#3463)", () => {
  beforeEach(() => {
    resetStore();
    vi.spyOn(api, "ackAttention").mockResolvedValue(undefined as never);
    seed();
  });
  afterEach(() => vi.restoreAllMocks());

  it("a row opens its session and records the section and chip; reopening restores them once", () => {
    const onOpenSession = renderBell();
    click(bell());
    click(screen.getByRole("button", { name: "Plan 1" }));
    click(screen.getByRole("button", { name: /^Plan: / }));
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    expect(useDashboardStore.getState().bellReturn).toEqual({
      section: "sessions",
      filter: "plan",
    });

    click(bell());
    expect(screen.getByRole("button", { name: "Plan 1" })).toHaveAttribute("aria-pressed", "true");
    expect(useDashboardStore.getState().bellReturn).toBeNull();

    // Consumed: the next plain opening is back on the default chip.
    click(screen.getByRole("button", { name: "Close notifications" }));
    click(bell());
    expect(screen.getByRole("button", { name: "Needs you 3" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("a session row opened from Tasks mode keeps its return across the switch to Workspace", () => {
    useDashboardStore.setState({ viewMode: "kanban" });
    // App's opener leaves Tasks mode first (usePanelOpener's leaveTaskView).
    renderBell(vi.fn(() => useDashboardStore.getState().setViewMode("list")));
    click(bell());
    click(screen.getByRole("button", { name: /^Permission: / }));
    expect(useDashboardStore.getState().viewMode).toBe("list");
    expect(useDashboardStore.getState().bellReturn).toEqual({
      section: "sessions",
      filter: "needs",
    });
  });

  it("a task row opens the task through useOpenTask and records the Tasks section", () => {
    renderBell();
    click(bell());
    click(screen.getByRole("button", { name: /^Tasks/ }));
    click(screen.getByRole("button", { name: /^Failed: Broken task/ }));
    expect(useDashboardStore.getState().selectedTaskId).toBe(21);
    expect(useDashboardStore.getState().bellReturn).toEqual({ section: "tasks", filter: "needs" });
  });

  it("the phone's back from the target reopens the bell where it was left", () => {
    renderBell();
    click(bell());
    click(screen.getByRole("button", { name: "Failed 1" }));
    click(screen.getByRole("button", { name: /^Stop: / }));
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();

    // App.tsx's back handler.
    act(() => useDashboardStore.getState().requestBellReopen());
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Failed 1" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("a real mode change forgets the return; staying in the mode keeps it", () => {
    const back = { section: "sessions" as const, filter: "plan" };
    act(() => useDashboardStore.getState().setBellReturn(back));
    act(() => useDashboardStore.getState().setViewMode("list"));
    expect(useDashboardStore.getState().bellReturn).toEqual(back);
    act(() => useDashboardStore.getState().setViewMode("kanban"));
    expect(useDashboardStore.getState().bellReturn).toBeNull();
  });

  it("an inline gate answer does not leave the panel", () => {
    useDashboardStore.setState({
      sessions: [makeSession({ id: 1, gates: [{ gateId: "g", prompt: "Deploy?", at: 1 }] })],
      events: {
        1: [at(1, 1, "review_gate", { state: "waiting", prompt: "Deploy?", gateId: "g" })],
      },
      tasks: [],
    });
    const resolve = vi.spyOn(api, "resolveReviewGate").mockResolvedValue(undefined as never);
    renderBell();
    click(bell());
    click(screen.getByRole("button", { name: "Approve" }));
    expect(resolve).toHaveBeenCalledWith(1, "g", "approved");
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeInTheDocument();
    expect(useDashboardStore.getState().bellReturn).toBeNull();
  });
});
