// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PromoteDialog } from "./PromoteDialog.js";
import type { Project, Session } from "./api.js";

// Issue #271 — PromoteDialog reads two store actions directly; everything
// else it needs (project/session/onClose) comes via props.
const promoteSessionMock = vi.fn();
const declinePromoteMock = vi.fn();
vi.mock("./store.js", () => ({
  useDashboardStore: (selector: (s: unknown) => unknown) =>
    selector({ promoteSession: promoteSessionMock, declinePromote: declinePromoteMock }),
}));

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PROJECT: Project = {
  id: 1,
  name: "demo",
  cwd: "/home/x/demo",
  hostId: "local",
  devServerUrl: null,
  detectedDevServerPort: null,
  currentBranch: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 42,
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
    attention: false,
    attentionAt: null,
    lastTitle: null,
    gateState: "idle",
    gatePrompt: null,
    promoteState: "idle",
    promoteSummary: null,
    promoteSuggestedBaseRef: null,
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

  it("agent-triggered (pending): shows Decline copy, pre-fills the seed and suggested base ref", async () => {
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
    // The suggested base ref wins even after branches load with a
    // different "current" branch — the model's own signal is authoritative
    // until the human changes it.
    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    expect(select).toHaveDisplayValue("feature/x");
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
});
