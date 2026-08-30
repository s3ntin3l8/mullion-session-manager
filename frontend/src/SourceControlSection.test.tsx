// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SourceControlSection } from "./SourceControlSection.js";
import { useDashboardStore } from "./store/index.js";
import { api, LOCAL_HOST_ID } from "./api/index.js";
import type { GitStatus, Project, Session } from "./api/index.js";
import type * as ApiModule from "./api/index.js";

// Uses the real zustand store (seeded via setState), same pattern as
// SavedUrlModal.test.tsx — the component itself writes to the store
// directly (useDashboardStore.setState in handleFetch), so a selector-mock
// would diverge from what's actually being exercised.
vi.mock("./api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      postProjectGitFetch: vi.fn().mockResolvedValue({ success: true }),
      postProjectGitPull: vi.fn().mockResolvedValue({ pulled: true }),
      getProjectGitStatus: vi.fn(),
      getProjectGitFileDiff: vi.fn(),
    },
  };
});

function makeProject(overrides: Partial<Project>): Project {
  return {
    id: 1,
    name: "demo",
    cwd: "/home/x/demo",
    hostId: LOCAL_HOST_ID,
    devServerUrl: null,
    detectedDevServerPort: null,
    currentBranch: null,
    autoFetch: null,
    ruleFiles: [],
    defaultAgent: null,
    defaultReviewAgent: null,
    mergeOnApprove: null,
    autoApprove: null,
    maxAutoReturnRounds: null,
    conventionalCommitTitles: null,
    autoTagRelease: null,
    injectAgentGuide: null,
    injectProjectBriefing: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function statusWith(overrides: Partial<GitStatus>): GitStatus {
  return {
    branch: "main",
    hash: "abc1234",
    ahead: 0,
    behind: 0,
    files: [],
    isClean: true,
    hasConflicts: false,
    ...overrides,
  };
}

const BASE_SESSION_FIELDS = {
  parentSessionId: null,
  command: "claude",
  name: null,
  nameLocked: false,
  cwd: null,
  env: null,
  liveCwd: null,
  previewBranch: null,
  kind: "terminal" as const,
  status: "active" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastAttachedAt: "2026-01-01T00:00:00.000Z",
  alive: true,
  subscriberCount: 1,
  activity: "working" as const,
  lastActivityAt: Date.now(),
  attention: false,
  attentionAt: null,
  lastTitle: null,
  gateState: "idle" as const,
  gates: [],
  gatePrompt: null,
  promoteState: "idle" as const,
  promoteSummary: null,
  promoteSuggestedBaseRef: null,
  permissionState: "idle" as const,
  planState: "idle" as const,
  errorState: "idle" as const,
  endedReason: null,
  liveBranch: null,
  exitCode: null,
  attentionKind: null,
  errorDetail: null,
  lastAssistantMessage: null,
  compactState: "idle" as const,
  subagentCount: 0,
  subagents: [],
  elicitationState: "idle" as const,
  elicitationServer: null,
  lastTurnEndedAt: null,
  stateRestored: true,
  staleHooks: false,
  restoredVersion: null,
  sessionStatus: "idle" as const,
  sessionStatusSeverity: "dormant" as const,
  sessionStatusDetail: null,
  hookEmits: [],
  pendingDevServerPort: null,
  outstandingBackgroundTasks: [],
  sessionStatusAttentionRequired: false,
};

function makeSession(overrides: Partial<Session>): Session {
  return { id: 1, projectId: 1, ...BASE_SESSION_FIELDS, ...overrides };
}

const PROJECT_A = makeProject({ id: 1, name: "project-a" });
const PROJECT_B = makeProject({ id: 2, name: "project-b" });
const PROJECT_C = makeProject({ id: 3, name: "project-c" });
const SESSION_IN_A = makeSession({ id: 10, projectId: PROJECT_A.id });
const SESSION_IN_C = makeSession({ id: 30, projectId: PROJECT_C.id });

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useDashboardStore.setState({
    projects: [],
    sessions: [],
    activePanelId: null,
    gitStatuses: {},
  });
});

describe("SourceControlSection (issue #433 scope B)", () => {
  it("is collapsed by default — header renders, body does not", () => {
    useDashboardStore.setState({
      projects: [PROJECT_A],
      sessions: [],
      activePanelId: null,
      gitStatuses: { [PROJECT_A.id]: statusWith({}) },
    });
    render(<SourceControlSection onOpenGit={vi.fn()} />);

    expect(screen.getByText("Source Control")).toBeTruthy();
    expect(screen.queryByText("Working tree clean")).toBeNull();
  });

  it("renders nothing when there are no projects", () => {
    useDashboardStore.setState({ projects: [], sessions: [], activePanelId: null });
    const { container } = render(<SourceControlSection onOpenGit={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows 'Working tree clean' for a clean project, and the file list for a dirty one", async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({
      projects: [PROJECT_A],
      sessions: [],
      activePanelId: null,
      gitStatuses: {
        [PROJECT_A.id]: statusWith({
          isClean: false,
          files: [{ path: "src/foo.ts", status: "M" }],
        }),
      },
    });
    render(<SourceControlSection onOpenGit={vi.fn()} />);
    await user.click(screen.getByText("Source Control"));

    expect(screen.getByText("src/foo.ts")).toBeTruthy();
    expect(screen.queryByText("Working tree clean")).toBeNull();
  });

  it("clicking a changed file expands its inline diff", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getProjectGitFileDiff).mockResolvedValue({
      patch: "@@ -1 +1 @@\n-old\n+new\n",
    });
    useDashboardStore.setState({
      projects: [PROJECT_A],
      sessions: [],
      activePanelId: null,
      gitStatuses: {
        [PROJECT_A.id]: statusWith({
          isClean: false,
          files: [{ path: "src/foo.ts", status: "M" }],
        }),
      },
    });
    render(<SourceControlSection onOpenGit={vi.fn()} />);
    await user.click(screen.getByText("Source Control"));
    await user.click(screen.getByText("src/foo.ts"));

    await waitFor(() => expect(api.getProjectGitFileDiff).toHaveBeenCalledWith(1, "src/foo.ts"));
    await waitFor(() => expect(screen.getByText("+new")).toBeTruthy());
  });

  it("Fetch calls fetchProjectGit and the direct getProjectGitStatus, not the batch refresh", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getProjectGitStatus).mockResolvedValue(statusWith({ behind: 4 }));
    useDashboardStore.setState({
      projects: [PROJECT_A],
      sessions: [],
      activePanelId: null,
      gitStatuses: { [PROJECT_A.id]: statusWith({}) },
    });
    render(<SourceControlSection onOpenGit={vi.fn()} />);
    await user.click(screen.getByText("Source Control"));
    await user.click(screen.getByText(/Fetch/));

    await waitFor(() => expect(api.postProjectGitFetch).toHaveBeenCalledWith(PROJECT_A.id));
    await waitFor(() =>
      expect(api.getProjectGitStatus).toHaveBeenCalledWith(PROJECT_A.id, { fresh: true }),
    );
    await waitFor(() =>
      expect(useDashboardStore.getState().gitStatuses[PROJECT_A.id]?.behind).toBe(4),
    );
  });

  it("Open Git Panel calls onOpenGit with the current project id", async () => {
    const user = userEvent.setup();
    const onOpenGit = vi.fn();
    useDashboardStore.setState({
      projects: [PROJECT_A],
      sessions: [],
      activePanelId: null,
      gitStatuses: { [PROJECT_A.id]: statusWith({}) },
    });
    render(<SourceControlSection onOpenGit={onOpenGit} />);
    await user.click(screen.getByText("Source Control"));
    await user.click(screen.getByText("Open Git Panel"));

    expect(onOpenGit).toHaveBeenCalledWith(PROJECT_A.id);
  });

  it("sums ahead/behind across all projects for the sticky header total, skipping null entries", () => {
    useDashboardStore.setState({
      projects: [PROJECT_A, PROJECT_B, PROJECT_C],
      sessions: [],
      activePanelId: null,
      gitStatuses: {
        [PROJECT_A.id]: statusWith({ ahead: 1, behind: 2 }),
        [PROJECT_B.id]: statusWith({ ahead: 0, behind: 3 }),
        [PROJECT_C.id]: null,
      },
    });
    render(<SourceControlSection onOpenGit={vi.fn()} />);

    expect(screen.getByText("↑1")).toBeTruthy();
    expect(screen.getByText("↓5")).toBeTruthy();
  });

  it("a pin survives the active panel moving to a different project, and 'Follow active panel' releases it", async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({
      projects: [PROJECT_A, PROJECT_B, PROJECT_C],
      sessions: [SESSION_IN_A, SESSION_IN_C],
      activePanelId: `session-${SESSION_IN_A.id}`,
      gitStatuses: {
        [PROJECT_A.id]: statusWith({ branch: "branch-a" }),
        [PROJECT_B.id]: statusWith({ branch: "branch-b" }),
        [PROJECT_C.id]: statusWith({ branch: "branch-c" }),
      },
    });
    render(<SourceControlSection onOpenGit={vi.fn()} />);
    await user.click(screen.getByText("Source Control"));

    expect(screen.getByText("branch-a")).toBeTruthy();

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await user.selectOptions(select, String(PROJECT_B.id));
    expect(screen.getByText("branch-b")).toBeTruthy();

    act(() => {
      useDashboardStore.setState({ activePanelId: `session-${SESSION_IN_C.id}` });
    });
    expect(screen.getByText("branch-b")).toBeTruthy();

    await user.selectOptions(select, "__follow__");
    expect(screen.getByText("branch-c")).toBeTruthy();
  });

  it("shows a plain 'not a repo' label for a local project, but an honest ambiguous one for a remote-hosted project", async () => {
    const user = userEvent.setup();
    const remoteProject = makeProject({ id: 4, name: "remote-proj", hostId: "some-remote-host" });
    useDashboardStore.setState({
      projects: [remoteProject],
      sessions: [],
      activePanelId: null,
      gitStatuses: { [remoteProject.id]: null },
    });
    render(<SourceControlSection onOpenGit={vi.fn()} />);
    await user.click(screen.getByText("Source Control"));

    expect(screen.getByText("Not a git repository, or the host is unreachable.")).toBeTruthy();
    expect(screen.queryByText("Not a git repository.")).toBeNull();
  });

  it("releases a pinned project id when that project is deleted, falling through to another project", async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({
      projects: [PROJECT_A, PROJECT_B],
      sessions: [],
      activePanelId: null,
      gitStatuses: {
        [PROJECT_A.id]: statusWith({ branch: "branch-a" }),
        [PROJECT_B.id]: statusWith({ branch: "branch-b" }),
      },
    });
    render(<SourceControlSection onOpenGit={vi.fn()} />);
    await user.click(screen.getByText("Source Control"));

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await user.selectOptions(select, String(PROJECT_B.id));
    expect(screen.getByText("branch-b")).toBeTruthy();

    // The pinned project disappears from the store — e.g. deleted.
    act(() => {
      useDashboardStore.setState({ projects: [PROJECT_A] });
    });

    expect(screen.getByText("branch-a")).toBeTruthy();
    expect(screen.queryByText("branch-b")).toBeNull();
  });

  it("disables the Pull button when behind is 0", async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({
      projects: [PROJECT_A],
      sessions: [],
      activePanelId: null,
      gitStatuses: { [PROJECT_A.id]: statusWith({ behind: 0 }) },
    });
    render(<SourceControlSection onOpenGit={vi.fn()} />);
    await user.click(screen.getByText("Source Control"));

    const pullButton = screen.getByRole("button", { name: /Pull/ });
    expect(pullButton).toBeDisabled();
  });

  it("enables the Pull button when behind > 0 and calls postProjectGitPull on click", async () => {
    const user = userEvent.setup();
    vi.mocked(api.postProjectGitPull).mockResolvedValue({ pulled: true });
    vi.mocked(api.getProjectGitStatus).mockResolvedValue(statusWith({ behind: 0 }));

    useDashboardStore.setState({
      projects: [PROJECT_A],
      sessions: [],
      activePanelId: null,
      gitStatuses: { [PROJECT_A.id]: statusWith({ behind: 3 }) },
    });
    render(<SourceControlSection onOpenGit={vi.fn()} />);
    await user.click(screen.getByText("Source Control"));

    const pullButton = screen.getByRole("button", { name: /Pull/ });
    expect(pullButton).not.toBeDisabled();

    await user.click(pullButton);
    await waitFor(() => expect(api.postProjectGitPull).toHaveBeenCalledWith(PROJECT_A.id));
    await waitFor(() =>
      expect(api.getProjectGitStatus).toHaveBeenCalledWith(PROJECT_A.id, { fresh: true }),
    );
  });

  it("renders pull error when pull returns a refusal reason", async () => {
    const user = userEvent.setup();
    vi.mocked(api.postProjectGitPull).mockResolvedValue({
      pulled: false,
      reason: "not-fast-forward",
      detail: "Branch has diverged from upstream",
    });

    useDashboardStore.setState({
      projects: [PROJECT_A],
      sessions: [],
      activePanelId: null,
      gitStatuses: { [PROJECT_A.id]: statusWith({ behind: 1 }) },
    });
    render(<SourceControlSection onOpenGit={vi.fn()} />);
    await user.click(screen.getByText("Source Control"));

    const pullButton = screen.getByRole("button", { name: /Pull/ });
    await user.click(pullButton);

    expect(
      await screen.findByText("Branch has diverged from upstream (cannot fast-forward)."),
    ).toBeTruthy();
  });
});
