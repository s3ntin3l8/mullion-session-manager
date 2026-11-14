// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionLauncherHost } from "./SessionLauncher.js";
import { DEFAULT_SETTINGS } from "../api/index.js";
import type { AppSettings, Launcher, Project } from "../api/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { makeSession } from "../test/fixtures.js";
import { resetStore } from "../test/resetStore.js";
import { useDashboardStore } from "../store/index.js";

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
const OTHER: Project = { ...PROJECT, id: 6, name: "runway", cwd: "/home/x/runway" };

const CLAUDE: Launcher = { id: "agent:claude", kind: "agent", title: "claude", command: "claude" };
const CODEX: Launcher = { id: "agent:codex", kind: "agent", title: "codex", command: "codex" };
const BASH: Launcher = { id: "shell:bash", kind: "shell", title: "bash", command: "bash" };
const DEV: Launcher = {
  id: "npm:dev",
  kind: "npm-script",
  title: "dev",
  command: "npm run dev",
};

function withSkip(skipPermissionsAgents: string[]): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    launchers: { ...DEFAULT_SETTINGS.launchers, skipPermissionsAgents },
  };
}

function mockFetch(
  opts: {
    launchers?: Launcher[];
    onCreateSession?: (body: Record<string, unknown>) => void;
    failCreate?: boolean;
  } = {},
) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/actions"))
      return Promise.resolve(jsonResponse(200, opts.launchers ?? [CLAUDE, CODEX, BASH, DEV]));
    if (url.endsWith("/models")) return Promise.resolve(jsonResponse(200, []));
    if (url.endsWith("/api/sessions") && init?.method === "POST") {
      if (opts.failCreate) {
        return Promise.resolve(jsonResponse(503, { message: "Host is unreachable" }));
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      opts.onCreateSession?.(body);
      return Promise.resolve(
        jsonResponse(201, {
          id: 42,
          projectId: PROJECT.id,
          command: body.command,
          status: "active",
        }),
      );
    }
    if (url.startsWith("/api/sessions")) return Promise.resolve(jsonResponse(200, []));
    return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
  });
}

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

function renderHost(overrides: { onLaunched?: () => void; onOpenSession?: () => void } = {}) {
  const onLaunched = overrides.onLaunched ?? vi.fn();
  const onOpenSession = overrides.onOpenSession ?? vi.fn();
  const utils = render(
    <>
      <button type="button">trigger</button>
      <SessionLauncherHost
        panels={[]}
        phone={false}
        onLaunched={onLaunched}
        onOpenSession={onOpenSession}
      />
    </>,
  );
  return { ...utils, onLaunched, onOpenSession };
}

function openLauncher(target?: { half?: "left" | "right" }) {
  act(() => useDashboardStore.getState().openLauncher(target));
}

beforeEach(() => {
  resetStore({
    projects: [PROJECT, OTHER],
    sessions: [],
    settings: DEFAULT_SETTINGS,
    viewMode: "list",
    activePanelId: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SessionLauncher — desktop dialog", () => {
  it("shows Where, agents as a radio group, and shells and scripts as a list — no tabs", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderHost();
    openLauncher();

    const dialog = await screen.findByRole("dialog", { name: "New session" });
    expect(within(dialog).getByRole("combobox", { name: "Project" })).toBeInTheDocument();
    expect(within(dialog).getByText("Isolate in a new worktree")).toBeInTheDocument();
    const group = await within(dialog).findByRole("radiogroup", { name: "Agent" });
    const tiles = within(group).getAllByRole("radio");
    expect(tiles.map((t) => t.textContent)).toEqual(["claude", "codex"]);
    // The default agent (settings.launchers.defaultAgent = claude) starts selected.
    expect(within(group).getByRole("radio", { name: /claude/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(within(dialog).getByRole("button", { name: /bash/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /dev/ })).toBeInTheDocument();
    // Open existing is touch-only.
    expect(within(dialog).queryByRole("tablist")).toBeNull();
    expect(within(dialog).queryByText("Open existing")).toBeNull();
  });

  it("does not open outside a workspace view, and does not pop up on the way back", () => {
    vi.stubGlobal("fetch", mockFetch());
    useDashboardStore.setState({ viewMode: "kanban" });
    renderHost();
    openLauncher();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useDashboardStore.getState().launcherRequest).toBeNull();
    act(() => useDashboardStore.setState({ viewMode: "list" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("launches an agent with a non-default model and passes the target through", async () => {
    const onCreateSession = vi.fn();
    vi.stubGlobal("fetch", mockFetch({ onCreateSession }));
    const user = userEvent.setup();
    const { onLaunched } = renderHost();
    openLauncher({ half: "right" });

    const model = await screen.findByRole("combobox", { name: "Model for this session" });
    await user.selectOptions(model, "opusplan");
    await user.click(screen.getByRole("button", { name: "Launch claude" }));

    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ command: "claude", model: "opusplan", skipPermissions: false }),
    );
    expect(onLaunched).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }), {
      half: "right",
    });
    expect(useDashboardStore.getState().launcherRequest).toBeNull();
  });

  it("does not carry a model picked for one agent over to another", async () => {
    const onCreateSession = vi.fn();
    vi.stubGlobal("fetch", mockFetch({ onCreateSession }));
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Model for this session" }),
      "opusplan",
    );
    await user.click(screen.getByRole("radio", { name: /codex/ }));
    await user.click(screen.getByRole("button", { name: "Launch codex" }));

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession.mock.calls[0]![0]).not.toHaveProperty("model");
  });

  it("launches a shell on click, with no options", async () => {
    const onCreateSession = vi.fn();
    vi.stubGlobal("fetch", mockFetch({ onCreateSession }));
    const user = userEvent.setup();
    const { onLaunched } = renderHost();
    openLauncher();

    await user.click(await screen.findByRole("button", { name: /bash/ }));

    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
    const body = onCreateSession.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.command).toBe("bash");
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("skipPermissions");
  });

  it("shows a failed launch inline and stays open", async () => {
    vi.stubGlobal("fetch", mockFetch({ failCreate: true }));
    const user = userEvent.setup();
    const { onLaunched } = renderHost();
    openLauncher();

    await user.click(await screen.findByRole("button", { name: "Launch claude" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/unreachable/i);
    expect(onLaunched).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "New session" })).toBeInTheDocument();
    expect(useDashboardStore.getState().launcherRequest).not.toBeNull();
    // The in-flight guard resets: the launch can be retried. Focus stayed on
    // the button (it is never `disabled`), so Tab and Escape still work.
    const launchButton = screen.getByRole("button", { name: "Launch claude" });
    expect(launchButton).toBeEnabled();
    expect(launchButton).not.toHaveAttribute("aria-disabled");
    expect(launchButton).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(useDashboardStore.getState().launcherRequest).toBeNull();
  });

  it("a launch that outlives its launcher does not close one opened after it", async () => {
    let resolveCreate: (() => void) | null = null;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/actions")) return Promise.resolve(jsonResponse(200, [CLAUDE, BASH]));
      if (url.endsWith("/models")) return Promise.resolve(jsonResponse(200, []));
      if (url.endsWith("/api/sessions") && init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          resolveCreate = () =>
            resolve(
              jsonResponse(201, {
                id: 42,
                projectId: PROJECT.id,
                command: "claude",
                status: "active",
              }),
            );
        });
      }
      if (url.startsWith("/api/sessions")) return Promise.resolve(jsonResponse(200, []));
      return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { onLaunched } = renderHost();
    openLauncher();

    await user.click(await screen.findByRole("button", { name: "Launch claude" }));
    await waitFor(() => expect(resolveCreate).not.toBeNull());
    await user.keyboard("{Escape}");
    openLauncher();
    await screen.findByRole("dialog", { name: "New session" });

    await act(async () => resolveCreate!());
    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
    expect(useDashboardStore.getState().launcherRequest).not.toBeNull();
    expect(screen.getByRole("dialog", { name: "New session" })).toBeInTheDocument();
  });
});

describe("SessionLauncher — skip permissions", () => {
  it("off in settings: the switch starts off, launches off, and the override turns it on", async () => {
    const onCreateSession = vi.fn();
    vi.stubGlobal("fetch", mockFetch({ onCreateSession }));
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    const toggle = await screen.findByRole("switch", { name: "Skip permission prompts" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAccessibleDescription("Off in settings for claude");
    // No settings flag on the tile.
    expect(screen.getByRole("radio", { name: "claude" })).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAccessibleDescription("For this session only (off in settings)");
    await user.click(screen.getByRole("button", { name: "Launch claude" }));

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ skipPermissions: true }),
    );
  });

  it("off in settings and left alone: launches with prompts", async () => {
    const onCreateSession = vi.fn();
    vi.stubGlobal("fetch", mockFetch({ onCreateSession }));
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    await user.click(await screen.findByRole("button", { name: "Launch claude" }));
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ skipPermissions: false }),
    );
  });

  it("on in settings: the tile is flagged, the switch starts on, and the override turns it off", async () => {
    useDashboardStore.setState({ settings: withSkip(["claude"]) });
    const onCreateSession = vi.fn();
    vi.stubGlobal("fetch", mockFetch({ onCreateSession }));
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    expect(
      await screen.findByRole("radio", {
        name: /claude.*skips permission prompts by settings/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "codex" })).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: "Skip permission prompts" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAccessibleDescription("On in settings for claude");

    await user.click(toggle);
    expect(toggle).toHaveAccessibleDescription("For this session only (on in settings)");
    await user.click(screen.getByRole("button", { name: "Launch claude" }));

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ skipPermissions: false }),
    );
  });

  it("on in settings and left alone: launches skipping prompts", async () => {
    useDashboardStore.setState({ settings: withSkip(["claude"]) });
    const onCreateSession = vi.fn();
    vi.stubGlobal("fetch", mockFetch({ onCreateSession }));
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    await user.click(await screen.findByRole("button", { name: "Launch claude" }));
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ skipPermissions: true }),
    );
  });

  it("an override applies to the agent it was set on only", async () => {
    const onCreateSession = vi.fn();
    vi.stubGlobal("fetch", mockFetch({ onCreateSession }));
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    await user.click(await screen.findByRole("switch", { name: "Skip permission prompts" }));
    await user.click(screen.getByRole("radio", { name: "codex" }));
    const toggle = screen.getByRole("switch", { name: "Skip permission prompts" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAccessibleDescription("Off in settings for codex");
    await user.click(screen.getByRole("button", { name: "Launch codex" }));

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ command: "codex", skipPermissions: false }),
    );
  });
});

describe("SessionLauncher — keyboard", () => {
  it("typing filters, Enter launches the selected agent", async () => {
    const onCreateSession = vi.fn();
    vi.stubGlobal("fetch", mockFetch({ onCreateSession }));
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    const filter = await screen.findByRole("textbox", {
      name: "Filter agents, shells and scripts",
    });
    await screen.findByRole("radiogroup", { name: "Agent" });
    expect(filter).toHaveFocus();
    await user.keyboard("cod");
    expect(screen.queryByRole("radio", { name: "claude" })).toBeNull();
    expect(screen.getByRole("radio", { name: "codex" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("button", { name: /bash/ })).toBeNull();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(expect.objectContaining({ command: "codex" }));
  });

  it("Enter launches the first shell or script once no agent matches", async () => {
    const onCreateSession = vi.fn();
    vi.stubGlobal("fetch", mockFetch({ onCreateSession }));
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    await screen.findByRole("radiogroup", { name: "Agent" });
    await user.keyboard("npm{Enter}");

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ command: "npm run dev" }),
    );
  });

  it("arrow keys move through the tiles and on into the list", async () => {
    const onCreateSession = vi.fn();
    vi.stubGlobal("fetch", mockFetch({ onCreateSession }));
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    await screen.findByRole("radiogroup", { name: "Agent" });
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: "claude" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    const codex = screen.getByRole("radio", { name: "codex" });
    expect(codex).toHaveFocus();
    expect(codex).toHaveAttribute("aria-checked", "true");
    // The options region follows the selection, and says so.
    expect(screen.getByRole("group", { name: "Options for codex" })).toBeInTheDocument();
    expect(screen.getByText(/codex selected/)).toBeInTheDocument();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: /bash/ })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: /dev/ })).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(codex).toHaveFocus();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(expect.objectContaining({ command: "codex" }));
  });

  it("typing on a tile moves to the filter", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    await screen.findByRole("radiogroup", { name: "Agent" });
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: "claude" })).toHaveFocus();
    await user.keyboard("b");
    expect(
      screen.getByRole("textbox", { name: "Filter agents, shells and scripts" }),
    ).toHaveFocus();
  });

  it("Escape closes and returns focus to the trigger", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const user = userEvent.setup();
    renderHost();
    const trigger = screen.getByRole("button", { name: "trigger" });
    trigger.focus();
    openLauncher();

    await screen.findByRole("radiogroup", { name: "Agent" });
    expect(trigger).not.toHaveFocus();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useDashboardStore.getState().launcherRequest).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("a launch does not hand focus back to the trigger", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const user = userEvent.setup();
    const { onLaunched } = renderHost();
    const trigger = screen.getByRole("button", { name: "trigger" });
    trigger.focus();
    openLauncher();

    await user.click(await screen.findByRole("button", { name: "Launch claude" }));
    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).not.toHaveFocus();
  });

  it("switching the project reloads that project's launchers", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/projects/${OTHER.id}/actions`))
        return Promise.resolve(jsonResponse(200, [CODEX]));
      if (url.includes("/actions")) return Promise.resolve(jsonResponse(200, [CLAUDE]));
      if (url.endsWith("/models")) return Promise.resolve(jsonResponse(200, []));
      return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    expect(await screen.findByRole("radio", { name: "claude" })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), String(OTHER.id));
    expect(await screen.findByRole("radio", { name: "codex" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "claude" })).toBeNull();
  });
});

describe("SessionLauncher — touch sheet", () => {
  beforeEach(() => {
    stubCoarsePointer();
  });

  it("has two tabs, New session and Open existing, and no filter field", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    const sheet = await screen.findByRole("dialog", { name: "New session" });
    const tabs = within(sheet).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["New session", "Open existing"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(await within(sheet).findByRole("radiogroup", { name: "Agent" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("textbox")).toBeNull();

    await user.click(tabs[1]!);
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(within(sheet).getByRole("tabpanel")).toHaveTextContent("No sessions yet.");
  });

  it("Open existing lists sessions by project, the project under each title, and opens one", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const docs = makeSession({
      id: 7,
      projectId: PROJECT.id,
      name: "docs cleanup",
      nameLocked: true,
    });
    const importer = makeSession({
      id: 8,
      projectId: OTHER.id,
      name: "importer",
      nameLocked: true,
    });
    useDashboardStore.setState({ sessions: [docs, importer] });
    const user = userEvent.setup();
    const { onOpenSession } = renderHost();
    openLauncher({ half: "left" });

    await user.click(await screen.findByRole("tab", { name: "Open existing" }));
    const panel = screen.getByRole("tabpanel");
    const mullion = within(panel).getByRole("region", { name: "mullion" });
    const runway = within(panel).getByRole("region", { name: "runway" });
    const docsRow = within(mullion).getByRole("button", { name: /docs cleanup/ });
    expect(docsRow).toHaveTextContent("mullion");
    expect(within(runway).getByRole("button", { name: /importer/ })).toHaveTextContent("runway");

    await user.click(docsRow);
    expect(onOpenSession).toHaveBeenCalledWith(docs, { half: "left" });
    expect(useDashboardStore.getState().launcherRequest).toBeNull();
  });

  it("launches an agent from the sheet", async () => {
    const onCreateSession = vi.fn();
    vi.stubGlobal("fetch", mockFetch({ onCreateSession }));
    const user = userEvent.setup();
    const { onLaunched } = renderHost();
    openLauncher();

    await user.click(await screen.findByRole("radio", { name: "codex" }));
    await user.click(screen.getByRole("button", { name: "Launch codex" }));
    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith(expect.objectContaining({ command: "codex" }));
  });

  it("keeps the New session choices across a tab switch", async () => {
    const onCreateSession = vi.fn();
    vi.stubGlobal("fetch", mockFetch({ onCreateSession }));
    const user = userEvent.setup();
    renderHost();
    openLauncher();

    await user.click(await screen.findByRole("radio", { name: "codex" }));
    await user.click(screen.getByRole("tab", { name: "Open existing" }));
    expect(screen.queryByRole("radio", { name: "codex" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "New session" }));
    expect(screen.getByRole("radio", { name: "codex" })).toHaveAttribute("aria-checked", "true");
  });

  it("starts each open on New session", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const user = userEvent.setup();
    renderHost();
    openLauncher();
    await user.click(await screen.findByRole("tab", { name: "Open existing" }));
    act(() => useDashboardStore.getState().closeLauncher());
    openLauncher();
    expect(await screen.findByRole("tab", { name: "New session" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
