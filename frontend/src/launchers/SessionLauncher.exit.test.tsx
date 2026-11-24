// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionLauncherHost } from "./SessionLauncher.js";
import { DEFAULT_SETTINGS } from "../api/index.js";
import type { Launcher, Project } from "../api/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { mockFetch } from "../test/mockFetch.js";
import { resetStore } from "../test/resetStore.js";
import { useDashboardStore } from "../store/index.js";
import { installExitAnimations } from "../test/exitAnimations.js";
import type { ExitAnimations } from "../test/exitAnimations.js";

// #3037 — the desktop launcher dialog sits in a <Presence>: a launch closes
// it at once and its exit plays after. Kept apart from SessionLauncher.test.tsx,
// which is at its size ceiling.

const PROJECT = {
  id: 5,
  name: "mullion",
  cwd: "/home/x/mullion",
  hostId: "local",
  placement: "pinned",
  hostCwds: {},
} as unknown as Project;
const CLAUDE: Launcher = { id: "agent:claude", kind: "agent", title: "claude", command: "claude" };

let unexpectedCalls: string[] = [];
let exits: ExitAnimations;

function stubFetch() {
  const empty = () => jsonResponse(200, []);
  const result = mockFetch({
    "GET /api/projects/:id/actions": () => jsonResponse(200, [CLAUDE]),
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
      return jsonResponse(201, { id: 42, projectId: PROJECT.id, command: body.command });
    },
  });
  unexpectedCalls = result.unexpectedCalls;
  vi.stubGlobal("fetch", result.fetchMock);
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
  exits = installExitAnimations();
});

afterEach(() => {
  exits.restore();
  vi.unstubAllGlobals();
  expect(unexpectedCalls).toEqual([]);
  unexpectedCalls = [];
});

describe("SessionLauncher — desktop dialog exit", () => {
  // The launch does not wait for the exit, and the focus restore stays
  // suppressed: the new terminal takes focus, not the trigger.
  it("launches at once and then plays the dialog's exit, without restoring focus to the trigger", async () => {
    stubFetch();
    const onLaunched = vi.fn();
    render(
      <>
        <button type="button">trigger</button>
        <SessionLauncherHost
          panels={[]}
          phone={false}
          onLaunched={onLaunched}
          onOpenSession={vi.fn()}
        />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "trigger" });
    trigger.focus();
    act(() => useDashboardStore.getState().openLauncher());
    await userEvent.setup().click(await screen.findByRole("button", { name: "Launch claude" }));

    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
    expect(useDashboardStore.getState().launcherRequest).toBeNull();
    expect(document.querySelector(".create-modal-backdrop")).toHaveAttribute(
      "data-presence",
      "leaving",
    );
    expect(trigger).not.toHaveFocus();
    await exits.finishExits();
    expect(document.querySelector(".create-modal-backdrop")).not.toBeInTheDocument();
    expect(trigger).not.toHaveFocus();
  });
});
