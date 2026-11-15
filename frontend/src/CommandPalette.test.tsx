// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ComponentProps } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "./CommandPalette.js";
import { useDashboardStore } from "./store/index.js";
import { DEFAULT_SETTINGS, api } from "./api/index.js";
import type { Launcher, Project, Session } from "./api/index.js";
import { jsonResponse } from "./test/jsonResponse.js";
import { makeSession, makeWorkspace } from "./test/fixtures.js";
import { ACTIVE_TERMINAL_FOCUS_SELECTOR, WORKSPACE_FOCUS_FALLBACK } from "./paletteFocusTargets.js";

// Issue #27: the palette's "Integrations" section — a GitHub-panel shortcut
// for the current project plus a link into Settings -> Integrations.

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

describe("CommandPalette -> Integrations section", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, []))),
    );
    useDashboardStore.setState({ projects: [PROJECT], sessions: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the GitHub panel for the current project", async () => {
    const onOpenGitHub = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={onOpenGitHub}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await user.click(await screen.findByText(/^GitHub$/));
    expect(onOpenGitHub).toHaveBeenCalledWith(PROJECT.id);
    expect(screen.queryByText("Git", { exact: true })).toBeNull();
  });

  it("opens the agent-rules editor for the current project (issue #431)", async () => {
    const onOpenAgentRules = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={onOpenAgentRules}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    // These setup entries live under the "Project ›" drill-in now.
    await user.click(await screen.findByText(/Project: mullion/));
    await user.click(await screen.findByText("Agent Rules"));
    expect(onOpenAgentRules).toHaveBeenCalledWith(PROJECT.id);
  });

  it("opens the project file editor for the current project", async () => {
    const onOpenFileEditor = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={onOpenFileEditor}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    // These setup entries live under the "Project ›" drill-in now.
    await user.click(await screen.findByText(/Project: mullion/));
    await user.click(await screen.findByText("Edit project files"));
    expect(onOpenFileEditor).toHaveBeenCalledWith(PROJECT.id);
  });

  it("opens the dock-config editor for the current project (U4)", async () => {
    const onOpenDockConfig = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={onOpenDockConfig}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    // These setup entries live under the "Project ›" drill-in now.
    await user.click(await screen.findByText(/Project: mullion/));
    await user.click(await screen.findByText("Dock"));
    expect(onOpenDockConfig).toHaveBeenCalledWith(PROJECT.id);
  });

  it("opens the skills panel for the current project (issue #432)", async () => {
    const onOpenSkills = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={onOpenSkills}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    // These setup entries live under the "Project ›" drill-in now.
    await user.click(await screen.findByText(/Project: mullion/));
    await user.click(await screen.findByText("Skills"));
    expect(onOpenSkills).toHaveBeenCalledWith(PROJECT.id);
  });

  it("opens the browser preview panel for the current project", async () => {
    const onOpenBrowser = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={onOpenBrowser}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await user.type(await screen.findByPlaceholderText(/Run a command/), "preview");
    await user.click(await screen.findByText(/^Preview$/));
    expect(onOpenBrowser).toHaveBeenCalledWith(PROJECT.id);
  });

  it("opens a blank browser tab, project-independent (issue #28's general-purpose browser tile)", async () => {
    const onOpenBlankBrowser = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="global"
        projectId={null}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={onOpenBlankBrowser}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await user.type(await screen.findByPlaceholderText(/Run a command/), "new preview tab");
    await user.click(await screen.findByText("New preview tab"));
    expect(onOpenBlankBrowser).toHaveBeenCalled();
  });

  it("finds and opens GitHub settings through search", async () => {
    const onOpenSettingsSection = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={onOpenSettingsSection}
        onOpenBrowserUrl={vi.fn()}
        onOpenTasks={vi.fn()}
      />,
    );

    await user.type(await screen.findByPlaceholderText(/Run a command/), "github settings");
    await user.click(await screen.findByText("GitHub settings"));
    expect(onOpenSettingsSection).toHaveBeenCalledWith("github");
  });

  // Issue #1434 — the palette used to claim it had a Tasks entry (its own
  // and App.tsx's comments said so) without actually having one.
  it("opens the task board and closes the palette, regardless of project scope", async () => {
    const onOpenTasks = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="global"
        projectId={null}
        onClose={onClose}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
        onOpenTasks={onOpenTasks}
      />,
    );

    await user.click(await screen.findByText("Task board"));
    expect(onOpenTasks).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("hides the Task board and Integrations rows while mid-search", async () => {
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await screen.findByText("Task board");
    expect(screen.getByText("Task board")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/Run a command/), "bash");
    expect(screen.queryByText("GitHub settings")).not.toBeInTheDocument();
    expect(screen.queryByText("Task board")).not.toBeInTheDocument();
  });
});

// #3054 — the palette starts no session itself. "New session…" opens the
// New session launcher on the palette's project; an agent, shell or script
// found by a typed query opens it with that entry preselected. The launcher
// starts the session (and owns a failed launch's inline error,
// SessionLauncher.test.tsx).
describe("CommandPalette -> entries open the launcher (#3054)", () => {
  const CLAUDE: Launcher = {
    id: "agent:claude",
    kind: "agent",
    title: "claude",
    command: "claude",
  };
  const BASH: Launcher = { id: "shell:bash", kind: "shell", title: "bash", command: "bash" };

  function renderPalette(overrides: Partial<ComponentProps<typeof CommandPalette>> = {}) {
    return render(
      <CommandPalette
        scope="global"
        projectId={null}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
        {...overrides}
      />,
    );
  }

  let posts = 0;
  beforeEach(() => {
    posts = 0;
    useDashboardStore.setState({
      projects: [PROJECT],
      sessions: [],
      settings: DEFAULT_SETTINGS,
      launcherRequest: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/actions")) return Promise.resolve(jsonResponse(200, [CLAUDE, BASH]));
        if (url.includes("/urls")) return Promise.resolve(jsonResponse(200, []));
        if (url.endsWith("/api/sessions") && init?.method === "POST") posts += 1;
        return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const SEARCH = "Run a command, or find a session or agent…";

  // #3069 — the blank view offers the one command and lists no agent, shell
  // or script.
  it("lists no agent, shell or script on a blank query, only New session… under Commands", async () => {
    const user = userEvent.setup();
    renderPalette();

    // Typing proves the launchers have loaded; clearing returns to the
    // blank view with them in hand.
    await user.type(await screen.findByPlaceholderText(SEARCH), "bash");
    await screen.findByRole("button", { name: /bash/ });
    await user.clear(screen.getByPlaceholderText(SEARCH));

    const row = screen.getByRole("button", { name: /New session…/ });
    expect(row).toHaveTextContent("Choose an agent, shell or script");
    expect(screen.getByText("Commands")).toBeInTheDocument();
    expect(screen.queryByText("New session")).toBeNull();
    expect(screen.queryByRole("button", { name: /bash/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /claude/ })).toBeNull();
    expect(screen.queryByText("Loading agents, shells and scripts…")).toBeNull();
    expect(screen.queryByText("No matching agents, shells or scripts.")).toBeNull();
  });

  it("highlights New session… on open, so Enter opens the launcher on the project with no entry preselected", async () => {
    const onClose = vi.fn();
    const onOpenGitHub = vi.fn();
    const user = userEvent.setup();
    renderPalette({ onClose, onOpenGitHub });

    const row = await screen.findByRole("button", { name: /New session…/ });
    expect(row).toHaveClass("selected");
    expect(document.querySelector(".cmd-palette-footer")?.textContent).toContain(
      "Run New session…",
    );
    await user.keyboard("{Enter}");

    expect(useDashboardStore.getState().launcherRequest?.target).toEqual({
      projectId: PROJECT.id,
    });
    expect(onOpenGitHub).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(posts).toBe(0);
  });

  it("a clicked New session… opens the launcher on the project, and creates no session", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderPalette({ onClose });

    await user.click(await screen.findByRole("button", { name: /New session…/ }));

    expect(useDashboardStore.getState().launcherRequest?.target).toEqual({
      projectId: PROJECT.id,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(posts).toBe(0);
  });

  it("New session… opens the launcher with no target when there is no project", async () => {
    useDashboardStore.setState({ projects: [] });
    const user = userEvent.setup();
    renderPalette();

    await user.click(await screen.findByRole("button", { name: /New session…/ }));

    expect(useDashboardStore.getState().launcherRequest).toMatchObject({ target: null });
    expect(posts).toBe(0);
  });

  it("a typed shell, clicked, opens the launcher on it and the project, and creates no session", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderPalette({ onClose });

    await user.type(await screen.findByPlaceholderText(SEARCH), "bash");
    await user.click(await screen.findByRole("button", { name: /bash/ }));

    expect(useDashboardStore.getState().launcherRequest?.target).toEqual({
      projectId: PROJECT.id,
      launcherId: "shell:bash",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(posts).toBe(0);
  });

  it("a typed agent name lists the agent under New session, and Enter opens the launcher on that agent", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderPalette({ onClose });

    await user.type(await screen.findByPlaceholderText(SEARCH), "claude");

    const claude = await screen.findByRole("button", { name: /claude/ });
    expect(screen.getByText("New session")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /bash/ })).toBeNull();
    // The matching agent is the first result, so it is the selection.
    await waitFor(() => expect(claude).toHaveClass("selected"));
    expect(document.querySelector(".cmd-palette-footer")?.textContent).toMatch(
      /New session in mullion…/,
    );
    await user.keyboard("{Enter}");

    expect(useDashboardStore.getState().launcherRequest?.target).toEqual({
      projectId: PROJECT.id,
      launcherId: "agent:claude",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(posts).toBe(0);
  });

  function holdActions() {
    const held: { release: (() => void) | null } = { release: null };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/actions")) {
          return new Promise<Response>((resolve) => {
            held.release = () => resolve(jsonResponse(200, [CLAUDE, BASH]));
          });
        }
        if (url.includes("/urls")) return Promise.resolve(jsonResponse(200, []));
        return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
      }),
    );
    return held;
  }

  it("says, under a typed query only, that the list is loading until the project's agents, shells and scripts arrive", async () => {
    const held = holdActions();
    const user = userEvent.setup();
    renderPalette();

    // The blank view has nothing to wait for.
    await screen.findByRole("button", { name: /New session…/ });
    await waitFor(() => expect(held.release).not.toBeNull());
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("New session")).toBeNull();

    await user.type(screen.getByPlaceholderText(SEARCH), "bash");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Loading agents, shells and scripts…",
    );
    expect(screen.getByText("New session")).toBeInTheDocument();

    held.release!();
    await screen.findByRole("button", { name: /bash/ });
    expect(screen.queryByText("Loading agents, shells and scripts…")).toBeNull();
    expect(screen.getByText("New session")).toBeInTheDocument();
  });

  it("moves the selection back to the first result when the list arrives under a typed query", async () => {
    const held = holdActions();
    const user = userEvent.setup();
    renderPalette();

    await waitFor(() => expect(held.release).not.toBeNull());
    // "s" finds several commands while the launchers are still loading.
    await user.type(screen.getByPlaceholderText(SEARCH), "s");
    await user.keyboard("{ArrowDown}");
    const rows = () => Array.from(document.querySelectorAll<HTMLElement>(".cmd-row"));
    expect(rows().length).toBeGreaterThan(1);
    expect(rows()[1]).toHaveClass("selected");

    held.release!();
    // "s" matches bash, which leads the list once it arrives.
    const bash = await screen.findByRole("button", { name: /bash/ });
    await waitFor(() => expect(bash).toHaveClass("selected"));
    expect(rows()[0]).toBe(bash);
  });

  it("starts no session itself: no launch options, and a query nothing matches names what is missing", async () => {
    const user = userEvent.setup();
    renderPalette();

    await screen.findByRole("button", { name: /New session…/ });
    expect(screen.getByPlaceholderText(SEARCH)).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Model for this session" })).toBeNull();
    expect(screen.queryByText(/Skip permissions/)).toBeNull();
    expect(screen.queryByText(/Isolate in a new worktree/)).toBeNull();
    expect(screen.queryByText(/Launch in/)).toBeNull();
    await user.type(screen.getByPlaceholderText(SEARCH), "zzzz-nothing");
    expect(await screen.findByText("No matching agents, shells or scripts.")).toBeInTheDocument();
    expect(screen.queryByText("New session")).toBeNull();
  });
});

// P11 — the palette previously had no dialog semantics, no focus-in on
// open, and no Tab trap, all of which UnifiedBoard.tsx's task-detail drawer
// already had. Uses the shared useFocusTrap.ts hook.
describe("CommandPalette -> focus management (P11)", () => {
  const LAUNCHER: Launcher = { id: "agent:bash", kind: "shell", title: "bash", command: "bash" };

  function renderPalette(overrides: Partial<ComponentProps<typeof CommandPalette>> = {}) {
    return render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
        {...overrides}
      />,
    );
  }

  beforeEach(() => {
    useDashboardStore.setState({ projects: [PROJECT], sessions: [] });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/actions")) return Promise.resolve(jsonResponse(200, [LAUNCHER]));
      if (url.includes("/urls")) return Promise.resolve(jsonResponse(200, []));
      return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has dialog semantics and focuses the search input on open", async () => {
    renderPalette();
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByPlaceholderText("Run a command, or find a session or agent…")).toHaveFocus();
  });

  // Mobile/tablet touch fix — autofocusing the search input on open used to
  // raise the on-screen keyboard immediately, covering the command list a
  // touch user opened this to read. Same matchMedia-stub pattern as
  // Dock.test.tsx's own coarse-pointer test.
  function stubCoarsePointer() {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(pointer: coarse)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  }

  it("focuses the dialog itself, not the search input, on open under a coarse pointer", async () => {
    stubCoarsePointer();
    renderPalette();
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });

    expect(dialog).toHaveFocus();
    expect(
      screen.getByPlaceholderText("Run a command, or find a session or agent…"),
    ).not.toHaveFocus();
  });

  it("tapping the search box directly still raises the keyboard under a coarse pointer", async () => {
    const user = userEvent.setup();
    stubCoarsePointer();
    renderPalette();
    await screen.findByRole("dialog", { name: "Command palette" });
    const input = screen.getByPlaceholderText("Run a command, or find a session or agent…");

    // This fix only changes what grabs focus on open — tapping the input is
    // still a normal click, exercised through userEvent (not a bare
    // `.focus()` call, which would only prove jsdom's own focus mechanics
    // work) so this also proves the redirect below didn't somehow eat clicks
    // on the input itself.
    await user.click(input);

    expect(input).toHaveFocus();
  });

  // Independent code review — `(pointer: coarse)` also covers hardware-
  // keyboard-equipped touch devices (a touchscreen laptop, a tablet with an
  // attached keyboard — layoutTier.ts's own comment). Without a redirect,
  // typing on those would go nowhere until the user manually tapped the
  // input first, since typing/arrow-nav/Enter only ever reached the palette
  // through the input's own onKeyDown.
  it("redirects focus to the search input on the first keystroke under a coarse pointer", async () => {
    const user = userEvent.setup();
    stubCoarsePointer();
    renderPalette();
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    expect(dialog).toHaveFocus();

    await user.keyboard("b");

    expect(screen.getByPlaceholderText("Run a command, or find a session or agent…")).toHaveFocus();
  });

  it("does not redirect focus to the search input on Escape (the dialog's own close key)", async () => {
    const user = userEvent.setup();
    stubCoarsePointer();
    renderPalette();
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    expect(dialog).toHaveFocus();

    await user.keyboard("{Escape}");

    expect(
      screen.getByPlaceholderText("Run a command, or find a session or agent…"),
    ).not.toHaveFocus();
  });

  // Independent code review — without the container-anchor branch
  // useFocusTrap.ts now has, Shift+Tab from a `tabIndex={-1}` container
  // (neither `first` nor `last` per getFocusable's own selector) fell
  // through to the browser's native default and escaped the dialog
  // entirely, landing on whatever precedes it in the WHOLE document.
  it("wraps Shift+Tab from the dialog anchor within the dialog, not out to the page", async () => {
    const user = userEvent.setup();
    stubCoarsePointer();
    renderPalette();
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    expect(dialog).toHaveFocus();

    await user.tab({ shift: true });

    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("restores focus to the trigger element on a plain close (Escape)", async () => {
    render(<button>open palette</button>);
    const trigger = screen.getByText("open palette");
    trigger.focus();

    const { unmount } = renderPalette();
    await screen.findByPlaceholderText("Run a command, or find a session or agent…");
    expect(document.activeElement).not.toBe(trigger);

    // Mirrors App.tsx's conditional mount — closing is a full unmount.
    unmount();
    expect(trigger).toHaveFocus();
  });

  // #3054 — an entry opens the launcher rather than launching. The
  // palette's own restore runs, so the launcher (opening in the same commit)
  // records the palette's opener as its own, and closing the launcher
  // returns focus there rather than to <body>.
  it("restores focus to the trigger when New session… hands over to the launcher", async () => {
    render(<button>open palette</button>);
    const trigger = screen.getByText("open palette");
    trigger.focus();
    useDashboardStore.setState({ launcherRequest: null });

    const onClose = vi.fn();
    const user = userEvent.setup();
    const { unmount } = renderPalette({ onClose });

    await user.click(await screen.findByRole("button", { name: /New session…/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useDashboardStore.getState().launcherRequest?.target).toEqual({
      projectId: PROJECT.id,
    });

    // App.tsx's real close path is a conditional-mount flip.
    unmount();

    expect(trigger).toHaveFocus();
  });

  it("restores focus to the trigger when a typed entry hands over to the launcher", async () => {
    render(<button>open palette</button>);
    const trigger = screen.getByText("open palette");
    trigger.focus();

    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/actions")) return Promise.resolve(jsonResponse(200, [LAUNCHER]));
        if (url.includes("/urls")) return Promise.resolve(jsonResponse(200, []));
        return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
      }),
    );

    const onClose = vi.fn();
    const user = userEvent.setup();
    const { unmount } = renderPalette({ onClose });

    await user.type(
      await screen.findByPlaceholderText("Run a command, or find a session or agent…"),
      "bash",
    );
    await user.click(await screen.findByRole("button", { name: /bash/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useDashboardStore.getState().launcherRequest?.target?.launcherId).toBe("agent:bash");

    // App.tsx's real close path is a conditional-mount flip.
    unmount();

    expect(trigger).toHaveFocus();
  });

  // Issue #1884 — suppressRestore used to run for every action, including
  // ones that never move focus. A workspace switch then left focus on
  // <body>. When the opener isn't inside the grid being replaced, the
  // trap's normal restore is the right place to land.
  it("restores focus to the trigger after a workspace switch, when that trigger survives", async () => {
    render(<button>open palette</button>);
    const trigger = screen.getByText("open palette");
    trigger.focus();

    useDashboardStore.setState({
      workspaces: [makeWorkspace({ id: 9, name: "Release train" })],
      activeWorkspaceId: null,
    });
    const user = userEvent.setup();
    const { unmount } = renderPalette();
    await screen.findByPlaceholderText("Run a command, or find a session or agent…");
    await user.type(screen.getByPlaceholderText(/Run a command/), "release");
    await user.keyboard("{Enter}");

    unmount();
    expect(trigger).toHaveFocus();
    expect(useDashboardStore.getState().activeWorkspaceId).toBe(9);
  });

  it("restores focus to the trigger after clicking a workspace result", async () => {
    render(<button>open palette</button>);
    const trigger = screen.getByText("open palette");
    trigger.focus();

    useDashboardStore.setState({
      workspaces: [makeWorkspace({ id: 4, name: "clickable workspace" })],
      activeWorkspaceId: null,
    });
    const user = userEvent.setup();
    const { unmount } = renderPalette();
    await screen.findByPlaceholderText("Run a command, or find a session or agent…");
    await user.type(screen.getByPlaceholderText(/Run a command/), "clickable");
    await user.click(await screen.findByText("clickable workspace"));

    unmount();
    expect(trigger).toHaveFocus();
  });

  // The opener is a terminal inside the grid this switch is about to clear.
  // Restoring to it would land on <body> once that node unmounts, so focus
  // moves to the new workspace's active pane, or the sidebar row that marks
  // it, instead. The DOM is built from the same selector the palette queries
  // — a renamed constant fails this file's import, not a still-green string.
  function mountFromSelector(selector: string): HTMLElement {
    const parts = selector.trim().split(/\s+/);
    let root: HTMLElement | null = null;
    let parent: HTMLElement | null = null;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isLast = i === parts.length - 1;
      const el = document.createElement(isLast && part.includes("textarea") ? "textarea" : "div");
      for (const match of part.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
        el.classList.add(match[1]!);
      }
      if (root === null) root = el;
      else parent!.appendChild(el);
      parent = el;
    }
    if (!root) throw new Error(`empty selector: ${selector}`);
    return root;
  }

  function workspaceFallbackRow(label: string): HTMLElement {
    const row = document.createElement("div");
    row.dataset.focusFallback = WORKSPACE_FOCUS_FALLBACK;
    row.tabIndex = 0;
    row.textContent = label;
    return row;
  }

  it("moves focus to the new workspace's pane, not a trigger inside the grid", async () => {
    const terminal = mountFromSelector(ACTIVE_TERMINAL_FOCUS_SELECTOR);
    const pane = terminal.querySelector("textarea") as HTMLTextAreaElement;
    pane.setAttribute("aria-label", "new pane");
    const trigger = document.createElement("button");
    trigger.textContent = "old terminal";
    pane.parentElement!.insertBefore(trigger, pane);
    const row = workspaceFallbackRow("sidebar workspace");
    const host = document.createElement("div");
    host.append(terminal, row);
    document.body.append(host);
    try {
      trigger.focus();

      useDashboardStore.setState({
        workspaces: [makeWorkspace({ id: 9, name: "Release train" })],
        activeWorkspaceId: null,
      });
      const user = userEvent.setup();
      const { unmount } = renderPalette();
      await screen.findByPlaceholderText("Run a command, or find a session or agent…");
      await user.type(screen.getByPlaceholderText(/Run a command/), "release");
      await user.click(await screen.findByText("Release train"));

      await vi.waitFor(() => expect(pane).toHaveFocus());
      unmount();
      expect(trigger).not.toHaveFocus();
      expect(pane).toHaveFocus();
    } finally {
      host.remove();
    }
  });

  it("moves focus to the active workspace row when the grid has no pane to take it", async () => {
    const gridClass = ACTIVE_TERMINAL_FOCUS_SELECTOR.split(/\s+/)[0]!.replace(/^\./, "");
    const grid = document.createElement("div");
    grid.className = gridClass;
    const trigger = document.createElement("button");
    trigger.textContent = "old terminal";
    grid.append(trigger);
    const row = workspaceFallbackRow("sidebar workspace");
    const host = document.createElement("div");
    host.append(grid, row);
    document.body.append(host);
    try {
      trigger.focus();

      useDashboardStore.setState({
        workspaces: [makeWorkspace({ id: 9, name: "Release train" })],
        activeWorkspaceId: null,
      });
      const user = userEvent.setup();
      renderPalette();
      await screen.findByPlaceholderText("Run a command, or find a session or agent…");
      await user.type(screen.getByPlaceholderText(/Run a command/), "release");
      await user.click(await screen.findByText("Release train"));

      await vi.waitFor(() => expect(row).toHaveFocus());
    } finally {
      host.remove();
    }
  });

  // handleSelectWorkspace's setSidebarOpen(false) unmounts a mobile opener
  // that was outside the grid, so the dockview prediction says it survives.
  // The disconnect lands in the commit after the click; the deferred tick
  // has to notice and aim at the row instead of leaving focus on <body>.
  it("moves focus to the workspace row when the switch disconnects an opener outside the grid", async () => {
    const opener = document.createElement("button");
    opener.textContent = "mobile opener";
    const row = workspaceFallbackRow("sidebar workspace");
    document.body.append(opener, row);
    try {
      opener.focus();

      useDashboardStore.setState({
        workspaces: [makeWorkspace({ id: 9, name: "Release train" })],
        activeWorkspaceId: null,
      });
      let unmountPalette: () => void = () => {};
      const user = userEvent.setup();
      const view = renderPalette({
        onShowWorkspace: () => {
          // After this handler returns, same as React committing
          // setSidebarOpen(false) — not synchronously, or the survival
          // check would already see a disconnected node.
          queueMicrotask(() => opener.remove());
        },
        onClose: () => {
          queueMicrotask(() => unmountPalette());
        },
      });
      unmountPalette = view.unmount;
      await screen.findByPlaceholderText("Run a command, or find a session or agent…");
      await user.type(screen.getByPlaceholderText(/Run a command/), "release");
      await user.click(await screen.findByText("Release train"));

      await vi.waitFor(() => expect(row).toHaveFocus());
    } finally {
      row.remove();
      opener.remove();
    }
  });

  it("skips a visibility:hidden workspace row and lands on a shown one", async () => {
    const gridClass = ACTIVE_TERMINAL_FOCUS_SELECTOR.split(/\s+/)[0]!.replace(/^\./, "");
    const grid = document.createElement("div");
    grid.className = gridClass;
    const trigger = document.createElement("button");
    trigger.textContent = "old terminal";
    grid.append(trigger);
    const hidden = workspaceFallbackRow("hidden workspace");
    hidden.style.visibility = "hidden";
    const shown = workspaceFallbackRow("shown workspace");
    const host = document.createElement("div");
    host.append(grid, hidden, shown);
    document.body.append(host);
    try {
      trigger.focus();

      useDashboardStore.setState({
        workspaces: [makeWorkspace({ id: 9, name: "Release train" })],
        activeWorkspaceId: null,
      });
      const user = userEvent.setup();
      renderPalette();
      await screen.findByPlaceholderText("Run a command, or find a session or agent…");
      await user.type(screen.getByPlaceholderText(/Run a command/), "release");
      await user.click(await screen.findByText("Release train"));

      await vi.waitFor(() => expect(shown).toHaveFocus());
      expect(hidden).not.toHaveFocus();
    } finally {
      host.remove();
    }
  });

  it("restores focus after opening the task board, which does not move focus itself", async () => {
    render(<button>open palette</button>);
    const trigger = screen.getByText("open palette");
    trigger.focus();

    const user = userEvent.setup();
    const { unmount } = renderPalette();
    await user.click(await screen.findByText("Task board"));

    unmount();
    expect(trigger).toHaveFocus();
  });

  it("restores focus after opening a panel that does not take focus (GitHub)", async () => {
    render(<button>open palette</button>);
    const trigger = screen.getByText("open palette");
    trigger.focus();

    const user = userEvent.setup();
    const { unmount } = renderPalette();
    await user.click(await screen.findByText("GitHub"));

    unmount();
    expect(trigger).toHaveFocus();
  });

  it("does NOT restore focus when opening Settings, which focuses itself", async () => {
    render(<button>open palette</button>);
    const trigger = screen.getByText("open palette");
    trigger.focus();

    const user = userEvent.setup();
    const { unmount } = renderPalette();
    await user.type(await screen.findByPlaceholderText(/Run a command/), "github settings");
    await user.click(await screen.findByText("GitHub settings"));

    unmount();
    expect(trigger).not.toHaveFocus();
  });

  it("does NOT restore focus when opening a blank preview, which focuses its address bar", async () => {
    render(<button>open palette</button>);
    const trigger = screen.getByText("open palette");
    trigger.focus();

    const user = userEvent.setup();
    const { unmount } = renderPalette();
    await user.type(await screen.findByPlaceholderText(/Run a command/), "new preview tab");
    await user.click(await screen.findByText("New preview tab"));

    unmount();
    expect(trigger).not.toHaveFocus();
  });

  it("does NOT restore focus when opening a file by path, which focuses its path field", async () => {
    render(<button>open palette</button>);
    const trigger = screen.getByText("open palette");
    trigger.focus();

    const user = userEvent.setup();
    const { unmount } = renderPalette();
    await user.click(await screen.findByText(/Project: mullion/));
    await user.click(await screen.findByText("Open file by path"));

    unmount();
    expect(trigger).not.toHaveFocus();
  });

  it("traps Tab within the palette", async () => {
    const user = userEvent.setup();
    const { container } = renderPalette();
    await screen.findByRole("button", { name: /New session…/ });

    const dialog = container.querySelector(".cmd-palette") as HTMLElement;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    last.focus();
    await user.tab();
    expect(first).toHaveFocus();

    first.focus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });
});

describe("CommandPalette -> skip-permissions badge", () => {
  const CLAUDE: Launcher = {
    id: "agent:claude",
    kind: "agent",
    title: "claude",
    command: "claude",
  };
  const CODEX: Launcher = {
    id: "agent:codex",
    kind: "agent",
    title: "codex",
    command: "codex",
    skipPermissions: true,
  };
  const OPENCODE_EXPLICIT_FALSE: Launcher = {
    id: "agent:opencode",
    kind: "agent",
    title: "opencode",
    command: "opencode",
    skipPermissions: false,
  };
  const BASH: Launcher = { id: "shell:bash", kind: "shell", title: "bash", command: "bash" };

  beforeEach(() => {
    useDashboardStore.setState({
      projects: [PROJECT],
      sessions: [],
      settings: {
        ...DEFAULT_SETTINGS,
        launchers: {
          ...DEFAULT_SETTINGS.launchers,
          skipPermissionsAgents: ["claude"],
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetch(opts: { onCreateSession?: (body: unknown) => void }) {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/actions"))
        return Promise.resolve(jsonResponse(200, [CLAUDE, CODEX, OPENCODE_EXPLICIT_FALSE, BASH]));
      if (url.includes("/urls")) return Promise.resolve(jsonResponse(200, []));
      if (url.endsWith("/api/sessions") && init?.method === "POST") {
        opts.onCreateSession?.(JSON.parse(String(init.body)));
        return Promise.resolve(
          jsonResponse(201, { id: 1, projectId: PROJECT.id, command: "bash", status: "active" }),
        );
      }
      if (url.startsWith("/api/sessions")) return Promise.resolve(jsonResponse(200, []));
      return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
    });
  }

  it("shows skip-perms badges for agents in the global settings list and those with skipPermissions:true in launcher config", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    // "c" matches claude, codex and opencode, so the count of 2 still leaves
    // opencode out.
    await userEvent.setup().type(await screen.findByPlaceholderText(/Run a command/), "c");
    await screen.findByRole("button", { name: /opencode/ });
    // claude (global settings list) + codex (launcher skipPermissions:true) = 2 badges
    expect(screen.getAllByText("⚠ skip perms")).toHaveLength(2);
  });

  it("does not show skip-perms badge for agents with skipPermissions: false even if in global list", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    // opencode has skipPermissions: false in launcher config and is NOT in
    // the global settings list — no badge expected.
    await screen.findByText("New session…");
    await userEvent.setup().click(screen.getByPlaceholderText(/Run a command/));
    await userEvent.setup().clear(screen.getByPlaceholderText(/Run a command/));
    await userEvent.setup().type(screen.getByPlaceholderText(/Run a command/), "opencode");
    expect(screen.queryByText("⚠ skip perms")).not.toBeInTheDocument();
  });

  it("does not show skip-perms badge for shells", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await screen.findByText("New session…");
    await userEvent.setup().click(screen.getByPlaceholderText(/Run a command/));
    await userEvent.setup().clear(screen.getByPlaceholderText(/Run a command/));
    await userEvent.setup().type(screen.getByPlaceholderText(/Run a command/), "bash");
    expect(screen.queryByText("⚠ skip perms")).not.toBeInTheDocument();
  });
});

// U2 (audit finding: "⌘K is a launcher, not a switcher") — the Sessions and
// Workspaces result groups, plus the flattened keyboard nav across all three
// groups (Sessions -> Workspaces -> Launchers).
describe("CommandPalette -> Sessions/Workspaces search (U2)", () => {
  const LAUNCHER: Launcher = { id: "agent:bash", kind: "shell", title: "bash", command: "bash" };

  // Same full-shape fixture convention as SessionRow.test.tsx's own
  // makeSession — Session has no optional fields, so every test that wants a
  // session in the store needs the complete object, not just the few fields
  // the assertion cares about.
  function makeSession(overrides: Partial<Session> = {}): Session {
    return {
      id: 1,
      projectId: PROJECT.id,
      parentSessionId: null,
      name: null,
      nameLocked: false,
      command: "claude code",
      cwd: null,
      env: null,
      kind: "terminal",
      status: "active",
      // Issue #1727 — the session's host: the raw column (null = inherits
      // its project's) and the resolved one the host badge shows.
      hostId: null,
      resolvedHostId: "local",
      // Issue #1852 — the placement decision's own words; null when
      // nothing was decided here (a test session's default).
      placementReason: null,
      createdAt: "",
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
      gates: [],
      gatePrompt: null,
      promoteState: "idle",
      promoteSummary: null,
      promoteSuggestedBaseRef: null,
      permissionState: "idle",
      planState: "idle",
      errorState: "idle",
      endedReason: null,
      liveBranch: null,
      exitCode: null,
      attentionKind: null,
      errorDetail: null,
      lastAssistantMessage: null,
      currentTodo: null,
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

  function mockFetch(opts: { onCreateSession?: (body: unknown) => void } = {}) {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/actions")) return Promise.resolve(jsonResponse(200, [LAUNCHER]));
      if (url.includes("/urls")) return Promise.resolve(jsonResponse(200, []));
      if (url.endsWith("/api/sessions") && init?.method === "POST") {
        opts.onCreateSession?.(JSON.parse(String(init.body)));
        return Promise.resolve(
          jsonResponse(201, {
            id: 999,
            projectId: PROJECT.id,
            command: "bash",
            cwd: null,
            env: null,
            status: "active",
            // Issue #1727 — the session's host: the raw column (null = inherits
            // its project's) and the resolved one the host badge shows.
            hostId: null,
            resolvedHostId: "local",
            // Issue #1852 — the placement decision's own words; null when
            // nothing was decided here (a test session's default).
            placementReason: null,
          }),
        );
      }
      // createSession refreshes the session list afterward (store.ts).
      if (url.startsWith("/api/sessions")) return Promise.resolve(jsonResponse(200, []));
      return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces a matching session and opens the existing pane on click, not a new one", async () => {
    const session = makeSession({ id: 42, name: "hotfix runner", liveBranch: "fix/thing" });
    useDashboardStore.setState({ projects: [PROJECT], sessions: [session], workspaces: [] });
    vi.stubGlobal("fetch", mockFetch());
    const onOpenSession = vi.fn();
    useDashboardStore.setState({ launcherRequest: null });
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onOpenSession={onOpenSession}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await screen.findByText("New session…");
    await user.type(screen.getByPlaceholderText(/Run a command/), "hotfix");

    expect(await screen.findByText("Sessions")).toBeInTheDocument();
    // Matched on the session's own name plus its project and branch — same
    // precedence the CommandPalette.tsx matchingSessions comment documents.
    await user.click(screen.getByText("hotfix runner"));

    expect(onOpenSession).toHaveBeenCalledWith(session);
    // The whole point of this group: it opens the EXISTING pane, it never
    // goes through the create-a-new-session path.
    expect(useDashboardStore.getState().launcherRequest).toBeNull();
  });

  it("does not surface a killed or dock session", async () => {
    const killed = makeSession({ id: 2, name: "killed one", status: "killed" });
    const dock = makeSession({ id: 3, name: "dock monitor", kind: "dock" });
    const live = makeSession({ id: 4, name: "matchme live" });
    useDashboardStore.setState({
      projects: [PROJECT],
      sessions: [killed, dock, live],
      workspaces: [],
    });
    vi.stubGlobal("fetch", mockFetch());
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await screen.findByText("New session…");
    await user.type(screen.getByPlaceholderText(/Run a command/), "match");

    await screen.findByText("matchme live");
    expect(screen.queryByText("killed one")).not.toBeInTheDocument();
    expect(screen.queryByText("dock monitor")).not.toBeInTheDocument();
  });

  it("in project scope, only surfaces sessions belonging to the current project (Hermes review, PR #581)", async () => {
    const OTHER_PROJECT: Project = { ...PROJECT, id: 6, name: "other-repo" };
    const here = makeSession({ id: 10, projectId: PROJECT.id, name: "matchme here" });
    const elsewhere = makeSession({
      id: 11,
      projectId: OTHER_PROJECT.id,
      name: "matchme elsewhere",
    });
    useDashboardStore.setState({
      projects: [PROJECT, OTHER_PROJECT],
      sessions: [here, elsewhere],
      workspaces: [],
    });
    vi.stubGlobal("fetch", mockFetch());
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await screen.findByText("New session…");
    await user.type(screen.getByPlaceholderText(/Run a command/), "match");

    // The target strip reads "Runs in mullion" for this scope, and the
    // launcher list itself is already fetched per-project — a session from
    // OTHER_PROJECT ranking above this project's own commands would
    // contradict that framing.
    await screen.findByText("matchme here");
    expect(screen.queryByText("matchme elsewhere")).not.toBeInTheDocument();
  });

  it("in global scope, surfaces sessions from any project", async () => {
    const OTHER_PROJECT: Project = { ...PROJECT, id: 6, name: "other-repo" };
    const elsewhere = makeSession({
      id: 12,
      projectId: OTHER_PROJECT.id,
      name: "matchme elsewhere",
    });
    useDashboardStore.setState({
      projects: [PROJECT, OTHER_PROJECT],
      sessions: [elsewhere],
      workspaces: [],
    });
    vi.stubGlobal("fetch", mockFetch());
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="global"
        projectId={null}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await screen.findByText("New session…");
    await user.type(screen.getByPlaceholderText(/Run a command/), "match");

    // Global scope's own project picker isn't bound to one project (unlike
    // "project" scope's "Runs in <project>" framing), so unlike the test
    // above, a session from a different project than whichever one the
    // target strip happens to default to should still surface — the
    // subtitle's project name is what disambiguates here.
    await screen.findByText("matchme elsewhere");
  });

  it("surfaces a matching workspace and switches to it on click, resetting viewMode out of Tasks", async () => {
    const workspace = makeWorkspace({ id: 9, name: "Release train" });
    useDashboardStore.setState({
      projects: [PROJECT],
      sessions: [],
      workspaces: [workspace],
      activeWorkspaceId: null,
      // Issue: selecting a workspace from the palette while Tasks was open
      // used to leave this at "kanban" — the workspace really did switch,
      // just invisibly behind the Tasks board's own overlay.
      viewMode: "kanban",
    });
    vi.stubGlobal("fetch", mockFetch());
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={onClose}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await screen.findByText("New session…");
    await user.type(screen.getByPlaceholderText(/Run a command/), "release");

    expect(await screen.findByText("Workspaces")).toBeInTheDocument();
    await user.click(screen.getByText("Release train"));

    expect(useDashboardStore.getState().activeWorkspaceId).toBe(9);
    expect(useDashboardStore.getState().viewMode).toBe("list");
    expect(onClose).toHaveBeenCalled();
  });

  it("arrow-keys and Enter navigate Sessions -> Workspaces -> Launchers as one flattened list", async () => {
    const session = makeSession({ id: 5, name: "bashful session" });
    const workspace = makeWorkspace({ id: 3, name: "bashful workspace" });
    useDashboardStore.setState({
      projects: [PROJECT],
      sessions: [session],
      workspaces: [workspace],
    });
    const onCreateSession = vi.fn();
    vi.stubGlobal("fetch", mockFetch({ onCreateSession }));
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onOpenSession={onOpenSession}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await screen.findByText("New session…");
    // Matches all three groups: the session/workspace names both contain
    // "bash", and "bash" is also the shell launcher's own title.
    await user.type(screen.getByPlaceholderText(/Run a command/), "bash");
    await screen.findByText("bashful session");
    await screen.findByText("bashful workspace");

    // Typing resets selection to index 0 -> the first Sessions row is
    // highlighted by default. Two ArrowDowns walk Sessions -> Workspaces ->
    // Launchers (one flattened index across all three groups), then
    // Enter should open the launcher on the bash command (#3054), not reopen
    // the session or switch the workspace.
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");

    expect(useDashboardStore.getState().launcherRequest?.target).toEqual({
      projectId: PROJECT.id,
      launcherId: "agent:bash",
    });
    expect(onCreateSession).not.toHaveBeenCalled();
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(useDashboardStore.getState().activeWorkspaceId).not.toBe(3);
  });

  it("Enter at the default (index 0) selection opens the session, not a launcher", async () => {
    // Same three-way match as the flattened-nav test above, but exercises
    // the "session" branch of the Enter switch directly (no arrow keys) —
    // that switch is the one place a wrong index/offset would silently pick
    // the wrong branch, and the flattened-nav test above only ever exercises
    // the "launcher" branch.
    const session = makeSession({ id: 5, name: "bashful session" });
    const workspace = makeWorkspace({ id: 3, name: "bashful workspace" });
    useDashboardStore.setState({
      projects: [PROJECT],
      sessions: [session],
      workspaces: [workspace],
    });
    const onCreateSession = vi.fn();
    vi.stubGlobal("fetch", mockFetch({ onCreateSession }));
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onOpenSession={onOpenSession}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await screen.findByText("New session…");
    await user.type(screen.getByPlaceholderText(/Run a command/), "bash");
    await screen.findByText("bashful session");
    await screen.findByText("bashful workspace");

    await user.keyboard("{Enter}");

    expect(onOpenSession).toHaveBeenCalledWith(session);
    expect(onCreateSession).not.toHaveBeenCalled();
    expect(useDashboardStore.getState().activeWorkspaceId).not.toBe(3);
  });

  it("one ArrowDown then Enter switches to the workspace, not the session or a launcher", async () => {
    // Exercises the "workspace" branch of the same Enter switch — the
    // middle of the three flattened groups, so the one most likely to have
    // an off-by-one offset if matchingSessions.length were computed wrong.
    const session = makeSession({ id: 5, name: "bashful session" });
    const workspace = makeWorkspace({ id: 3, name: "bashful workspace" });
    useDashboardStore.setState({
      projects: [PROJECT],
      sessions: [session],
      workspaces: [workspace],
      activeWorkspaceId: null,
      viewMode: "kanban",
    });
    const onCreateSession = vi.fn();
    vi.stubGlobal("fetch", mockFetch({ onCreateSession }));
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onOpenSession={onOpenSession}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await screen.findByText("New session…");
    await user.type(screen.getByPlaceholderText(/Run a command/), "bash");
    await screen.findByText("bashful session");
    await screen.findByText("bashful workspace");

    await user.keyboard("{ArrowDown}{Enter}");

    expect(useDashboardStore.getState().activeWorkspaceId).toBe(3);
    expect(useDashboardStore.getState().viewMode).toBe("list");
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(onCreateSession).not.toHaveBeenCalled();
  });

  it("does not show a Sessions or Workspaces group on an empty query", async () => {
    const session = makeSession({ id: 8, name: "idle session" });
    const workspace = makeWorkspace({ id: 6, name: "idle workspace" });
    useDashboardStore.setState({
      projects: [PROJECT],
      sessions: [session],
      workspaces: [workspace],
    });
    vi.stubGlobal("fetch", mockFetch());
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await screen.findByText("New session…");

    expect(screen.queryByText("Sessions")).not.toBeInTheDocument();
    expect(screen.queryByText("Workspaces")).not.toBeInTheDocument();
    expect(screen.queryByText("idle session")).not.toBeInTheDocument();
    expect(screen.queryByText("idle workspace")).not.toBeInTheDocument();
  });

  // PR #810 — the palette's own two workspace-select sites (Enter and
  // click) used to call the store's `showWorkspace` directly, leaving a
  // phone/tablet sidebar overlay open behind the closing palette. Both must
  // route through `onShowWorkspace` when the caller (App.tsx) supplies one.
  it("calls onShowWorkspace, not just the store action, when selecting a workspace via Enter", async () => {
    const workspace = makeWorkspace({ id: 3, name: "bashful workspace" });
    useDashboardStore.setState({
      projects: [PROJECT],
      sessions: [],
      workspaces: [workspace],
      activeWorkspaceId: null,
    });
    vi.stubGlobal("fetch", mockFetch());
    const onShowWorkspace = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
        onShowWorkspace={onShowWorkspace}
      />,
    );

    await screen.findByText("New session…");
    await user.type(screen.getByPlaceholderText(/Run a command/), "bashful");
    await screen.findByText("bashful workspace");
    await user.keyboard("{Enter}");

    expect(onShowWorkspace).toHaveBeenCalledWith(3);
  });

  it("calls onShowWorkspace when clicking a workspace search result", async () => {
    const workspace = makeWorkspace({ id: 4, name: "clickable workspace" });
    useDashboardStore.setState({
      projects: [PROJECT],
      sessions: [],
      workspaces: [workspace],
      activeWorkspaceId: null,
    });
    vi.stubGlobal("fetch", mockFetch());
    const onShowWorkspace = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
        onShowWorkspace={onShowWorkspace}
      />,
    );

    await screen.findByText("New session…");
    await user.type(screen.getByPlaceholderText(/Run a command/), "clickable");
    await user.click(await screen.findByText("clickable workspace"));

    expect(onShowWorkspace).toHaveBeenCalledWith(4);
  });
});

describe("CommandPalette -> target project picker (Launch in dropdown)", () => {
  const PROJECT_A: Project = {
    ...PROJECT,
    id: 1,
    name: "alpha-project",
    cwd: "/home/x/alpha",
  };
  const PROJECT_B: Project = {
    ...PROJECT,
    id: 2,
    name: "beta-project",
    cwd: "/home/x/beta",
  };

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("/api/projects/1/actions")) {
          return Promise.resolve(
            jsonResponse(200, [
              { id: "shell:bash-alpha", kind: "shell", title: "bash alpha", command: "bash" },
            ]),
          );
        }
        if (u.includes("/api/projects/2/actions")) {
          return Promise.resolve(
            jsonResponse(200, [
              { id: "shell:bash-beta", kind: "shell", title: "bash beta", command: "bash" },
            ]),
          );
        }
        return Promise.resolve(jsonResponse(200, []));
      }),
    );
    useDashboardStore.setState({
      projects: [PROJECT_A, PROJECT_B],
      sessions: [],
      workspaces: [],
      settings: DEFAULT_SETTINGS,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows 'N hosts' instead of the path for a project that spans hosts (#2238)", async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({
      projects: [{ ...PROJECT_A, hostCwds: { "mac-mini": "/Users/x/alpha" } }, PROJECT_B],
    });
    render(
      <CommandPalette
        scope="global"
        projectId={null}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );
    await user.click(await screen.findByRole("button", { name: /Target project:/ }));

    const options = screen.getAllByRole("option");
    const alpha = options.find((o) => o.textContent?.includes(PROJECT_A.name));
    const beta = options.find((o) => o.textContent?.includes(PROJECT_B.name));
    expect(alpha).toHaveTextContent("2 hosts");
    expect(alpha).toHaveAttribute("title", PROJECT_A.cwd);
    expect(beta).not.toHaveTextContent("hosts");
  });

  it("toggles the project picker open and closed when clicking the project chip", async () => {
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="global"
        projectId={null}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await screen.findByRole("button", { name: /New session…/ });
    const targetButton = screen.getByRole("button", { name: /Target project:/ });
    expect(targetButton).toHaveAttribute("aria-expanded", "false");

    await user.click(targetButton);
    expect(targetButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Which project?")).toBeInTheDocument();
    expect(screen.getByText("beta-project")).toBeInTheDocument();

    await user.click(targetButton);
    expect(targetButton).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Which project?")).not.toBeInTheDocument();
  });

  it("styles the picker distinctly, marks the current project and shortens the home path", async () => {
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="global"
        projectId={null}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await screen.findByRole("button", { name: /New session…/ });
    await user.click(screen.getByRole("button", { name: /Target project:/ }));

    expect(screen.getByRole("listbox")).toHaveClass("project-picker");
    expect(screen.getAllByLabelText("Current project")).toHaveLength(1);
    expect(screen.getByText("~/alpha")).toBeInTheDocument();
    expect(screen.queryByText("/home/x/alpha")).not.toBeInTheDocument();
  });

  it("filters the project list by query while picker is open", async () => {
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="global"
        projectId={null}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await screen.findByRole("button", { name: /New session…/ });
    const targetButton = screen.getByRole("button", { name: /Target project:/ });
    await user.click(targetButton);

    const input = screen.getByPlaceholderText("Filter projects…");
    await user.type(input, "beta");

    const listbox = screen.getByRole("listbox");
    // alpha-project should be filtered out of the project list
    expect(within(listbox).queryByText("alpha-project")).not.toBeInTheDocument();
    expect(within(listbox).getByText("beta-project")).toBeInTheDocument();
  });

  it("selects a project on click and switches launchers to the new project", async () => {
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="global"
        projectId={null}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    // A typed query lists the target project's launchers, so the switch
    // shows as one project's shell replacing the other's.
    await screen.findByRole("button", { name: /New session…/ });
    await user.type(
      screen.getByPlaceholderText("Run a command, or find a session or agent…"),
      "bash",
    );
    await screen.findByText("bash alpha");
    const targetButton = screen.getByRole("button", { name: /Target project:/ });
    await user.click(targetButton);

    await user.click(screen.getByText("beta-project"));
    expect(screen.queryByText("Which project?")).not.toBeInTheDocument();
    await screen.findByText("bash beta");
    expect(screen.queryByText("bash alpha")).not.toBeInTheDocument();
  });

  it("navigates projects with ArrowDown/ArrowUp and selects with Enter without launching background commands", async () => {
    useDashboardStore.setState({ launcherRequest: null });
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="global"
        projectId={null}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await screen.findByRole("button", { name: /New session…/ });
    await user.type(
      screen.getByPlaceholderText("Run a command, or find a session or agent…"),
      "bash",
    );
    await screen.findByText("bash alpha");
    const targetButton = screen.getByRole("button", { name: /Target project:/ });
    await user.click(targetButton);

    // Focus the search input so our onKeyDown intercepts ArrowDown/Enter
    const input = screen.getByPlaceholderText("Filter projects…");
    await user.click(input);
    await user.keyboard("{ArrowDown}{Enter}");

    expect(useDashboardStore.getState().launcherRequest).toBeNull();
    await screen.findByText("bash beta");
  });

  it("closes the project picker on Escape without closing the whole command palette", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="global"
        projectId={null}
        onClose={onClose}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await screen.findByRole("button", { name: /New session…/ });
    await user.type(
      screen.getByPlaceholderText("Run a command, or find a session or agent…"),
      "bash",
    );
    await screen.findByText("bash alpha");
    const targetButton = screen.getByRole("button", { name: /Target project:/ });
    await user.click(targetButton);
    expect(screen.getByText("Which project?")).toBeInTheDocument();

    // Focus the search input so our onKeyDown intercepts Escape
    const input = screen.getByPlaceholderText("Filter projects…");
    await user.click(input);
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText("Which project?")).not.toBeInTheDocument();
    expect(screen.getByText("bash alpha")).toBeInTheDocument();
  });

  it("restores the pre-picker search query after selecting a project, instead of leaking the picker's filter text into it", async () => {
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="global"
        projectId={null}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    const searchInput = await screen.findByPlaceholderText(
      "Run a command, or find a session or agent…",
    );
    await user.type(searchInput, "bash");
    expect(await screen.findByText("bash alpha")).toBeInTheDocument();

    const targetButton = screen.getByRole("button", { name: /Target project:/ });
    await user.click(targetButton);
    const filterInput = screen.getByPlaceholderText("Filter projects…");
    await user.type(filterInput, "beta");
    await user.click(screen.getByText("beta-project"));

    // The main search box should show the pre-picker query ("bash"), not
    // the picker's own leftover filter text ("beta") — and the launcher
    // list should reflect that restored query rather than sitting empty.
    const restoredInput = screen.getByPlaceholderText("Run a command, or find a session or agent…");
    expect(restoredInput).toHaveValue("bash");
    await screen.findByText("bash beta");
    expect(screen.queryByText("No matching agents, shells or scripts.")).not.toBeInTheDocument();
  });

  it("restores the pre-picker search query after closing the picker with Escape", async () => {
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="global"
        projectId={null}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    const searchInput = await screen.findByPlaceholderText(
      "Run a command, or find a session or agent…",
    );
    await user.type(searchInput, "bash");
    await screen.findByText("bash alpha");

    const targetButton = screen.getByRole("button", { name: /Target project:/ });
    await user.click(targetButton);
    const filterInput = screen.getByPlaceholderText("Filter projects…");
    await user.type(filterInput, "beta");
    await user.keyboard("{Escape}");

    const restoredInput = screen.getByPlaceholderText("Run a command, or find a session or agent…");
    expect(restoredInput).toHaveValue("bash");
    expect(screen.getByText("bash alpha")).toBeInTheDocument();
  });
});

describe("CommandPalette -> close affordance (issue: mobile 'esc' chip did nothing)", () => {
  // The mobile-new-session '+' button (MobileSessionSwitcher) routes
  // through this palette. On a phone the palette is full-bleed, the
  // backdrop has zero tappable area, focus is anchored to modalRef
  // (not the search input, which is what would handle Escape), and
  // the soft keyboard has no Esc key — so the "esc" hint sitting in
  // the search row was a strictly cosmetic <span> that did nothing
  // on tap. The fix turns it into a real <button className="kbd
  // kbd-btn" onClick={onClose}>, and gives the footer's picker-Back
  // chip the same treatment.
  const LAUNCHER: Launcher = { id: "agent:bash", kind: "shell", title: "bash", command: "bash" };

  function renderPalette(overrides: Partial<ComponentProps<typeof CommandPalette>> = {}) {
    return render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
        {...overrides}
      />,
    );
  }

  it("renders a real 'Close command palette' button next to the search input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/projects/") && url.endsWith("/urls")) {
          return Promise.resolve(jsonResponse(200, []));
        }
        if (url.includes("/actions")) return Promise.resolve(jsonResponse(200, [LAUNCHER]));
        if (url.startsWith("/api/sessions") && (url.includes("?") || url.endsWith("/sessions"))) {
          return Promise.resolve(jsonResponse(200, []));
        }
        if (url.endsWith("/api/sessions") || url.includes("/api/sessions?")) {
          return Promise.resolve(jsonResponse(200, []));
        }
        return Promise.resolve(jsonResponse(200, []));
      }),
    );
    renderPalette();
    const close = await screen.findByRole("button", { name: "Close command palette" });
    expect(close).toBeInTheDocument();
    // It carries the kbd keycap look — the literal "esc" text is only
    // rendered for fine pointers, so a jsdom default-pointer test sees
    // that fallback text. The button itself is always there regardless.
    expect(close).toHaveTextContent("esc");
  });

  it("clicking the close button fires onClose", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/projects/") && url.endsWith("/urls")) {
          return Promise.resolve(jsonResponse(200, []));
        }
        if (url.includes("/actions")) return Promise.resolve(jsonResponse(200, [LAUNCHER]));
        if (url.startsWith("/api/sessions")) return Promise.resolve(jsonResponse(200, []));
        return Promise.resolve(jsonResponse(200, []));
      }),
    );
    const onClose = vi.fn();
    renderPalette({ onClose });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Close command palette" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// The "Project ›" drill-in and searchable Integrations commands.
describe("CommandPalette -> Project drill-in and command search", () => {
  const openers = () => ({
    onOpenGitHub: vi.fn(),
    onOpenAgentRules: vi.fn(),
    onOpenFileEditor: vi.fn(),
    onOpenExternalFile: vi.fn(),
    onOpenProjectBriefing: vi.fn(),
    onOpenProjectSetup: vi.fn(),
    onOpenDockConfig: vi.fn(),
    onOpenSkills: vi.fn(),
    onOpenBrowser: vi.fn(),
    onOpenBlankBrowser: vi.fn(),
    onOpenSettingsSection: vi.fn(),
    onOpenTasks: vi.fn(),
    onOpenBrowserUrl: vi.fn(),
  });

  function renderPalette(
    o: ReturnType<typeof openers>,
    props: Partial<ComponentProps<typeof CommandPalette>> = {},
  ) {
    return render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={props.onClose ?? vi.fn()}
        onOpenSession={vi.fn()}
        {...o}
        {...props}
      />,
    );
  }

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, []))),
    );
    useDashboardStore.setState({ projects: [PROJECT], sessions: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("collapses the setup entries into one Project row on the empty-query list", async () => {
    renderPalette(openers());

    expect(await screen.findByText("Project: mullion")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.queryByText("Git", { exact: true })).toBeNull();
    expect(screen.queryByText("Preview", { exact: true })).toBeNull();
    expect(screen.queryByText("GitHub settings")).toBeNull();
    for (const hidden of [
      "Agent Rules",
      "Mullion Briefing",
      "Scaffold Mullion",
      "Skills",
      "Dock",
    ]) {
      expect(screen.queryByText(hidden)).toBeNull();
    }
  });

  it("drills into the sub-list, switching the placeholder, and runs an item", async () => {
    const o = openers();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderPalette(o, { onClose });

    await user.click(await screen.findByText("Project: mullion"));

    expect(screen.getByPlaceholderText("Project: mullion › filter…")).toBeTruthy();
    for (const item of [
      "Agent Rules",
      "Mullion Briefing",
      "Scaffold Mullion",
      "Dock",
      "Skills",
      "Edit project files",
    ]) {
      expect(screen.getByText(item)).toBeTruthy();
    }
    expect(screen.queryByText("GitHub")).toBeNull();

    await user.click(screen.getByText("Scaffold Mullion"));
    expect(o.onOpenProjectSetup).toHaveBeenCalledWith(PROJECT.id);
    expect(onClose).toHaveBeenCalled();
  });

  it("filters the sub-list by the query", async () => {
    const user = userEvent.setup();
    renderPalette(openers());
    await user.click(await screen.findByText("Project: mullion"));

    await user.type(screen.getByPlaceholderText("Project: mullion › filter…"), "skil");

    expect(screen.getByText("Skills")).toBeTruthy();
    expect(screen.queryByText("Dock")).toBeNull();
  });

  // Issue #1881 — the Dock is hidden by TWO rules: tablet.css's
  // `(pointer: coarse)` block and mobile.css's phone-tier block. The
  // palette's Dock command said nothing about either, so a user ran a
  // command that configures a panel they cannot see, and got no
  // explanation.
  describe("the Dock command's availability (issue #1881)", () => {
    const coarsePointer = () =>
      vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({
          matches: query === "(pointer: coarse)",
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      );

    // A phone-tier window with a FINE pointer — a narrow window, or
    // `settings.layoutMode: "phone"` — is hidden by mobile.css's own
    // phone-tier rule. A predicate that only asked about the pointer would
    // call the Dock available here.
    const phoneTier = () =>
      useDashboardStore.setState({
        settings: { ...useDashboardStore.getState().settings, layoutMode: "phone" },
      });

    afterEach(() => {
      useDashboardStore.setState({
        settings: { ...useDashboardStore.getState().settings, layoutMode: "auto" },
      });
    });

    it("says the Dock is hidden under a coarse pointer", async () => {
      coarsePointer();
      const user = userEvent.setup();
      renderPalette(openers());
      await user.click(await screen.findByText("Project: mullion"));

      const label = screen.getByText("Not shown here");
      expect(label).toHaveClass("cmd-row-availability", "unavailable");
      expect(label).toHaveAttribute(
        "title",
        "the Dock is hidden while touch is the primary pointer",
      );
      expect(
        screen.getByText(/the Dock is hidden while touch is the primary pointer/i),
      ).toBeInTheDocument();
    });

    it("says the Dock is hidden on the phone layout", async () => {
      phoneTier();
      const user = userEvent.setup();
      renderPalette(openers(), { layoutTier: "phone" });
      await user.click(await screen.findByText("Project: mullion"));

      expect(screen.getByText("Not shown here")).toHaveAttribute(
        "title",
        "the Dock is hidden on the phone layout",
      );
      expect(screen.getByText(/the Dock is hidden on the phone layout/i)).toBeInTheDocument();
    });

    // The reason rides in the row's own availability slot, not the
    // subtitle: the subtitle is ellipsized, and a reason does not survive
    // being cut off mid-word.
    it("keeps the subtitle short even when the Dock is unavailable", async () => {
      coarsePointer();
      const user = userEvent.setup();
      renderPalette(openers());
      await user.click(await screen.findByText("Project: mullion"));

      expect(screen.getByText("Edit this project's dock monitors")).toBeTruthy();
    });

    it("says nothing about the Dock where it can be shown", async () => {
      const user = userEvent.setup();
      renderPalette(openers());
      await user.click(await screen.findByText("Project: mullion"));

      expect(screen.getByText("Edit this project's dock monitors")).toBeTruthy();
      expect(screen.queryByText("Not shown here")).toBeNull();
      expect(
        screen.queryByText(/the Dock is hidden (on the phone layout|while touch)/i),
      ).toBeNull();
    });
  });

  it("navigates the sub-list with arrows and Enter", async () => {
    const o = openers();
    const user = userEvent.setup();
    renderPalette(o);
    await user.click(await screen.findByText("Project: mullion"));

    // Agent Rules (0) -> Dock (1) -> Edit project files (2) -> Briefing (3),
    // then back up to Edit project files (2). Title order, not insertion order.
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowUp}{Enter}");

    expect(o.onOpenFileEditor).toHaveBeenCalledWith(PROJECT.id);
    expect(o.onOpenProjectBriefing).not.toHaveBeenCalled();
  });

  it("Escape and Backspace-on-empty step back out instead of closing the palette", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderPalette(openers(), { onClose });

    await user.click(await screen.findByText("Project: mullion"));
    await user.keyboard("{Escape}");
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByText("Project: mullion"));
    await user.keyboard("{Backspace}");
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("finds a project sub-item from the top level and Enter runs it", async () => {
    const o = openers();
    const user = userEvent.setup();
    renderPalette(o);

    await user.type(await screen.findByPlaceholderText(/Run a command/), "skills");

    expect(screen.getByText("Project › Skills")).toBeTruthy();
    await user.keyboard("{Enter}");
    expect(o.onOpenSkills).toHaveBeenCalledWith(PROJECT.id);
  });

  it("does not offer the drill-in row itself as a search result", async () => {
    const user = userEvent.setup();
    renderPalette(openers());

    await user.type(await screen.findByPlaceholderText(/Run a command/), "project");

    expect(screen.queryByText("Project: mullion")).toBeNull();
  });

  it("runs Toggle right sidebar from the list and from a search, and omits it when unavailable", async () => {
    const onToggleRightSidebar = vi.fn();
    const user = userEvent.setup();
    const { unmount } = renderPalette(openers(), { onToggleRightSidebar });

    await user.type(await screen.findByPlaceholderText(/Run a command/), "toggle right sidebar");
    await user.click(await screen.findByText("Toggle right sidebar"));
    expect(onToggleRightSidebar).toHaveBeenCalledTimes(1);
    unmount();

    const again = vi.fn();
    renderPalette(openers(), { onToggleRightSidebar: again });
    await user.type(await screen.findByPlaceholderText(/Run a command/), "drawer");
    await user.keyboard("{Enter}");
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("Prune merged branches and Go to PR deep-link into the right sidebar", async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({
      prsByProject: {
        [PROJECT.id]: { prs: [{ number: 42, title: "Fix the thing" }], prSummary: {} },
      } as never,
    });
    const { unmount } = renderPalette(openers(), { onToggleRightSidebar: vi.fn() });
    await user.type(await screen.findByPlaceholderText(/Run a command/), "prune merged branches");
    await user.click(await screen.findByText("Prune merged branches"));
    expect(useDashboardStore.getState().rightSidebarPruneRequest?.projectId).toBe(PROJECT.id);
    unmount();

    renderPalette(openers(), { onToggleRightSidebar: vi.fn() });
    await user.type(await screen.findByPlaceholderText(/Run a command/), "pr 42");
    await user.keyboard("{Enter}");
    expect(useDashboardStore.getState().githubOpenPrByProject[PROJECT.id]).toBe(42);
    expect(useDashboardStore.getState().rightSidebarView).toBe("github");
  });

  it("queues a typed issue number from search and reports a failure", async () => {
    const user = userEvent.setup();
    const queue = vi
      .spyOn(api, "queueProjectIssue")
      .mockResolvedValue({ queued: true, label: "x" });
    const { unmount } = renderPalette(openers());
    await user.type(await screen.findByPlaceholderText(/Run a command/), "queue #7");
    await user.keyboard("{Enter}");
    expect(queue).toHaveBeenCalledWith(PROJECT.id, 7);
    unmount();

    queue.mockRejectedValueOnce(new Error("nope"));
    const reportError = vi.fn();
    useDashboardStore.setState({ reportError } as never);
    renderPalette(openers());
    await user.type(await screen.findByPlaceholderText(/Run a command/), "queue 8");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(reportError).toHaveBeenCalled());
  });

  it("omits Toggle right sidebar when the host provides no opener (phone)", async () => {
    renderPalette(openers());

    expect(await screen.findByText("New workspace")).toBeTruthy();
    expect(screen.queryByText("Toggle right sidebar")).toBeNull();
  });

  it("hides the project entries (but keeps the global ones) without a project", async () => {
    useDashboardStore.setState({ projects: [] });
    renderPalette(openers(), { scope: "global", projectId: undefined });

    expect(await screen.findByText("New workspace")).toBeTruthy();
    expect(screen.queryByText("New preview tab")).toBeNull();
    expect(screen.queryByText(/^Project:/)).toBeNull();
    expect(screen.queryByText(/^GitHub:/)).toBeNull();
  });

  it("labels the empty list Commands only, and has no New session or Navigate group", async () => {
    renderPalette(openers());

    expect(await screen.findByRole("button", { name: /New session…/ })).toBeTruthy();
    expect(screen.getByText("Commands")).toBeTruthy();
    expect(document.querySelectorAll(".cmd-palette-group-label")).toHaveLength(1);
    expect(screen.queryByText("New session")).toBeNull();
    expect(screen.queryByText("Navigate")).toBeNull();
    expect(screen.queryByText("Matching commands")).toBeNull();
    expect(screen.queryByText("Integrations")).toBeNull();
  });

  it("opens Devices, Hosts, and Settings through the same callbacks the rest of the UI uses", async () => {
    const onOpenDevices = vi.fn();
    const onOpenHosts = vi.fn();
    const onOpenSettings = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderPalette(openers(), { onOpenDevices, onOpenHosts, onOpenSettings, onClose });

    await user.clear(await screen.findByPlaceholderText(/Run a command/));
    await user.type(screen.getByPlaceholderText(/Run a command/), "devices");
    await user.click(await screen.findByText(/^Devices$/));
    expect(onOpenDevices).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.clear(await screen.findByPlaceholderText(/Run a command/));
    await user.type(screen.getByPlaceholderText(/Run a command/), "hosts");
    await user.click(screen.getByText(/^Hosts$/));
    expect(onOpenHosts).toHaveBeenCalledTimes(1);

    await user.clear(await screen.findByPlaceholderText(/Run a command/));
    await user.type(screen.getByPlaceholderText(/Run a command/), "settings");
    await user.click(screen.getByText(/^Settings$/));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("finds Devices from a query", async () => {
    const onOpenDevices = vi.fn();
    const user = userEvent.setup();
    renderPalette(openers(), { onOpenDevices });

    await user.type(await screen.findByPlaceholderText(/Run a command/), "devices");
    expect(screen.getByText(/^Devices$/)).toBeTruthy();
    await user.keyboard("{Enter}");
    expect(onOpenDevices).toHaveBeenCalledTimes(1);
  });

  it("offers the session timeline only for the active, non-killed session pane", async () => {
    const session = makeSession({ id: 7, projectId: PROJECT.id, name: "hotfix" });
    const killed = makeSession({ id: 8, projectId: PROJECT.id, name: "old", status: "killed" });
    useDashboardStore.setState({
      projects: [PROJECT],
      sessions: [session, killed],
      activePanelId: null,
      workspaces: [],
    });
    const onOpenTimeline = vi.fn();
    const { unmount } = renderPalette(openers(), { onOpenTimeline });

    expect(await screen.findByText("New workspace")).toBeTruthy();
    expect(screen.queryByText("Session timeline")).toBeNull();
    unmount();

    useDashboardStore.setState({ activePanelId: "session-8" });
    const killedOnly = renderPalette(openers(), { onOpenTimeline });
    expect(await screen.findByText("New workspace")).toBeTruthy();
    expect(screen.queryByText("Session timeline")).toBeNull();
    killedOnly.unmount();

    useDashboardStore.setState({ activePanelId: "session-7" });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderPalette(openers(), { onOpenTimeline, onClose });
    await user.type(await screen.findByPlaceholderText(/Run a command/), "session timeline");
    await user.click(await screen.findByText("Session timeline"));
    expect(onOpenTimeline).toHaveBeenCalledWith(expect.objectContaining({ id: 7, name: "hotfix" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("asks for a workspace name, then creates and switches, and backs out without closing", async () => {
    const workspace = makeWorkspace({ id: 4, name: "side" });
    const createWorkspace = vi.fn().mockResolvedValue(workspace);
    const reportError = vi.fn();
    const prior = useDashboardStore.getState();
    useDashboardStore.setState({
      projects: [PROJECT],
      sessions: [],
      workspaces: [],
      createWorkspace,
      reportError,
    });
    const onShowWorkspace = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    try {
      renderPalette(openers(), { onShowWorkspace, onClose });

      await user.click(await screen.findByText("New workspace"));
      expect(screen.getByPlaceholderText("Workspace name…")).toBeTruthy();
      expect(screen.getByText("Name the workspace")).toBeTruthy();
      await user.keyboard("{Enter}");
      expect(createWorkspace).not.toHaveBeenCalled();

      await user.keyboard("{Escape}");
      expect(screen.getByText("GitHub")).toBeTruthy();
      expect(onClose).not.toHaveBeenCalled();

      await user.click(screen.getByText("New workspace"));
      await user.keyboard("{Backspace}");
      expect(screen.getByText("GitHub")).toBeTruthy();
      expect(onClose).not.toHaveBeenCalled();

      await user.click(screen.getByText("New workspace"));
      await user.type(screen.getByPlaceholderText("Workspace name…"), "side");
      expect(screen.getAllByText("Create side").length).toBeGreaterThan(0);
      await user.keyboard("{Enter}");
      await waitFor(() => {
        expect(createWorkspace).toHaveBeenCalledWith("side");
        expect(onShowWorkspace).toHaveBeenCalledWith(4);
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      useDashboardStore.setState({
        createWorkspace: prior.createWorkspace,
        reportError: prior.reportError,
        activePanelId: null,
      });
    }
  });

  it("keeps the name step open when creating a workspace fails", async () => {
    const createWorkspace = vi.fn().mockRejectedValue(new Error("taken"));
    const reportError = vi.fn();
    const prior = useDashboardStore.getState();
    useDashboardStore.setState({
      projects: [PROJECT],
      sessions: [],
      workspaces: [],
      createWorkspace,
      reportError,
    });
    const onClose = vi.fn();
    const user = userEvent.setup();
    try {
      renderPalette(openers(), { onClose });
      await user.click(await screen.findByText("New workspace"));
      await user.type(screen.getByPlaceholderText("Workspace name…"), "again");
      await user.keyboard("{Enter}");
      await waitFor(() => {
        expect(reportError).toHaveBeenCalledWith("Could not create the workspace.", "taken");
      });
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByDisplayValue("again")).toBeTruthy();
      // The pending flag clears on failure, so the name can be submitted again.
      await user.keyboard("{Enter}");
      await waitFor(() => expect(createWorkspace).toHaveBeenCalledTimes(2));
    } finally {
      useDashboardStore.setState({
        createWorkspace: prior.createWorkspace,
        reportError: prior.reportError,
      });
    }
  });

  it("ignores a second Enter while creating a workspace is still pending", async () => {
    const workspace = makeWorkspace({ id: 4, name: "side" });
    let resolveCreate: (value: typeof workspace) => void = () => {};
    const createWorkspace = vi.fn(
      () =>
        new Promise<typeof workspace>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const prior = useDashboardStore.getState();
    useDashboardStore.setState({
      projects: [PROJECT],
      sessions: [],
      workspaces: [],
      createWorkspace,
    });
    const onShowWorkspace = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    try {
      renderPalette(openers(), { onShowWorkspace, onClose });
      await user.click(await screen.findByText("New workspace"));
      await user.type(screen.getByPlaceholderText("Workspace name…"), "side");
      await user.keyboard("{Enter}{Enter}");
      expect(createWorkspace).toHaveBeenCalledTimes(1);
      expect(createWorkspace).toHaveBeenCalledWith("side");
      resolveCreate(workspace);
      await waitFor(() => {
        expect(onShowWorkspace).toHaveBeenCalledWith(4);
        expect(onClose).toHaveBeenCalledTimes(1);
      });
    } finally {
      useDashboardStore.setState({ createWorkspace: prior.createWorkspace });
    }
  });

  it("arrow keys walk the Commands group on a blank query", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(200, [{ id: "shell:bash", kind: "shell", title: "bash", command: "bash" }]),
        ),
      ),
    );
    const onOpenSettings = vi.fn();
    const o = openers();
    const user = userEvent.setup();
    renderPalette(o, { onOpenSettings, layoutTier: "phone" });

    // The Commands rows are the whole arrow list. ArrowDown stops on the
    // last row (Task board), so one ArrowUp from there is Settings.
    await screen.findByRole("button", { name: /New session…/ });
    expect(screen.queryByRole("button", { name: /bash/ })).toBeNull();
    await user.click(screen.getByPlaceholderText(/Run a command/));
    await user.keyboard("{ArrowDown>12/}");
    expect(screen.getByRole("button", { name: /Task board/ })).toHaveClass("selected");
    await user.keyboard("{ArrowUp}{Enter}");

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(o.onOpenTasks).not.toHaveBeenCalled();
  });

  it("labels the footer for a highlighted command instead of Launch in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(200, [{ id: "shell:bash", kind: "shell", title: "bash", command: "bash" }]),
        ),
      ),
    );
    const user = userEvent.setup();
    renderPalette(openers(), { onOpenSettings: vi.fn(), layoutTier: "phone" });

    // Same walk as the arrow-key test: down to the last row (Task board),
    // then one up to Settings.
    await screen.findByRole("button", { name: /New session…/ });
    await user.click(screen.getByPlaceholderText(/Run a command/));
    await user.keyboard("{ArrowDown>12/}{ArrowUp}");

    const footer = screen.getByText("navigate").closest(".cmd-palette-footer");
    expect(footer).toBeTruthy();
    expect(footer?.textContent).toContain("Run Settings");
    expect(footer?.textContent).not.toMatch(/Launch in/);

    // A drill-in row is a command too, but Enter opens a sub-list, not a
    // run. Hover selects it the same way the arrow keys do.
    const project = screen.getByRole("button", { name: /Project:/ });
    await user.hover(project);
    expect(footer?.textContent).toMatch(/Open Project:/);
    expect(footer?.textContent).not.toMatch(/Run Project:/);
  });
});

describe("CommandPalette -> default target follows the active pane", () => {
  const A: Project = { ...PROJECT, id: 1, name: "alpha-project", cwd: "/home/x/alpha" };
  const B: Project = { ...PROJECT, id: 2, name: "beta-project", cwd: "/home/x/beta" };

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, []))),
    );
    localStorage.clear();
    // Last launch was in A.
    localStorage.setItem("crs.lastLaunchProjectId", "1");
    useDashboardStore.setState({
      projects: [A, B],
      sessions: [makeSession({ id: 9, projectId: 2, status: "active" })],
      workspaces: [],
      settings: DEFAULT_SETTINGS,
      activePanelId: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useDashboardStore.setState({ activePanelId: null });
  });

  const renderGlobal = (onOpenBrowser = vi.fn()) =>
    render(
      <CommandPalette
        scope="global"
        projectId={null}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenFileEditor={vi.fn()}
        onOpenExternalFile={vi.fn()}
        onOpenProjectBriefing={vi.fn()}
        onOpenProjectSetup={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={onOpenBrowser}
        onOpenBlankBrowser={vi.fn()}
        onOpenSettingsSection={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

  const target = () => screen.getByRole("button", { name: /Target project:/ });

  it("targets the active session's project over the last-launched one", async () => {
    useDashboardStore.setState({ activePanelId: "session-9" });
    renderGlobal();
    expect(target()).toHaveTextContent("beta-project");
  });

  it("falls back to the last-launched project with no active pane", async () => {
    renderGlobal();
    expect(target()).toHaveTextContent("alpha-project");
  });

  it("falls back to the last-launched project when the active session is killed", async () => {
    useDashboardStore.setState({
      sessions: [makeSession({ id: 9, projectId: 2, status: "killed" })],
      activePanelId: "session-9",
    });
    renderGlobal();
    expect(target()).toHaveTextContent("alpha-project");
  });

  it("targets a project-scoped panel's project (github-<id>)", async () => {
    useDashboardStore.setState({ activePanelId: "github-2" });
    renderGlobal();
    expect(target()).toHaveTextContent("beta-project");
  });

  it("runs the Preview command against the active session's project", async () => {
    const onOpenBrowser = vi.fn();
    const user = userEvent.setup();
    useDashboardStore.setState({ activePanelId: "session-9" });
    renderGlobal(onOpenBrowser);
    await user.type(await screen.findByPlaceholderText(/Run a command/), "preview");
    await user.click(await screen.findByText(/^Preview$/));
    expect(onOpenBrowser).toHaveBeenCalledWith(2);
  });
});
