// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PromoteDialog } from "./PromoteDialog.js";
import type { Project, Session } from "./api/index.js";
import { jsonResponse } from "./test/jsonResponse.js";

// Issue #271 — PromoteDialog reads two store actions directly; everything
// else it needs (project/session/onClose) comes via props.
const promoteSessionMock = vi.fn();
const declinePromoteMock = vi.fn();
vi.mock("./store/index.js", () => ({
  useDashboardStore: (selector: (s: unknown) => unknown) =>
    selector({ promoteSession: promoteSessionMock, declinePromote: declinePromoteMock }),
}));

const PROJECT: Project = {
  id: 1,
  name: "demo",
  cwd: "/home/x/demo",
  hostId: "local",
  devServerUrl: null,
  detectedDevServerPort: null,
  currentBranch: null,
  autoFetch: null,
  ruleFiles: [],
  defaultAgent: null,
  defaultReviewAgent: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 42,
    parentSessionId: null,
    projectId: 1,
    name: null,
    nameLocked: false,
    command: "claude code",
    cwd: null,
    kind: "terminal",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastAttachedAt: null,
    alive: true,
    subscriberCount: 0,
    activity: "idle",
    lastActivityAt: null,
    liveCwd: null,
    previewBranch: null,
    attention: false,
    attentionAt: null,
    lastTitle: null,
    gateState: "idle",
    gatePrompt: null,
    promoteState: "idle",
    promoteSummary: null,
    promoteSuggestedBaseRef: null,
    permissionState: "idle",
    planState: "idle",
    errorState: "idle",
    endedReason: null,
    liveBranch: null,
    // Rich statuses (issue: extend surfaced session statuses).
    exitCode: null,
    attentionKind: null,
    errorDetail: null,
    lastAssistantMessage: null,
    compactState: "idle",
    subagentCount: 0,
    subagents: [],
    elicitationState: "idle",
    elicitationServer: null,
    lastTurnEndedAt: null,
    stateRestored: true,
    staleHooks: false,
    restoredVersion: null,
    sessionStatus: "idle",
    sessionStatusSeverity: "dormant",
    sessionStatusDetail: null,
    sessionStatusAttentionRequired: false,
    hookEmits: [],
    pendingDevServerPort: null,
    outstandingBackgroundTasks: [],
    ...overrides,
  };
}

describe("PromoteDialog (issue #271)", () => {
  beforeEach(() => {
    promoteSessionMock.mockReset().mockResolvedValue(undefined);
    declinePromoteMock.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(200, {
            branches: [
              { name: "main", isCurrent: true },
              { name: "feature/x", isCurrent: false },
            ],
            worktrees: [],
            remoteBranches: ["origin/main"],
          }),
        ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("human-initiated: shows Cancel, no pending-agent copy, and defaults the base ref to the current branch", async () => {
    render(<PromoteDialog session={makeSession()} project={PROJECT} onClose={vi.fn()} />);

    expect(
      await screen.findByText("Move this session's work into a fresh, isolated worktree."),
    ).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    expect(select).toHaveDisplayValue("main (current)");
  });

  it("submits baseRef/branchName/seedPrompt to promoteSession and closes on success", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<PromoteDialog session={makeSession()} project={PROJECT} onClose={onClose} />);

    await screen.findByRole("combobox");
    await user.selectOptions(screen.getByRole("combobox"), "feature/x");
    await user.type(screen.getByPlaceholderText(/mullion\/session-42/), "my-branch");
    await user.type(screen.getByPlaceholderText(/delivered as additional context/i), "resume here");
    await user.click(screen.getByText("Create worktree"));

    expect(promoteSessionMock).toHaveBeenCalledWith(42, {
      baseRef: "feature/x",
      branchName: "my-branch",
      seedPrompt: "resume here",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows an error and stays open when promoteSession fails", async () => {
    promoteSessionMock.mockRejectedValueOnce(new Error("boom"));
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<PromoteDialog session={makeSession()} project={PROJECT} onClose={onClose} />);

    await screen.findByRole("combobox");
    await user.click(screen.getByText("Create worktree"));

    expect(await screen.findByText(/Failed to create the worktree/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Cancel closes without calling promoteSession or declinePromote (human-initiated, nothing pending)", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<PromoteDialog session={makeSession()} project={PROJECT} onClose={onClose} />);

    await user.click(screen.getByText("Cancel"));

    expect(promoteSessionMock).not.toHaveBeenCalled();
    expect(declinePromoteMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("agent-triggered (pending): shows Decline copy, pre-fills the seed, and prefers the current branch over the agent's suggestion once branches load", async () => {
    render(
      <PromoteDialog
        session={makeSession({
          promoteState: "pending",
          promoteSummary: "start work on the bug fix",
          promoteSuggestedBaseRef: "feature/x",
        })}
        project={PROJECT}
        onClose={vi.fn()}
      />,
    );

    expect(
      await screen.findByText("The agent asked to start work in an isolated worktree."),
    ).toBeInTheDocument();
    expect(screen.getByText("Decline")).toBeInTheDocument();
    expect(screen.getByDisplayValue("start work on the bug fix")).toBeInTheDocument();
    // Production incident this locks in: the suggested base ref used to win
    // even after branches loaded with a different current branch, silently
    // cutting the worktree from the wrong commit. Now the current branch
    // wins once it's known, and the suggestion surfaces as a distinct,
    // user-applied hint instead.
    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    expect(select).toHaveDisplayValue("main (current)");
    expect(screen.getByText("feature/x", { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText("use it")).toBeInTheDocument();
  });

  it("clicking the agent's suggestion applies it and stops the branches load from overriding it again", async () => {
    const user = userEvent.setup();
    render(
      <PromoteDialog
        session={makeSession({
          promoteState: "pending",
          promoteSuggestedBaseRef: "feature/x",
        })}
        project={PROJECT}
        onClose={vi.fn()}
      />,
    );

    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    expect(select).toHaveDisplayValue("main (current)");

    await user.click(screen.getByText("use it"));

    expect(select).toHaveDisplayValue("feature/x");
    expect(screen.queryByText("use it")).not.toBeInTheDocument();
  });

  it("Decline calls declinePromote (not promoteSession) and closes", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <PromoteDialog
        session={makeSession({ promoteState: "pending", promoteSummary: "seed" })}
        project={PROJECT}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByText("Decline"));

    expect(declinePromoteMock).toHaveBeenCalledWith(42);
    expect(promoteSessionMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  // Production incident this covers: git-branches rate-limited (429) while
  // the dialog was open — branches stayed `[]`, the dropdown had zero
  // options, and nothing told the user why. Now a failed fetch renders an
  // inline error and falls back to a free-text field instead of an
  // empty, unselectable dropdown.
  describe("branches fetch fails (rate-limited / host unreachable)", () => {
    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(jsonResponse(429, { error: "slow down" }))),
      );
    });

    it("shows an inline error and a free-text base-ref field instead of an empty dropdown", async () => {
      render(
        <PromoteDialog
          session={makeSession({
            promoteState: "pending",
            promoteSuggestedBaseRef: "feature/x",
          })}
          project={PROJECT}
          onClose={vi.fn()}
        />,
      );

      expect(await screen.findByText(/Couldn't load the branch list/)).toBeInTheDocument();
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
      // The agent's suggestion survives as the fallback value — visible and
      // still overridable, not silently trusted.
      const input = screen.getByPlaceholderText(/e\.g\. main or origin\/main/i) as HTMLInputElement;
      expect(input).toHaveValue("feature/x");
    });

    it("lets the user type a base ref by hand and submits it", async () => {
      const user = userEvent.setup();
      render(<PromoteDialog session={makeSession()} project={PROJECT} onClose={vi.fn()} />);

      const input = await screen.findByPlaceholderText(/e\.g\. main or origin\/main/i);
      await user.clear(input);
      await user.type(input, "hand-typed-ref");
      await user.click(screen.getByText("Create worktree"));

      expect(promoteSessionMock).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ baseRef: "hand-typed-ref" }),
      );
    });
  });

  // PR 24 pilot — behavior newly added by the `ui/Modal.tsx` migration.
  // Everything above this point exercises behavior the hand-rolled dialog
  // already had; these cases exercise ONLY what's new: role/aria-modal,
  // Escape-to-close (routed through `cancel`, so it must respect the
  // pending-decline branch exactly like the header close button and
  // backdrop click already did), and the Tab focus trap.
  describe("ui/Modal.tsx migration (PR 24 pilot)", () => {
    it("exposes role=dialog and aria-modal=true", async () => {
      render(<PromoteDialog session={makeSession()} project={PROJECT} onClose={vi.fn()} />);

      const dialog = await screen.findByRole("dialog", { name: "Promote to worktree" });
      expect(dialog).toHaveAttribute("aria-modal", "true");
    });

    it("Escape closes the dialog exactly like Cancel (human-initiated, nothing pending)", async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(<PromoteDialog session={makeSession()} project={PROJECT} onClose={onClose} />);

      await screen.findByRole("combobox");
      await user.keyboard("{Escape}");

      expect(promoteSessionMock).not.toHaveBeenCalled();
      expect(declinePromoteMock).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });

    it("Escape declines a pending promote request exactly like clicking Decline", async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(
        <PromoteDialog
          session={makeSession({ promoteState: "pending", promoteSummary: "seed" })}
          project={PROJECT}
          onClose={onClose}
        />,
      );

      await screen.findByRole("combobox");
      await user.keyboard("{Escape}");

      expect(declinePromoteMock).toHaveBeenCalledWith(42);
      expect(promoteSessionMock).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });

    it("focuses the first focusable element on open and traps Tab within the dialog", async () => {
      const user = userEvent.setup();
      render(<PromoteDialog session={makeSession()} project={PROJECT} onClose={vi.fn()} />);
      await screen.findByRole("combobox");

      const dialog = screen.getByRole("dialog");
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>("button, select, input, textarea"),
      );
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      // No `initialFocusRef` is passed for this dialog, so `useFocusTrap`
      // falls back to the first focusable descendant — the header's close
      // button, since it precedes the body's Dropdown/input/textarea in DOM
      // order.
      expect(first).toHaveFocus();

      last.focus();
      await user.tab();
      expect(first).toHaveFocus();

      first.focus();
      await user.tab({ shift: true });
      expect(last).toHaveFocus();
    });
  });
});
