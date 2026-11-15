// @vitest-environment jsdom
// #3054 — the keyboard path from the command palette to a running session,
// with both real components mounted: Enter on a palette entry opens the
// launcher on it (the palette itself creates nothing), Launch has focus, and
// a second Enter launches exactly that entry.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "../CommandPalette.js";
import { SessionLauncherHost } from "./SessionLauncher.js";
import { DEFAULT_SETTINGS } from "../api/index.js";
import type { Launcher } from "../api/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { mockFetch } from "../test/mockFetch.js";
import { makeProject } from "../test/fixtures.js";
import { resetStore } from "../test/resetStore.js";
import { useDashboardStore } from "../store/index.js";

const PROJECT = makeProject({ id: 5, name: "mullion" });
const CLAUDE: Launcher = { id: "agent:claude", kind: "agent", title: "claude", command: "claude" };
const CODEX: Launcher = { id: "agent:codex", kind: "agent", title: "codex", command: "codex" };
const BASH: Launcher = { id: "shell:bash", kind: "shell", title: "bash", command: "bash" };

let unexpectedCalls: string[] = [];
let created: Array<Record<string, unknown>> = [];

// App's shape: the palette mounts while open; the launcher host always.
function Harness({ onLaunched }: { onLaunched: () => void }) {
  const [paletteOpen, setPaletteOpen] = useState(true);
  return (
    <>
      {paletteOpen && (
        <CommandPalette
          scope="global"
          projectId={null}
          onClose={() => setPaletteOpen(false)}
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
        />
      )}
      <SessionLauncherHost
        panels={[]}
        phone={false}
        onLaunched={onLaunched}
        onOpenSession={vi.fn()}
      />
    </>
  );
}

beforeEach(() => {
  localStorage.clear();
  created = [];
  resetStore({
    projects: [PROJECT],
    sessions: [],
    settings: DEFAULT_SETTINGS,
    viewMode: "list",
    activePanelId: null,
  });
  const empty = () => jsonResponse(200, []);
  const result = mockFetch({
    "GET /api/projects/:id/actions": () => jsonResponse(200, [CLAUDE, CODEX, BASH]),
    "GET /api/projects/:id/urls": empty,
    "GET /api/codex/models": empty,
    "GET /api/agy/models": empty,
    "GET /api/opencode/models": empty,
    "GET /api/mcode/models": empty,
    "GET /api/sessions": empty,
    "POST /api/sessions": ({ init }) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      created.push(body);
      return jsonResponse(201, {
        id: 42,
        projectId: PROJECT.id,
        command: body.command,
        status: "active",
      });
    },
  });
  unexpectedCalls = result.unexpectedCalls;
  vi.stubGlobal("fetch", result.fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  expect(unexpectedCalls).toEqual([]);
});

describe("palette to launcher, by keyboard (#3054)", () => {
  it.each([
    ["an agent", "codex", "Launch codex", "codex"],
    ["a shell", "bash", "Launch bash", "bash"],
  ])(
    "Enter on %s opens the launcher; Enter there launches it",
    async (_kind, query, button, command) => {
      const onLaunched = vi.fn();
      const user = userEvent.setup();
      render(<Harness onLaunched={onLaunched} />);

      const search = await screen.findByPlaceholderText(/Run a command/);
      // The palette lists an agent or shell only once its name is typed.
      await user.type(search, query);
      await screen.findAllByText(query);
      await user.keyboard("{Enter}");

      expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
      expect(created).toEqual([]);
      const launch = await screen.findByRole("button", { name: button });
      await waitFor(() => expect(launch).toHaveFocus());
      await user.keyboard("{Enter}");

      await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ command });
      expect(useDashboardStore.getState().launcherRequest).toBeNull();
    },
  );
});
