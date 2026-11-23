// @vitest-environment jsdom
// #3058 — the Model choice for a custom launcher that runs an agent. Split out
// of SessionLauncher.test.tsx, which is at its line ceiling. The plain-shell
// case ("launches a shell on click, with no options") stays there.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionLauncherHost } from "./SessionLauncher.js";
import { DEFAULT_SETTINGS } from "../api/index.js";
import type { Launcher } from "../api/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { mockFetch } from "../test/mockFetch.js";
import { makeProject } from "../test/fixtures.js";
import { resetStore } from "../test/resetStore.js";
import { pickDropdownOption } from "../test/dropdown.js";
import { useDashboardStore } from "../store/index.js";

const PROJECT = makeProject({ id: 5, name: "mullion", cwd: "/home/x/mullion" });
const CLAUDE: Launcher = { id: "agent:claude", kind: "agent", title: "claude", command: "claude" };
const custom = (title: string, command: string): Launcher => ({
  id: `custom:${title}`,
  kind: "custom",
  title,
  command,
});

let unexpectedCalls: string[] = [];

function setup(launchers: Launcher[]) {
  const onCreateSession = vi.fn();
  const empty = () => jsonResponse(200, []);
  const result = mockFetch({
    "GET /api/projects/:id/actions": () => jsonResponse(200, launchers),
    "GET /api/projects/:id/git-branches": () => new Response(null, { status: 204 }),
    "GET /api/projects/discover": empty,
    "GET /api/codex/models": empty,
    "GET /api/agy/models": empty,
    "GET /api/opencode/models": empty,
    "GET /api/mcode/models": empty,
    "GET /api/sessions": empty,
    "GET /api/groups": empty,
    "POST /api/sessions": ({ init }) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      onCreateSession(body);
      return jsonResponse(201, { id: 42, projectId: PROJECT.id, command: body.command });
    },
  });
  unexpectedCalls = result.unexpectedCalls;
  vi.stubGlobal("fetch", result.fetchMock);
  render(
    <SessionLauncherHost panels={[]} phone={false} onLaunched={vi.fn()} onOpenSession={vi.fn()} />,
  );
  act(() => useDashboardStore.getState().openLauncher());
  return onCreateSession;
}

beforeEach(() => {
  localStorage.clear();
  resetStore({
    projects: [PROJECT],
    sessions: [],
    settings: DEFAULT_SETTINGS,
    viewMode: "list",
    activePanelId: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  expect(unexpectedCalls).toEqual([]);
  unexpectedCalls = [];
});

describe("SessionLauncher — Model choice for a custom launcher (#3058)", () => {
  it("a `claude --foo` row is selected on click and launches with the picked model", async () => {
    const onCreateSession = setup([CLAUDE, custom("my-claude", "claude --foo")]);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /^my-claude/ }));
    expect(onCreateSession).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^my-claude/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    pickDropdownOption(
      await screen.findByRole("combobox", { name: "Model for this session" }),
      "opusplan",
    );
    await user.click(screen.getByRole("button", { name: "Launch my-claude" }));

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ command: "claude --foo", model: "opusplan" }),
    );
  });

  it("a `claude --model opus` row shows no Model choice and launches on click, without a model", async () => {
    const onCreateSession = setup([CLAUDE, custom("pinned", "claude --model opus")]);
    const user = userEvent.setup();

    // A model picked for the claude tile must not leak into the pinned row.
    pickDropdownOption(
      await screen.findByRole("combobox", { name: "Model for this session" }),
      "opusplan",
    );
    await user.click(screen.getByRole("button", { name: /^pinned/ }));

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    const body = onCreateSession.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.command).toBe("claude --model opus");
    expect(body).not.toHaveProperty("model");
    expect(screen.queryByRole("combobox", { name: "Model for this session" })).toBeNull();
  });

  it("Enter on a focused model row selects it, and Enter again launches it with the picked model", async () => {
    const onCreateSession = setup([CLAUDE, custom("my-claude", "claude --foo")]);
    const user = userEvent.setup();

    const row = await screen.findByRole("button", { name: /^my-claude/ });
    row.focus();
    await user.keyboard("{Enter}");
    expect(onCreateSession).not.toHaveBeenCalled();
    expect(row).toHaveAttribute("aria-current", "true");

    pickDropdownOption(
      await screen.findByRole("combobox", { name: "Model for this session" }),
      "opusplan",
    );
    row.focus();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ command: "claude --foo", model: "opusplan" }),
    );
  });
});
