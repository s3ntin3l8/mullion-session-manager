// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "./CommandPalette.js";
import { useDashboardStore } from "./store/index.js";
import { DEFAULT_SETTINGS } from "./api/index.js";
import type { Launcher, Project, Session } from "./api/index.js";
import { jsonResponse } from "./test/jsonResponse.js";
import { makeWorkspace } from "./test/fixtures.js";

// Issue #27: the palette's "Integrations" section — a GitHub-panel shortcut
// for the current project plus a link into Settings -> Integrations.

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
  mergeOnApprove: null,
  autoApprove: null,
  maxAutoReturnRounds: null,
  conventionalCommitTitles: null,
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
        onLaunched={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenGitHub={onOpenGitHub}
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

    await user.click(await screen.findByText(/GitHub: mullion/));
    expect(onOpenGitHub).toHaveBeenCalledWith(PROJECT.id);
  });

  it("opens the git status panel for the current project (issue #76)", async () => {
    const onOpenGit = vi.fn();
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
        onOpenGit={onOpenGit}
        onOpenAgentRules={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenIntegrationsSettings={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await user.click(await screen.findByText(/Git: mullion/));
    expect(onOpenGit).toHaveBeenCalledWith(PROJECT.id);
  });

  it("opens the agent-rules editor for the current project (issue #431)", async () => {
    const onOpenAgentRules = vi.fn();
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
        onOpenAgentRules={onOpenAgentRules}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenIntegrationsSettings={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await user.click(await screen.findByText(/Agent Rules: mullion/));
    expect(onOpenAgentRules).toHaveBeenCalledWith(PROJECT.id);
  });

  it("opens the dock-config editor for the current project (U4)", async () => {
    const onOpenDockConfig = vi.fn();
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
        onOpenDockConfig={onOpenDockConfig}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenIntegrationsSettings={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await user.click(await screen.findByText(/Dock: mullion/));
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
        onLaunched={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenGit={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={onOpenSkills}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={vi.fn()}
        onOpenIntegrationsSettings={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await user.click(await screen.findByText(/Skills: mullion/));
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
        onLaunched={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenGit={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={onOpenBrowser}
        onOpenBlankBrowser={vi.fn()}
        onOpenIntegrationsSettings={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await user.click(await screen.findByText(/Preview: mullion/));
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
        onLaunched={vi.fn()}
        onOpenSession={vi.fn()}
        onOpenTasks={vi.fn()}
        onOpenGitHub={vi.fn()}
        onOpenGit={vi.fn()}
        onOpenAgentRules={vi.fn()}
        onOpenDockConfig={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenBlankBrowser={onOpenBlankBrowser}
        onOpenIntegrationsSettings={vi.fn()}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await user.click(await screen.findByText("New preview tab"));
    expect(onOpenBlankBrowser).toHaveBeenCalled();
  });

  it("opens Settings -> Integrations", async () => {
    const onOpenIntegrationsSettings = vi.fn();
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
        onOpenIntegrationsSettings={onOpenIntegrationsSettings}
        onOpenBrowserUrl={vi.fn()}
      />,
    );

    await user.click(await screen.findByText("Manage integrations…"));
    expect(onOpenIntegrationsSettings).toHaveBeenCalled();
  });

  it("hides the Integrations section while mid-search", async () => {
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

    await screen.findByText("Manage integrations…");
    await user.type(screen.getByPlaceholderText(/Launch a session/), "bash");
    expect(screen.queryByText("Manage integrations…")).not.toBeInTheDocument();
  });
});

// P9 — CommandPalette.tsx's session-launch path (createSession) used to be
// `void somePromise.then(...)` with no `.catch` at all: a failure left
// stale/empty UI plus an unhandled rejection in the console, with nothing
// visible to the user. See command-palette/WorktreeOptions.test.tsx's own
// "worktree isolation toggle" and "WorktreeOptions -> P9 silent failures"
// describes for the toggle/branches-fetch half of this same fix, extracted
// there since both exercise <WorktreeOptions> rather than the launch path.
describe("CommandPalette -> P9 silent failures", () => {
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

  it("a failed launch surfaces an inline error and leaves the palette open, rather than a silent unhandled rejection", async () => {
    useDashboardStore.setState({ projects: [PROJECT], sessions: [] });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/actions")) return Promise.resolve(jsonResponse(200, [LAUNCHER]));
      if (url.includes("/urls")) return Promise.resolve(jsonResponse(200, []));
      if (url.endsWith("/api/sessions") && init?.method === "POST") {
        return Promise.resolve(jsonResponse(503, { message: "Host is unreachable" }));
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    const onLaunched = vi.fn();
    const user = userEvent.setup();
    renderPalette({ onClose, onLaunched });

    await user.click((await screen.findAllByText("bash"))[0]);

    expect(await screen.findByText(/unreachable/i)).toBeInTheDocument();
    // The whole point of the fix: a failed launch must NOT close the
    // palette (which would hide the very error it's meant to show) or
    // report a success that never happened.
    expect(onClose).not.toHaveBeenCalled();
    expect(onLaunched).not.toHaveBeenCalled();
  });

  it("a launch can be retried after a failure (the in-flight guard resets on rejection)", async () => {
    useDashboardStore.setState({ projects: [PROJECT], sessions: [] });
    let calls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/actions")) return Promise.resolve(jsonResponse(200, [LAUNCHER]));
      if (url.includes("/urls")) return Promise.resolve(jsonResponse(200, []));
      if (url.endsWith("/api/sessions") && init?.method === "POST") {
        calls += 1;
        if (calls === 1) return Promise.resolve(jsonResponse(503, { message: "unreachable" }));
        return Promise.resolve(
          jsonResponse(201, { id: 1, projectId: PROJECT.id, command: "bash", cwd: null }),
        );
      }
      if (url.startsWith("/api/sessions")) return Promise.resolve(jsonResponse(200, []));
      return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const onLaunched = vi.fn();
    const user = userEvent.setup();
    renderPalette({ onLaunched });

    await user.click((await screen.findAllByText("bash"))[0]);
    await screen.findByText(/unreachable/i);

    await user.click((await screen.findAllByText("bash"))[0]);

    await vi.waitFor(() => expect(onLaunched).toHaveBeenCalled());
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
    expect(screen.getByPlaceholderText("Launch a session or run a command…")).toHaveFocus();
  });

  // Mobile/tablet touch fix — autofocusing the search input on open used to
  // raise the on-screen keyboard immediately, covering the launcher list a
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
    expect(screen.getByPlaceholderText("Launch a session or run a command…")).not.toHaveFocus();
  });

  it("tapping the search box directly still raises the keyboard under a coarse pointer", async () => {
    const user = userEvent.setup();
    stubCoarsePointer();
    renderPalette();
    await screen.findByRole("dialog", { name: "Command palette" });
    const input = screen.getByPlaceholderText("Launch a session or run a command…");

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

    expect(screen.getByPlaceholderText("Launch a session or run a command…")).toHaveFocus();
  });

  it("does not redirect focus to the search input on Escape (the dialog's own close key)", async () => {
    const user = userEvent.setup();
    stubCoarsePointer();
    renderPalette();
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    expect(dialog).toHaveFocus();

    await user.keyboard("{Escape}");

    expect(screen.getByPlaceholderText("Launch a session or run a command…")).not.toHaveFocus();
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
    await screen.findByPlaceholderText("Launch a session or run a command…");
    expect(document.activeElement).not.toBe(trigger);

    // Mirrors App.tsx's conditional mount — closing is a full unmount.
    unmount();
    expect(trigger).toHaveFocus();
  });

  it("does NOT restore focus to the trigger when closing by launching a session (focus belongs to the new pane instead)", async () => {
    render(<button>open palette</button>);
    const trigger = screen.getByText("open palette");
    trigger.focus();

    let resolveCreate: (session: Session) => void = () => {};
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/actions")) return Promise.resolve(jsonResponse(200, [LAUNCHER]));
      if (url.includes("/urls")) return Promise.resolve(jsonResponse(200, []));
      if (url.endsWith("/api/sessions") && init?.method === "POST") {
        return new Promise((resolve) => {
          resolveCreate = (session) => resolve(jsonResponse(201, session));
        });
      }
      // store.createSession refreshes the session list right after — not
      // under test here, so an empty list is fine.
      if (url.startsWith("/api/sessions") && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(jsonResponse(200, []));
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const onClose = vi.fn();
    const onLaunched = vi.fn();
    const user = userEvent.setup();
    const { unmount } = renderPalette({ onClose, onLaunched });

    await user.click((await screen.findAllByText("bash"))[0]);
    resolveCreate({
      id: 1,
      projectId: PROJECT.id,
      command: "bash",
      cwd: null,
    } as Session);
    await vi.waitFor(() => expect(onLaunched).toHaveBeenCalled());

    // App.tsx's real close path is a conditional-mount flip, not a method
    // call on this component — mirror that here so the trap's own
    // restore-on-close cleanup effect actually runs. Without
    // `suppressRestore()` (called by `closeAfterAction` before `onClose`
    // above), this unmount would snap focus back onto `trigger`; with it,
    // focus is left wherever the real app's onOpenSession/onLaunched just
    // put it (a new pane's terminal, per PR13/U7) instead.
    unmount();

    expect(trigger).not.toHaveFocus();
  });

  it("traps Tab within the palette", async () => {
    const user = userEvent.setup();
    const { container } = renderPalette();
    await screen.findAllByText("bash");

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

describe("CommandPalette -> skip-permissions badge and launch precedence", () => {
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

    await screen.findByText("Matching commands");
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

    // opencode has skipPermissions: false in launcher config and is NOT in
    // the global settings list — no badge expected.
    await screen.findByText("Matching commands");
    await userEvent.setup().click(screen.getByPlaceholderText(/Launch a session/));
    await userEvent.setup().clear(screen.getByPlaceholderText(/Launch a session/));
    await userEvent.setup().type(screen.getByPlaceholderText(/Launch a session/), "opencode");
    expect(screen.queryByText("⚠ skip perms")).not.toBeInTheDocument();
  });

  it("does not show skip-perms badge for shells", async () => {
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

    await screen.findByText("Matching commands");
    await userEvent.setup().click(screen.getByPlaceholderText(/Launch a session/));
    await userEvent.setup().clear(screen.getByPlaceholderText(/Launch a session/));
    await userEvent.setup().type(screen.getByPlaceholderText(/Launch a session/), "bash");
    expect(screen.queryByText("⚠ skip perms")).not.toBeInTheDocument();
  });

  it("passes skipPermissions=true when agent is in the global settings list and checkbox is off", async () => {
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

    // claude is in the global settings list; launch without touching the checkbox.
    await screen.findByText("Matching commands");
    await user.click(screen.getByPlaceholderText(/Launch a session/));
    await user.clear(screen.getByPlaceholderText(/Launch a session/));
    await user.type(screen.getByPlaceholderText(/Launch a session/), "claude");
    await user.click((await screen.findAllByText("claude"))[0]);

    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ skipPermissions: true }),
    );
  });

  it("passes skipPermissions=false when agent has skipPermissions:false in launcher config even if in global list", async () => {
    // Set opencode in the global list too, but its launcher config says false.
    useDashboardStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        launchers: {
          ...DEFAULT_SETTINGS.launchers,
          skipPermissionsAgents: ["claude", "opencode"],
        },
      },
    });
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

    await screen.findByText("Matching commands");
    await user.click(screen.getByPlaceholderText(/Launch a session/));
    await user.clear(screen.getByPlaceholderText(/Launch a session/));
    await user.type(screen.getByPlaceholderText(/Launch a session/), "opencode");
    await user.click((await screen.findAllByText("opencode"))[0]);

    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ skipPermissions: false }),
    );
  });

  it("keeps the options-strip in the DOM when a non-agent launcher is selected (visibility:hidden)", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
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

    await screen.findByText("Matching commands");

    // bash is a shell — the options-strip still renders (visibility:hidden).
    // The toggle text must be in the DOM even when the selected launcher
    // is not an agent, so the launcher list never shifts.
    await user.click(screen.getByPlaceholderText(/Launch a session/));
    await user.clear(screen.getByPlaceholderText(/Launch a session/));
    await user.type(screen.getByPlaceholderText(/Launch a session/), "bash");
    expect(screen.getByText("Skip permissions (all agents)")).toBeInTheDocument();
  });

  it("uses the override checkbox when launching and sends skipPermissions:true", async () => {
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

    await screen.findByText("Matching commands");

    // Check the "Skip permissions (all agents)" override checkbox.
    const checkbox = screen.getByRole("checkbox", {
      name: /Skip permissions \(all agents\)/i,
    });
    await user.click(checkbox);

    // Launch opencode (skipPermissions:false in launcher config, not in
    // global list). The override checkbox should win, sending true.
    await user.click(screen.getByPlaceholderText(/Launch a session/));
    await user.clear(screen.getByPlaceholderText(/Launch a session/));
    await user.type(screen.getByPlaceholderText(/Launch a session/), "opencode");
    await user.click((await screen.findAllByText("opencode"))[0]);

    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ skipPermissions: true }),
    );
  });
});

// U2 (audit finding: "⌘K is a launcher, not a switcher") — the Sessions and
// Workspaces result groups, plus the flattened keyboard nav across all three
// groups (Sessions -> Workspaces -> Matching commands).
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
      kind: "terminal",
      status: "active",
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
            status: "active",
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
    const onLaunched = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        scope="project"
        projectId={PROJECT.id}
        onClose={vi.fn()}
        onLaunched={onLaunched}
        onOpenSession={onOpenSession}
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

    await screen.findByText("Matching commands");
    await user.type(screen.getByPlaceholderText(/Launch a session/), "hotfix");

    expect(await screen.findByText("Sessions")).toBeInTheDocument();
    // Matched on the session's own name plus its project and branch — same
    // precedence the CommandPalette.tsx matchingSessions comment documents.
    await user.click(screen.getByText("hotfix runner"));

    expect(onOpenSession).toHaveBeenCalledWith(session);
    // The whole point of this group: it opens the EXISTING pane, it never
    // goes through the create-a-new-session path.
    expect(onLaunched).not.toHaveBeenCalled();
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

    await screen.findByText("Matching commands");
    await user.type(screen.getByPlaceholderText(/Launch a session/), "match");

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

    await screen.findByText("Matching commands");
    await user.type(screen.getByPlaceholderText(/Launch a session/), "match");

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

    await screen.findByText("Matching commands");
    await user.type(screen.getByPlaceholderText(/Launch a session/), "match");

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

    await screen.findByText("Matching commands");
    await user.type(screen.getByPlaceholderText(/Launch a session/), "release");

    expect(await screen.findByText("Workspaces")).toBeInTheDocument();
    await user.click(screen.getByText("Release train"));

    expect(useDashboardStore.getState().activeWorkspaceId).toBe(9);
    expect(useDashboardStore.getState().viewMode).toBe("list");
    expect(onClose).toHaveBeenCalled();
  });

  it("arrow-keys and Enter navigate Sessions -> Workspaces -> Matching commands as one flattened list", async () => {
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
        onLaunched={vi.fn()}
        onOpenSession={onOpenSession}
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

    await screen.findByText("Matching commands");
    // Matches all three groups: the session/workspace names both contain
    // "bash", and "bash" is also the shell launcher's own title.
    await user.type(screen.getByPlaceholderText(/Launch a session/), "bash");
    await screen.findByText("bashful session");
    await screen.findByText("bashful workspace");

    // Typing resets selection to index 0 -> the first Sessions row is
    // highlighted by default. Two ArrowDowns walk Sessions -> Workspaces ->
    // Matching commands (one flattened index across all three groups), then
    // Enter should launch the bash command, not reopen the session or
    // switch the workspace.
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");

    expect(onCreateSession).toHaveBeenCalledWith(expect.objectContaining({ command: "bash" }));
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
        onLaunched={vi.fn()}
        onOpenSession={onOpenSession}
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

    await screen.findByText("Matching commands");
    await user.type(screen.getByPlaceholderText(/Launch a session/), "bash");
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
        onLaunched={vi.fn()}
        onOpenSession={onOpenSession}
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

    await screen.findByText("Matching commands");
    await user.type(screen.getByPlaceholderText(/Launch a session/), "bash");
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

    await screen.findByText("Matching commands");

    expect(screen.queryByText("Sessions")).not.toBeInTheDocument();
    expect(screen.queryByText("Workspaces")).not.toBeInTheDocument();
    expect(screen.queryByText("idle session")).not.toBeInTheDocument();
    expect(screen.queryByText("idle workspace")).not.toBeInTheDocument();
  });
});
