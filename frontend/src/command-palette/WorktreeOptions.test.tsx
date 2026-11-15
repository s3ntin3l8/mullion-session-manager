// @vitest-environment jsdom
// <WorktreeOptions> — the launcher's opt-in "isolate this session" toggle
// (issue #271, option 1) and its P9 branches-fetch failure case. Every test
// here mounts the full New session launcher rather than <WorktreeOptions> in
// isolation: the toggle lives in the launcher's Where row, and the launch
// reads worktreeEnabled/worktreeBaseRef (passed down as controlled props) at
// launch time, so a real mount is the only way to exercise that interaction
// end-to-end. (It lived in the command palette until #3054 moved every
// launch to the launcher.)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionLauncherHost } from "../launchers/SessionLauncher.js";
import { useDashboardStore } from "../store/index.js";
import type { Launcher, Project } from "../api/index.js";
import { jsonResponse } from "../test/jsonResponse.js";

const PROJECT: Project = {
  id: 5,
  name: "mullion",
  cwd: "/home/x/mullion",
  hostId: "local",
  placement: "pinned",
  hostCwds: {},
  devServerUrl: null,
  detectedDevServerPort: null,
  currentBranch: null,
  autoFetch: null,
  ruleFiles: [],
  defaultAgent: null,
  defaultReviewAgent: null,
  mergeOnApprove: null,
  autoApprove: null,
  allowCrossProjectSpawn: null,
  maxAutoReturnRounds: null,
  conventionalCommitTitles: null,
  autoTagRelease: null,
  injectAgentGuide: null,
  injectProjectBriefing: null,
  injectWorkflowConventions: null,
  suppressConventionsInjectionAfterScaffold: null,
  conventionsHash: null,
  conventionsDrifted: false,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function renderLauncher() {
  const utils = render(
    <SessionLauncherHost panels={[]} phone={false} onLaunched={vi.fn()} onOpenSession={vi.fn()} />,
  );
  act(() => useDashboardStore.getState().openLauncher({ projectId: PROJECT.id }));
  return utils;
}

// The base-ref picker: every combobox but the Where row's Project.
const baseRefPickers = () =>
  screen.queryAllByRole("combobox").filter((el) => el.getAttribute("aria-label") !== "Project");
const findBaseRefPicker = async () => {
  await vi.waitFor(() => expect(baseRefPickers()).toHaveLength(1));
  return baseRefPickers()[0]!;
};

describe("New session launcher -> worktree isolation toggle", () => {
  const LAUNCHER = { id: "agent:bash", kind: "shell" as const, title: "bash", command: "bash" };

  function mockFetch(opts: {
    branches?: () => Response | Promise<Response>;
    onCreateSession?: (body: unknown) => void;
  }) {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/actions")) return Promise.resolve(jsonResponse(200, [LAUNCHER]));
      if (url.includes("/urls")) return Promise.resolve(jsonResponse(200, []));
      if (url.includes("/git-branches")) {
        return Promise.resolve(
          opts.branches ? opts.branches() : new Response(null, { status: 204 }),
        );
      }
      if (url.endsWith("/api/sessions") && init?.method === "POST") {
        opts.onCreateSession?.(JSON.parse(String(init.body)));
        return Promise.resolve(
          jsonResponse(201, {
            id: 1,
            projectId: PROJECT.id,
            command: "bash",
            cwd: null,
            status: "active",
          }),
        );
      }
      // createSession refreshes the session list afterward (store.ts) — an
      // empty list is fine, this test only cares about the POST body above.
      if (url.startsWith("/api/sessions")) return Promise.resolve(jsonResponse(200, []));
      return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
    });
  }

  beforeEach(() => {
    useDashboardStore.setState({
      projects: [PROJECT],
      sessions: [],
      viewMode: "list",
      launcherRequest: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is off by default and shows no base-ref picker", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    renderLauncher();

    const toggle = await screen.findByLabelText("Isolate in a new worktree");
    expect(toggle).not.toBeChecked();
    expect(baseRefPickers()).toHaveLength(0);
  });

  // Issue #271 follow-up — the repo's resolved default branch wins over the
  // current branch, matching PromoteDialog's own default (both share
  // useGitBranches).
  it("fetches branches and defaults the base-ref picker to the repo's default branch", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        branches: () =>
          Promise.resolve(
            jsonResponse(200, {
              branches: [
                { name: "main", isCurrent: true },
                { name: "feature/x", isCurrent: false },
              ],
              worktrees: [],
              remoteBranches: ["origin/main"],
              defaultBranch: "origin/main",
            }),
          ),
      }),
    );
    const user = userEvent.setup();
    renderLauncher();

    await user.click(await screen.findByLabelText("Isolate in a new worktree"));
    const select = await findBaseRefPicker();
    // Hermes review, PR #695 — WorktreeOptions now tags options the same
    // way PromoteDialog's dropdown already does ("(default)"/"(current)").
    expect(select).toHaveDisplayValue("origin/main (default)");
    expect(screen.getByRole("option", { name: "feature/x" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "main (current)" })).toBeInTheDocument();
  });

  // Hermes review, PR #695 — a `defaultBranch` the backend resolved (it
  // verified against a real commit) can still be absent from the flat
  // `branches` list `listRemoteBranches` returns, e.g. a symbolic-ref
  // target enumeration doesn't happen to include. A native <select> with a
  // `value` outside its own `<option>`s silently displays its first option
  // instead — this must not happen silently.
  it("still selects defaultBranch as the display value even when it's absent from the branches list", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        branches: () =>
          Promise.resolve(
            jsonResponse(200, {
              branches: [{ name: "main", isCurrent: true }],
              worktrees: [],
              remoteBranches: [],
              defaultBranch: "origin/main",
            }),
          ),
      }),
    );
    const user = userEvent.setup();
    renderLauncher();

    await user.click(await screen.findByLabelText("Isolate in a new worktree"));
    const select = await findBaseRefPicker();
    expect(select).toHaveDisplayValue("origin/main (default)");
    expect(screen.getByRole("option", { name: "main (current)" })).toBeInTheDocument();
  });

  // Falls back to the current branch when there's no resolvable default —
  // no remote configured, or an older remote-host agent that predates the
  // `defaultBranch` field (degrades to `undefined`, same as `null` here).
  it("falls back to the current branch when the repo has no resolvable default branch", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        branches: () =>
          Promise.resolve(
            jsonResponse(200, {
              branches: [
                { name: "main", isCurrent: true },
                { name: "feature/x", isCurrent: false },
              ],
              worktrees: [],
              remoteBranches: [],
            }),
          ),
      }),
    );
    const user = userEvent.setup();
    renderLauncher();

    await user.click(await screen.findByLabelText("Isolate in a new worktree"));
    const select = await findBaseRefPicker();
    expect(select).toHaveDisplayValue("main (current)");
    expect(screen.getByRole("option", { name: "feature/x" })).toBeInTheDocument();
  });

  it("passes a worktree intent to session creation when the toggle is on", async () => {
    const onCreateSession = vi.fn();
    vi.stubGlobal(
      "fetch",
      mockFetch({
        branches: () =>
          Promise.resolve(
            jsonResponse(200, {
              branches: [{ name: "main", isCurrent: true }],
              worktrees: [],
              remoteBranches: [],
            }),
          ),
        onCreateSession,
      }),
    );
    const user = userEvent.setup();
    renderLauncher();

    await user.click(await screen.findByLabelText("Isolate in a new worktree"));
    await findBaseRefPicker();
    await user.click((await screen.findAllByText("bash"))[0]);

    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ worktree: { baseRef: "main" } }),
    );
  });

  it("omits the worktree intent when the toggle is off", async () => {
    const onCreateSession = vi.fn();
    vi.stubGlobal("fetch", mockFetch({ onCreateSession }));
    const user = userEvent.setup();
    renderLauncher();

    await user.click((await screen.findAllByText("bash"))[0]);

    expect(onCreateSession).toHaveBeenCalled();
    expect(onCreateSession.mock.calls[0][0]).not.toHaveProperty("worktree");
  });
});

// P9 — CommandPalette.tsx's fetching of git branches for the worktree
// toggle (now inside <WorktreeOptions>, via useGitBranches) used to be a
// `void somePromise.then(...)` with no `.catch` at all: a failure left a
// stale/empty picker plus an unhandled rejection in the console, with
// nothing visible to the user. SessionLauncher.test.tsx's "shows a failed
// launch inline" covers the launch-side half (createSession's failure path).
describe("New session launcher -> WorktreeOptions -> P9 silent failures", () => {
  const LAUNCHER: Launcher = { id: "agent:bash", kind: "shell", title: "bash", command: "bash" };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a failed branches fetch (worktree toggle) surfaces an inline error instead of leaving the picker silently empty forever", async () => {
    useDashboardStore.setState({
      projects: [PROJECT],
      sessions: [],
      viewMode: "list",
      launcherRequest: null,
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/actions")) return Promise.resolve(jsonResponse(200, [LAUNCHER]));
      if (url.includes("/urls")) return Promise.resolve(jsonResponse(200, []));
      if (url.includes("/git-branches")) return Promise.reject(new Error("network down"));
      return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderLauncher();

    await user.click(await screen.findByLabelText("Isolate in a new worktree"));

    expect(await screen.findByText(/network down/i)).toBeInTheDocument();
  });
});
