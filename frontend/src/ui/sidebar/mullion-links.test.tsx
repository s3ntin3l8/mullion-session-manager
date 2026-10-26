// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  LinkedActions,
  SessionPills,
  TaskChip,
  decideSessionAction,
  severityTone,
} from "./index.js";
import { buildMullionLinks, type MullionLinkEntry } from "../../hooks/useMullionLinks.js";
import { api } from "../../api/index.js";
import { useDashboardStore } from "../../store/index.js";
import { makeProject, makeSession } from "../../test/fixtures.js";

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
    expect(parentBtn.className).toContain("sb-pill--danger");
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
    const chip = screen.getByRole("button", { name: /task #7 · reviewing/ });
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
});

describe("LinkedActions", () => {
  it("decides open-existing vs start", () => {
    expect(decideSessionAction(undefined)).toEqual({ kind: "start" });
    expect(decideSessionAction(entryFor([]) as never)).toEqual({ kind: "start" });
    expect(decideSessionAction(entryFor())).toEqual({ kind: "open-existing", sessionId: 1 });
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

  it("hides Stop review for a landed run", () => {
    const e = entryFor([], { reviewRun: { runId: "r1", state: "landed", kind: "pull_request" } });
    render(<LinkedActions entry={e} />);
    expect(screen.queryByRole("button", { name: "Stop review" })).toBeNull();
  });
});
