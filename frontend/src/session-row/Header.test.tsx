// @vitest-environment jsdom
// SessionRow row 1 — the `.session-item-row` strip: status label, kebab
// menu, and rename-in-place. Split out of the former monolithic
// SessionRow.test.tsx (PR 27 phase 2, Wave 5 of
// .claude/plans/can-we-do-a-warm-cocke.md) — owns every test that exercises
// Header.tsx's own region. Still mounts the full `<SessionRow>` (see
// GitLine.test.tsx's own header comment for why — same reasoning: the
// status label's text/tooltip is derived from STATUS_PRESENTATION/
// formatStatusLabel/isStatusReachable in SessionRow itself, which Header
// only receives as an already-built `statusLabel` node). Rename IS entirely
// local to Header's own state, but a full mount is still the simplest way
// to drive it through real DOM events (double-click/Enter/Escape/blur)
// without hand-building Header's dozen other props.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionRow } from "../Sidebar.js";
import {
  type GitBranchesResult,
  type GitDiffStats,
  type GitHubPRsStatus,
  type GitStatus,
  type NotificationEvent,
  type Project,
  type Session,
} from "../api.js";
import { makeSession, makeProject } from "../test/fixtures.js";

let events: Record<number, NotificationEvent[]>;
let sessionGitStatuses: Record<number, GitStatus | null>;
let gitDiffStats: Record<number, GitDiffStats | null>;
let gitBranchesByProject: Record<number, GitBranchesResult | undefined>;
let prsByProject: Record<number, GitHubPRsStatus | undefined>;
let sessions: Session[];
const promoteSessionMock = vi.fn().mockResolvedValue(undefined);
const declinePromoteMock = vi.fn().mockResolvedValue(undefined);
const renameSessionMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../store.js", () => ({
  useDashboardStore: (selector: (s: unknown) => unknown) =>
    selector({
      settings: { sessions: { confirmBeforeKill: false } },
      theme: "dark",
      events,
      sessionGitStatuses,
      gitDiffStats,
      gitBranchesByProject,
      prsByProject,
      sessions,
      promoteSession: promoteSessionMock,
      declinePromote: declinePromoteMock,
      renameSession: renameSessionMock,
    }),
}));

const PROJECT: Project = makeProject();

beforeEach(() => {
  events = {};
  sessionGitStatuses = {};
  gitDiffStats = {};
  gitBranchesByProject = {};
  prsByProject = {};
  sessions = [];
  localStorage.clear();
});

describe("SessionRow row 1 — header: kebab menu", () => {
  it("does not show the kebab menu for a killed session", () => {
    render(
      <SessionRow
        session={makeSession({ status: "killed" })}
        project={PROJECT}
        onOpen={vi.fn()}
        onEnd={vi.fn()}
      />,
    );
    expect(screen.queryByTitle("More…")).not.toBeInTheDocument();
  });
});

describe("SessionRow row 1 — header: status label", () => {
  it("shows 'Needs permission' label when sessionStatus is awaiting_permission", async () => {
    const session = makeSession({
      permissionState: "pending",
      sessionStatus: "awaiting_permission",
      sessionStatusSeverity: "blocked",
    });
    const { findByText } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(await findByText("Needs permission")).toBeInTheDocument();
  });

  it("shows 'Plan ready' label when sessionStatus is awaiting_plan", async () => {
    const session = makeSession({
      planState: "pending",
      sessionStatus: "awaiting_plan",
      sessionStatusSeverity: "blocked",
    });
    const { findByText } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(await findByText("Plan ready")).toBeInTheDocument();
  });

  it("shows 'API error' label when sessionStatus is api_error", async () => {
    const session = makeSession({
      errorState: "api_error",
      sessionStatus: "api_error",
      sessionStatusSeverity: "failed",
    });
    const { findByText } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(await findByText("API error")).toBeInTheDocument();
  });

  it("shows 'exited: clear' label when sessionStatus is exited with a matching detail", async () => {
    const session = makeSession({
      status: "exited",
      endedReason: "clear",
      sessionStatus: "exited",
      sessionStatusSeverity: "gone",
      sessionStatusDetail: "clear",
    });
    const { findByText } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(await findByText("exited: clear")).toBeInTheDocument();
  });

  it("shows 'Finished' label when sessionStatus is finished", async () => {
    const session = makeSession({
      lastTurnEndedAt: Date.now(),
      sessionStatus: "finished",
      sessionStatusSeverity: "done",
    });
    const { findByText } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(await findByText("Finished")).toBeInTheDocument();
  });

  it("renders a long sessionStatusDetail as a single truncating label with a title, not a spilling one (sidebar overflow fix)", async () => {
    const longDetail =
      'Bash: grep -n "OUTPUT_IMMUNE_KINDS" -A 30 /home/bjoern/projects/claude-remote-session/src';
    const session = makeSession({
      errorState: "tool_failure",
      sessionStatus: "tool_failure",
      sessionStatusSeverity: "failed",
      sessionStatusDetail: longDetail,
    });
    const { container, findByText } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    const label = await findByText(`Tool failure: ${longDetail}`);
    expect(label).toHaveClass("session-status-label");
    expect(label).toHaveAttribute("title", `Tool failure: ${longDetail}`);
    // Exactly one label span — the overflow guard is CSS (ellipsis), not a
    // second truncated element rendered alongside the full text.
    expect(container.querySelectorAll(".session-status-label")).toHaveLength(1);
  });

  // Issue #319 — estimated status rendering: when an agent's emits DON'T
  // cover a session's status, the row gets .status-estimated styling and the
  // dot gets the .estimated class + a tooltip explaining it's inferred.
  it("renders estimated styling when agent emits don't cover the session status", async () => {
    const session = makeSession({
      command: "claude code",
      sessionStatus: "api_error",
      sessionStatusSeverity: "failed",
      hookEmits: [], // no emits -> api_error is unreachable
      pendingDevServerPort: null,
      outstandingBackgroundTasks: [],
    });
    render(<SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />);

    // Row-level: should have both status-attention (severity stripe) and
    // status-estimated (dotted border-left) classes.
    const row = await screen.findByText("API error").then((el) => el.closest(".session-item"));
    expect(row).toBeTruthy();
    expect(row!.classList.contains("status-attention")).toBe(true);
    expect(row!.classList.contains("status-estimated")).toBe(true);

    // Dot: should carry .estimated class and tooltip.
    const dot = row!.querySelector(".session-dot-wrap");
    expect(dot).toBeTruthy();
    expect(dot!.getAttribute("title")).toBe(
      "Estimated status — this agent doesn't report this state directly",
    );
    expect(dot!.querySelector(".session-dot-error.estimated")).toBeTruthy();
  });

  it("does not render estimated styling when agent emits cover the session status", async () => {
    const session = makeSession({
      command: "claude code",
      sessionStatus: "api_error",
      sessionStatusSeverity: "failed",
      hookEmits: ["stop_failure"], // covers api_error
      pendingDevServerPort: null,
      outstandingBackgroundTasks: [],
    });
    render(<SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />);

    const row = await screen.findByText("API error").then((el) => el.closest(".session-item"));
    expect(row).toBeTruthy();
    expect(row!.classList.contains("status-attention")).toBe(true);
    expect(row!.classList.contains("status-estimated")).toBe(false);

    const dot = row!.querySelector(".session-dot-wrap");
    expect(dot).toBeTruthy();
    expect(dot!.getAttribute("title")).toBeNull();
    expect(dot!.querySelector(".session-dot-error:not(.estimated)")).toBeTruthy();
  });
});

describe("SessionRow row 1 — header: rename", () => {
  it("double-clicking the session name opens rename input pre-filled with the current title", async () => {
    const session = makeSession({ lastTitle: "My Shell Session", command: "bash" });
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    const nameEl = container.querySelector(".session-name")!;
    await user.dblClick(nameEl);

    const input = container.querySelector(".session-rename-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("My Shell Session");
    expect(container.querySelector(".session-name")).toBeNull();
  });

  it("double-clicking the session name fills the rename input with the nameLocked name", async () => {
    const session = makeSession({
      name: "Renamed Title",
      nameLocked: true,
      lastTitle: "Original Title",
      command: "bash",
    });
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    const nameEl = container.querySelector(".session-name")!;
    await user.dblClick(nameEl);

    const input = container.querySelector(".session-rename-input") as HTMLInputElement;
    expect(input.value).toBe("Renamed Title");
  });

  it("commits the rename on Enter and calls renameSession", async () => {
    renameSessionMock.mockClear();
    const session = makeSession({ command: "bash" });
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    const nameEl = container.querySelector(".session-name")!;
    await user.dblClick(nameEl);
    const input = container.querySelector(".session-rename-input") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "New Name");
    await user.keyboard("{Enter}");

    expect(renameSessionMock).toHaveBeenCalledWith(session.id, "New Name");
    // Should revert to showing the span, not the input
    expect(container.querySelector(".session-name")).toBeTruthy();
    expect(container.querySelector(".session-rename-input")).toBeNull();
  });

  it("does not call renameSession on Enter when the input is empty", async () => {
    renameSessionMock.mockClear();
    const session = makeSession({ command: "bash" });
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    const nameEl = container.querySelector(".session-name")!;
    await user.dblClick(nameEl);
    const input = container.querySelector(".session-rename-input") as HTMLInputElement;
    await user.clear(input);
    await user.keyboard("{Enter}");

    expect(renameSessionMock).not.toHaveBeenCalled();
    expect(container.querySelector(".session-name")).toBeTruthy();
  });

  it("cancels the rename on Escape", async () => {
    renameSessionMock.mockClear();
    const session = makeSession({ lastTitle: "Original", command: "bash" });
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    const nameEl = container.querySelector(".session-name")!;
    await user.dblClick(nameEl);
    const input = container.querySelector(".session-rename-input") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "Typed But Cancelled");
    await user.keyboard("{Escape}");

    expect(renameSessionMock).not.toHaveBeenCalled();
    expect(container.querySelector(".session-name")).toBeTruthy();
    expect(container.querySelector(".session-rename-input")).toBeNull();
    expect(container.querySelector(".session-name")!.textContent).toBe("Original");
  });

  it("commits the rename on blur (click away)", async () => {
    renameSessionMock.mockClear();
    const session = makeSession({ command: "bash" });
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    const nameEl = container.querySelector(".session-name")!;
    await user.dblClick(nameEl);
    const input = container.querySelector(".session-rename-input") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "Blur Rename");
    // Click somewhere else to blur the input
    await user.click(container.querySelector(".session-item")!);

    expect(renameSessionMock).toHaveBeenCalledWith(session.id, "Blur Rename");
    expect(container.querySelector(".session-name")).toBeTruthy();
  });

  it("opens the rename input from the kebab menu Rename item", async () => {
    const session = makeSession({
      command: "bash",
      status: "active",
      lastTitle: "Kebab Rename",
    });
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={session} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    await user.click(screen.getByTitle("More…"));
    await user.click(await screen.findByText("Rename"));

    const input = container.querySelector(".session-rename-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("Kebab Rename");
  });
});
