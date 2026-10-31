// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  LinkedActions,
  ReviewGateChip,
  SessionPills,
  TaskChip,
  splitTaskSessions,
  decideIssueSessionAction,
  decideSessionAction,
  gatedSessions,
  severityTone,
} from "./index.js";
import { buildMullionLinks, type MullionLinkEntry } from "../../hooks/useMullionLinks.js";
import { api } from "../../api/index.js";
import { useDashboardStore } from "../../store/index.js";
import { makeProject, makeSession, makeTask } from "../../test/fixtures.js";

vi.mock("../../api/index.js", async (orig) => {
  const mod = await orig<Record<string, unknown> & { api: Record<string, unknown> }>();
  return {
    ...mod,
    api: { ...mod.api, stopReview: vi.fn(async () => ({ runId: "r1", status: "stopped" })) },
  };
});

const entryFor = (
  sessions = [makeSession({ id: 1, liveBranch: "b" })],
  extra: Partial<MullionLinkEntry> = {},
) => ({
  ...(buildMullionLinks({ project: makeProject({ id: 1 }), sessions, tasks: [] }).byBranch.get(
    "b",
  ) ?? {
    sessions: [],
    task: null,
    taskOwned: false,
    reviewRun: null,
    preview: null,
    promoteRequest: null,
    devServer: null,
  }),
  ...extra,
});

beforeEach(() => vi.clearAllMocks());

describe("SessionPills", () => {
  it("renders severity tone, attention flag, nesting; click opens the session", () => {
    const parent = makeSession({
      id: 1,
      name: "parent",
      liveBranch: "b",
      sessionStatusSeverity: "failed",
      sessionStatusAttentionRequired: true,
    });
    const child = makeSession({ id: 2, name: "kid", parentSessionId: 1 });
    const e = entryFor([parent, child]);
    const onOpen = vi.fn();
    render(<SessionPills links={e.sessions} onOpenSession={onOpen} />);
    const parentBtn = screen.getByRole("button", { name: /parent/ });
    expect(parentBtn.className).toContain("sb-chip--danger");
    expect(screen.getByRole("img", { name: "needs attention" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /kid/ }));
    expect(onOpen).toHaveBeenCalledWith(2);
  });

  it("defaults to the store's requestOpenSession and renders nothing when empty", () => {
    const e = entryFor();
    const spy = vi.spyOn(useDashboardStore.getState(), "requestOpenSession");
    useDashboardStore.setState({ requestOpenSession: spy });
    render(<SessionPills links={e.sessions} />);
    fireEvent.click(screen.getByRole("button"));
    expect(spy).toHaveBeenCalledWith(1);
    const { container } = render(<SessionPills links={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("maps every severity to a tone", () => {
    expect(
      (["gone", "failed", "blocked", "done", "waiting", "busy", "dormant"] as const).map(
        severityTone,
      ),
    ).toEqual(["neutral", "danger", "warn", "success", "warn", "info", "neutral"]);
  });
});

describe("TaskChip", () => {
  it("shows status, lock variant and opens the task", () => {
    const onOpen = vi.fn();
    render(<TaskChip task={{ id: 7, status: "reviewing" }} locked onOpen={onOpen} />);
    const chip = screen.getByRole("button", { name: /#7 · reviewing/ });
    expect(chip.textContent).toContain("🔒");
    expect(chip.className).toContain("sb-chip--warn");
    fireEvent.click(chip);
    expect(onOpen).toHaveBeenCalledWith(7);
  });

  it.each([
    ["done", "success"],
    ["failed", "danger"],
    ["in_progress", "info"],
    ["ready", "neutral"],
  ] as const)("%s -> %s", (status, tone) => {
    const { container } = render(<TaskChip task={{ id: 1, status }} />);
    expect(container.querySelector(`.sb-chip--${tone}`)).not.toBeNull();
  });

  it("renders the bot badge and a status-toned label", () => {
    const { container } = render(<TaskChip task={{ id: 9, status: "done" }} />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector(".sb-chip--task.sb-chip--success")).not.toBeNull();
    expect(container.textContent).toBe("#9 · done");
  });

  describe("live dot", () => {
    const link = (id: number, severity: "busy" | "failed") =>
      ({
        session: makeSession({ id, sessionStatus: "working" }),
        severity,
        attention: false,
        children: [],
      }) as never;
    const task = { id: 3, status: "reviewing", sessionId: 10, reviewSessionId: 11 } as const;
    const dotClass = (c: HTMLElement) =>
      c.querySelector('[data-testid="task-session-dot"]')?.className;

    it("tracks the reviewer while reviewing with a review in flight", () => {
      const { container } = render(
        <TaskChip task={task} sessions={[link(10, "busy"), link(11, "failed")]} reviewInFlight />,
      );
      expect(dotClass(container)).toContain("sb-task-dot--danger");
    });

    it("tracks the worker otherwise", () => {
      const { container } = render(
        <TaskChip task={task} sessions={[link(10, "busy"), link(11, "failed")]} />,
      );
      expect(dotClass(container)).toContain("sb-task-dot--info");
    });

    it("has no dot when the task's sessions aren't among the row's", () => {
      const { container } = render(<TaskChip task={task} sessions={[link(99, "busy")]} />);
      expect(dotClass(container)).toBeUndefined();
    });
  });

  // #2020 — with no onOpen, a click asks the app shell to open the task.
  it("dispatches requestOpenTask when no onOpen is given", () => {
    const requestOpenTask = vi.fn();
    useDashboardStore.setState({ requestOpenTask });
    render(<TaskChip task={{ id: 4, status: "in_progress" }} />);
    fireEvent.click(screen.getByRole("button", { name: /#4 · in_progress/ }));
    expect(requestOpenTask).toHaveBeenCalledWith(4);
  });
});

describe("review gate (#2019)", () => {
  const link = (id: number, over: Record<string, unknown> = {}, children: unknown[] = []) =>
    ({ session: makeSession({ id, ...over }), children }) as never;

  it("collects gated sessions, children included", () => {
    const gated = gatedSessions([
      link(1, { sessionStatus: "running" }, [link(2, { sessionStatus: "awaiting_review_gate" })]),
      link(3, { sessionStatus: "awaiting_review_gate" }),
    ]);
    expect(gated.map((s) => s.id)).toEqual([2, 3]);
    expect(gatedSessions(undefined)).toEqual([]);
  });

  it("renders nothing with no gated session", () => {
    const { container } = render(<ReviewGateChip sessions={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the gate prompt and what releases it", () => {
    render(
      <ReviewGateChip
        sessions={[
          makeSession({ id: 1, name: "worker", gatePrompt: "Run rm -rf build?" }),
          makeSession({ id: 2, name: null, gatePrompt: null }),
        ]}
      />,
    );
    const chip = screen.getByText("review gate · 2");
    expect(chip.className).toContain("sb-chip--warn");
    expect(chip.title).toContain("worker: Run rm -rf build?");
    expect(chip.title).toContain("Session 2");
    expect(chip.title).toContain("Approve or deny in the session or the notification bell");
  });
});

describe("LinkedActions", () => {
  it("decides open-existing vs start", () => {
    expect(decideSessionAction(undefined)).toEqual({ kind: "start" });
    expect(decideSessionAction(entryFor([]) as never)).toEqual({ kind: "start" });
    expect(decideSessionAction(entryFor())).toEqual({ kind: "open-existing", sessionId: 1 });
  });

  it("defers an issue with a not-yet-started task to the task, else keeps today's behaviour", () => {
    const withTask = (status: string, sessions: unknown[] = []) =>
      ({ ...entryFor([]), task: makeTask({ id: 9, status: status as never }), sessions }) as never;
    for (const status of ["pending", "ready", "claimed", "backlog"]) {
      expect(decideIssueSessionAction(withTask(status))).toEqual({
        kind: "task",
        taskId: 9,
        status,
      });
    }
    expect(decideIssueSessionAction(withTask("in_progress"))).toEqual({ kind: "start" });
    expect(decideIssueSessionAction(entryFor([]) as never)).toEqual({ kind: "start" });
    expect(decideIssueSessionAction(undefined)).toEqual({ kind: "start" });
    const live = { ...(withTask("claimed") as object), sessions: entryFor().sessions };
    expect(decideIssueSessionAction(live as never)).toEqual({
      kind: "open-existing",
      sessionId: 1,
    });
  });

  it("prefers a live session over an exited one that sorts first", () => {
    const link = (id: number, alive: boolean) =>
      ({ session: makeSession({ id, alive }), children: [] }) as never;
    const entry = { ...entryFor(), sessions: [link(1, false), link(2, true)] };
    expect(decideSessionAction(entry as never)).toEqual({ kind: "open-existing", sessionId: 2 });
    const dead = { ...entryFor(), sessions: [link(3, false), link(4, false)] };
    expect(decideSessionAction(dead as never)).toEqual({ kind: "open-existing", sessionId: 3 });
  });

  it("opens a task's own worker over any other session on the branch", () => {
    const link = (id: number, alive: boolean) =>
      ({ session: makeSession({ id, alive }), children: [] }) as never;
    const task = makeTask({ id: 5, sessionId: 4, reviewSessionId: 2 });
    // 2 (the reviewer) is alive and sorts first; 4 is the worker, idle but its own.
    const entry = { ...entryFor(), task, sessions: [link(2, true), link(4, false)] };
    expect(decideSessionAction(entry as never)).toEqual({ kind: "open-existing", sessionId: 4 });
    // A worker that is not among the branch's sessions falls back to the usual pick.
    const gone = { ...entryFor(), task, sessions: [link(2, true)] };
    expect(decideSessionAction(gone as never)).toEqual({ kind: "open-existing", sessionId: 2 });
  });

  it("Open existing session replaces the start action", () => {
    const spy = vi.fn();
    useDashboardStore.setState({ requestOpenSession: spy });
    const onStart = vi.fn();
    render(<LinkedActions entry={entryFor()} onStartSession={onStart} />);
    expect(screen.queryByRole("button", { name: "Open session" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open existing session" }));
    expect(spy).toHaveBeenCalledWith(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("offers Open session when none exists, and Preview", () => {
    const onStart = vi.fn();
    const onPreview = vi.fn();
    render(<LinkedActions entry={undefined} onStartSession={onStart} onPreview={onPreview} />);
    fireEvent.click(screen.getByRole("button", { name: "Open session" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(onStart).toHaveBeenCalled();
    expect(onPreview).toHaveBeenCalled();
  });

  it("Stop review posts the stop for an in-flight run, and toasts on failure", async () => {
    const pushToast = vi.fn();
    useDashboardStore.setState({ pushToast });
    const e = entryFor([], {
      reviewRun: { runId: "r1", state: "requested", kind: "pull_request" },
    });
    render(<LinkedActions entry={e} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop review" }));
    await waitFor(() => expect(api.stopReview).toHaveBeenCalledWith("r1"));
    vi.mocked(api.stopReview).mockRejectedValueOnce(new Error("nope"));
    fireEvent.click(screen.getByRole("button", { name: "Stop review" }));
    await waitFor(() => expect(pushToast).toHaveBeenCalled());
  });

  it("hides Stop review when the landed lookup could not be verified", () => {
    const e = entryFor([], {
      reviewRun: { runId: "r1", state: "requested", unverified: true, kind: "pull_request" },
    });
    render(<LinkedActions entry={e} />);
    expect(screen.queryByRole("button", { name: "Stop review" })).toBeNull();
    expect(screen.getByText("Review status unverified")).toBeInTheDocument();
  });

  it("hides Stop review for a landed run", () => {
    const e = entryFor([], { reviewRun: { runId: "r1", state: "landed", kind: "pull_request" } });
    render(<LinkedActions entry={e} />);
    expect(screen.queryByRole("button", { name: "Stop review" })).toBeNull();
  });
});

describe("splitTaskSessions", () => {
  const l = (id: number, children: unknown[] = []) =>
    ({ session: makeSession({ id }), severity: "busy", attention: false, children }) as never;

  it("folds out the worker, reviewer and their children, keeping others", () => {
    const hand = l(3, [l(4)]);
    const { owned, rest } = splitTaskSessions([l(1, [l(5)]), l(2), hand], {
      sessionId: 1,
      reviewSessionId: 2,
    });
    expect(owned.map((o) => o.session.id)).toEqual([1, 2]);
    expect(rest.map((r) => r.session.id)).toEqual([3]);
    expect(rest[0]!.children.map((c) => c.session.id)).toEqual([4]);
  });

  it("keeps everything when there is no task", () => {
    expect(splitTaskSessions([l(1)], null).rest).toHaveLength(1);
  });
});
