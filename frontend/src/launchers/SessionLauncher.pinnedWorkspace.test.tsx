// @vitest-environment jsdom
//
// #3537 on the phone: the launcher sends a new session to a workspace its
// project is pinned to, and to the active one for a project pinned nowhere.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionLauncherHost } from "./SessionLauncher.js";
import { defaultLaunchWorkspaceId } from "./workspaceOptions.js";
import { DEFAULT_SETTINGS } from "../api/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { mockFetch } from "../test/mockFetch.js";
import { makeProject, makeWorkspace } from "../test/fixtures.js";
import { resetStore } from "../test/resetStore.js";
import { useDashboardStore } from "../store/index.js";

describe("defaultLaunchWorkspaceId", () => {
  const ws = (id: number, pinnedProjectIds: number[] = []) => ({ id, pinnedProjectIds });

  it("is the active workspace for a project pinned nowhere, or no project", () => {
    expect(defaultLaunchWorkspaceId([ws(1), ws(2, [9])], 1, 5)).toBe(1);
    expect(defaultLaunchWorkspaceId([ws(1), ws(2, [5])], 1, null)).toBe(1);
    expect(defaultLaunchWorkspaceId([], null, 5)).toBeNull();
  });

  it("is the workspace the project is pinned to", () => {
    expect(defaultLaunchWorkspaceId([ws(1), ws(2, [5])], 1, 5)).toBe(2);
    // No active workspace yet: still the pinned one.
    expect(defaultLaunchWorkspaceId([ws(1), ws(2, [5])], null, 5)).toBe(2);
  });

  it("stays in the active workspace when the project is pinned there too", () => {
    expect(defaultLaunchWorkspaceId([ws(2, [5]), ws(1, [5])], 1, 5)).toBe(1);
  });

  it("takes the first in the list when the project is pinned to several others", () => {
    expect(defaultLaunchWorkspaceId([ws(1), ws(3, [5]), ws(2, [5])], 1, 5)).toBe(3);
  });

  it("reads a workspace that carries no pins (an older server) as unpinned", () => {
    const old = { id: 2 } as unknown as { id: number; pinnedProjectIds: number[] };
    expect(defaultLaunchWorkspaceId([ws(1), old], 1, 5)).toBe(1);
  });
});

describe("SessionLauncher — a project pinned to a workspace (phone)", () => {
  const PROJECT = makeProject({ id: 5, name: "mullion" });
  const A = makeWorkspace({ id: 1, name: "Default" });
  const B = makeWorkspace({ id: 2, name: "Review" });
  let unexpectedCalls: string[] = [];

  function renderHost(phone: boolean) {
    const onLaunched = vi.fn();
    render(
      <SessionLauncherHost
        panels={[]}
        phone={phone}
        onLaunched={onLaunched}
        onOpenSession={vi.fn()}
      />,
    );
    act(() => useDashboardStore.getState().openLauncher());
    return onLaunched;
  }
  const launchBash = async (onLaunched: ReturnType<typeof vi.fn>) => {
    await userEvent.click(await screen.findByRole("button", { name: /bash/ }));
    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
  };
  const row = () => screen.findByRole("combobox", { name: "Workspace" });

  beforeEach(() => {
    localStorage.clear();
    resetStore({
      projects: [PROJECT],
      sessions: [],
      settings: DEFAULT_SETTINGS,
      viewMode: "list",
      activePanelId: null,
      workspaces: [A, { ...B, pinnedProjectIds: [PROJECT.id] }],
      groups: [],
      activeWorkspaceId: A.id,
    } as never);
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(pointer: coarse)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const empty = () => jsonResponse(200, []);
    const result = mockFetch({
      "GET /api/projects/:id/actions": () =>
        jsonResponse(200, [
          { id: "agent:claude", kind: "agent", title: "claude", command: "claude" },
          { id: "shell:bash", kind: "shell", title: "bash", command: "bash" },
        ]),
      "GET /api/projects/:id/git-branches": () => new Response(null, { status: 204 }),
      "GET /api/projects/discover": empty,
      "GET /api/codex/models": empty,
      "GET /api/agy/models": empty,
      "GET /api/opencode/models": empty,
      "GET /api/mcode/models": empty,
      "GET /api/sessions": empty,
      "GET /api/groups": empty,
      "POST /api/sessions": () =>
        jsonResponse(201, { id: 42, projectId: PROJECT.id, command: "bash", status: "active" }),
    });
    unexpectedCalls = result.unexpectedCalls;
    vi.stubGlobal("fetch", result.fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    expect(unexpectedCalls).toEqual([]);
  });

  it("preselects that workspace, and a launch joins it", async () => {
    const onLaunched = renderHost(true);
    expect(await row()).toHaveValue(String(B.id));
    await launchBash(onLaunched);
    expect(onLaunched).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }), null, B.id);
  });

  it("keeps a workspace picked in the row over the pin", async () => {
    const onLaunched = renderHost(true);
    await userEvent.selectOptions(await row(), String(A.id));
    await launchBash(onLaunched);
    expect(onLaunched).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }), null, null);
  });

  it("launches into the active workspace when the project is not pinned", async () => {
    useDashboardStore.setState({ workspaces: [A, B] });
    const onLaunched = renderHost(true);
    expect(await row()).toHaveValue(String(A.id));
    await launchBash(onLaunched);
    expect(onLaunched).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }), null, null);
  });

  it("does not move a launch off the phone, which has no Workspace row", async () => {
    const onLaunched = renderHost(false);
    await launchBash(onLaunched);
    expect(screen.queryByRole("combobox", { name: "Workspace" })).toBeNull();
    expect(onLaunched).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }), null, null);
  });
});
