// @vitest-environment jsdom
// <WorktreeOptions> — the launcher's opt-in "isolate this session" toggle
// (issue #271, option 1) and its P9 branches-fetch failure case. Split out
// of the former monolithic CommandPalette.test.tsx (PR 29, Wave 5 of
// .claude/plans/can-we-do-a-warm-cocke.md) — every test here mounts the
// full <CommandPalette> rather than <WorktreeOptions> in isolation, matching
// this codebase's existing split-test-file precedent (see
// session-row/GitLine.test.tsx): the toggle checkbox lives in
// CommandPalette's own target strip, and CommandPalette's `launch()` reads
// worktreeEnabled/worktreeBaseRef (passed down as controlled props) at
// launch time, so a real mount is the only way to exercise that interaction
// end-to-end.
import type { ComponentProps } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "../CommandPalette.js";
import { useDashboardStore } from "../store/index.js";
import type { Launcher, Project } from "../api/index.js";
import { jsonResponse } from "../test/jsonResponse.js";

const PROJECT: Project = {
  id: 5,
  name: "mullion",
  cwd: "/home/x/mullion",
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

describe("CommandPalette -> worktree isolation toggle", () => {
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
    useDashboardStore.setState({ projects: [PROJECT], sessions: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is off by default and shows no base-ref picker", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onLaunched={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenGit={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenIntegrationsSettings={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    const toggle = await screen.findByLabelText("Isolate in a new worktree");
    expect(toggle).not.toBeChecked();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("fetches branches and shows a base-ref picker once switched on", async () => {
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
            }),
          ),
      }),
    );
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onLaunched={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenGit={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenIntegrationsSettings={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await user.click(await screen.findByLabelText("Isolate in a new worktree"));
    const select = await screen.findByRole("combobox");
    expect(select).toHaveDisplayValue("main");
    expect(screen.getByRole("option", { name: "feature/x" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "origin/main" })).toBeInTheDocument();
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
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onLaunched={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenGit={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenIntegrationsSettings={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await user.click(await screen.findByLabelText("Isolate in a new worktree"));
    await screen.findByRole("combobox");
    await user.click((await screen.findAllByText("bash"))[0]);

    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ worktree: { baseRef: "main" } }),
    );
  });

  it("omits the worktree intent when the toggle is off", async () => {
    const onCreateSession = vi.fn();
    vi.stubGlobal("fetch", mockFetch({ onCreateSession }));
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onLaunched={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenGit={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenIntegrationsSettings={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await user.click((await screen.findAllByText("bash"))[0]);

    expect(onCreateSession).toHaveBeenCalled();
    expect(onCreateSession.mock.calls[0][0]).not.toHaveProperty("worktree");
  });
});

// P9 — CommandPalette.tsx's fetching of git branches for the worktree
// toggle (now inside <WorktreeOptions>, via useGitBranches) used to be a
// `void somePromise.then(...)` with no `.catch` at all: a failure left a
// stale/empty picker plus an unhandled rejection in the console, with
// nothing visible to the user. See CommandPalette.test.tsx's own "P9 silent
// failures" describe for the launch-side half of this fix (createSession's
// failure path) — that one stayed there since it doesn't touch
// <WorktreeOptions> at all.
describe("CommandPalette -> WorktreeOptions -> P9 silent failures", () => {
  const LAUNCHER: Launcher = { id: "agent:bash", kind: "shell", title: "bash", command: "bash" };

  function renderPalette(overrides: Partial<ComponentProps<typeof CommandPalette>> = {}) {
    return render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onLaunched={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenGit={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenIntegrationsSettings={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
        {...overrides}
      />,
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a failed branches fetch (worktree toggle) surfaces an inline error instead of leaving the picker silently empty forever", async () => {
    useDashboardStore.setState({ projects: [PROJECT], sessions: [] });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/actions")) return Promise.resolve(jsonResponse(200, [LAUNCHER]));
      if (url.includes("/urls")) return Promise.resolve(jsonResponse(200, []));
      if (url.includes("/git-branches")) return Promise.reject(new Error("network down"));
      return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPalette();

    await user.click(await screen.findByLabelText("Isolate in a new worktree"));

    expect(await screen.findByText(/network down/i)).toBeInTheDocument();
  });
});
