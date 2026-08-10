// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "./CommandPalette.js";
import { useDashboardStore } from "./store.js";
import { DEFAULT_SETTINGS } from "./api.js";
import type { Launcher, Project, Session, Workspace } from "./api.js";

// Issue #27: the palette's "Integrations" section — a GitHub-panel shortcut
// for the current project plus a link into Settings -> Integrations.

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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

// Issue #271, option 1 — the launcher's opt-in "isolate this session" toggle.
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

  function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
    return {
      id: 1,
      name: "Default",
      groupId: null,
      position: 0,
      layout: null,
      createdAt: "2026-01-01T00:00:00.000Z",
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

  it("surfaces a matching workspace and switches to it on click", async () => {
    const workspace = makeWorkspace({ id: 9, name: "Release train" });
    useDashboardStore.setState({
      projects: [PROJECT],
      sessions: [],
      workspaces: [workspace],
      activeWorkspaceId: null,
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
