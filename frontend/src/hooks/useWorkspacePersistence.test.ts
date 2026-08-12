// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useWorkspacePersistence } from "./useWorkspacePersistence.js";
import type { DockviewApi } from "dockview-react";
import type { Workspace } from "../api/index.js";

// Mirrors Sidebar.test.tsx's own store-mock shape (a `storeState()` factory
// serving both call forms this hook uses: `useDashboardStore.getState()`
// directly, no selector).
const saveWorkspaceLayout = vi.fn().mockResolvedValue(undefined);
let sessions: Array<{ id: number; status: string }> = [];

function storeState() {
  return { sessions, saveWorkspaceLayout };
}

vi.mock("../store/index.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  };
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

const AUTOSAVE_DEBOUNCE_MS = 800;

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 1,
    name: "Default",
    layout: { some: "layout" },
    groupId: null,
    position: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// A minimal fake DockviewApi covering exactly the surface the restore/
// autosave effects touch: clear/fromJSON/toJSON/getPanel/panels for the
// restore path, groups/hasMaximizedGroup/exitMaximizedGroup/maximizeGroup/
// activePanel for applyMobilePresentation (panelUtils.ts, exercised with
// isMobile: false below so it's a same-state no-op), and onDidLayoutChange
// for the autosave path — `fireLayoutChange` lets a test simulate dockview
// firing that event, the same way fromJSON()'s own panel-mount events or a
// real user edit would.
function makeMockApi() {
  const layoutChangeListeners: Array<() => void> = [];
  const panels = new Map<string, unknown>();
  const api = {
    clear: vi.fn(),
    fromJSON: vi.fn(),
    toJSON: vi.fn(() => ({ panels: {} })),
    getPanel: vi.fn((id: string) => panels.get(id) ?? null),
    get panels() {
      return Array.from(panels.values());
    },
    groups: [],
    hasMaximizedGroup: vi.fn(() => false),
    exitMaximizedGroup: vi.fn(),
    maximizeGroup: vi.fn(),
    activePanel: undefined,
    onDidLayoutChange: vi.fn((cb: () => void) => {
      layoutChangeListeners.push(cb);
      return { dispose: vi.fn() };
    }),
  };
  return {
    api: api as unknown as DockviewApi,
    fireLayoutChange: () => layoutChangeListeners.forEach((cb) => cb()),
  };
}

beforeEach(() => {
  sessions = [];
  saveWorkspaceLayout.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useWorkspacePersistence", () => {
  it("restores the active workspace's saved layout on mount, then clears restoringRef on the next tick", () => {
    vi.useFakeTimers();
    const { api } = makeMockApi();
    const workspace = makeWorkspace();
    const setPanelsVersion = vi.fn();

    const { result } = renderHook(() =>
      useWorkspacePersistence({
        dockviewApi: api,
        activeWorkspaceId: 1,
        workspaces: [workspace],
        isMobile: false,
        setPanelsVersion,
      }),
    );

    expect(api.clear).toHaveBeenCalledTimes(1);
    expect(api.fromJSON).toHaveBeenCalledWith(workspace.layout);
    // Still true synchronously after the effect body runs — only the
    // deferred setTimeout(0) flips it, so a same-tick onDidLayoutChange echo
    // from fromJSON() itself isn't mistaken for a real edit (see next test).
    expect(result.current.restoringRef.current).toBe(true);

    vi.advanceTimersByTime(0);
    expect(result.current.restoringRef.current).toBe(false);
    expect(result.current.restoredWorkspaceIdRef.current).toBe(1);
  });

  it("does not re-restore when `workspaces` changes for an unrelated reason (e.g. renaming a different workspace)", () => {
    vi.useFakeTimers();
    const { api } = makeMockApi();
    const workspace = makeWorkspace();
    const setPanelsVersion = vi.fn();

    const { rerender } = renderHook(
      ({ workspaces }: { workspaces: Workspace[] }) =>
        useWorkspacePersistence({
          dockviewApi: api,
          activeWorkspaceId: 1,
          workspaces,
          isMobile: false,
          setPanelsVersion,
        }),
      { initialProps: { workspaces: [workspace] } },
    );
    vi.advanceTimersByTime(0);
    expect(api.clear).toHaveBeenCalledTimes(1);

    rerender({ workspaces: [workspace, makeWorkspace({ id: 2, name: "Other" })] });
    // restoredWorkspaceIdRef already matches activeWorkspaceId, so this must
    // be a no-op rather than a second clear()+fromJSON() that would blow
    // away any in-progress edit.
    expect(api.clear).toHaveBeenCalledTimes(1);
    expect(api.fromJSON).toHaveBeenCalledTimes(1);
  });

  it("suppresses the restore's own onDidLayoutChange echo, then autosaves a real change once restore has settled", () => {
    vi.useFakeTimers();
    const { api, fireLayoutChange } = makeMockApi();
    const workspace = makeWorkspace();
    const setPanelsVersion = vi.fn();

    renderHook(() =>
      useWorkspacePersistence({
        dockviewApi: api,
        activeWorkspaceId: 1,
        workspaces: [workspace],
        isMobile: false,
        setPanelsVersion,
      }),
    );

    // Simulate fromJSON()'s own layout-change echo firing before the
    // restore effect's setTimeout(0) has flipped restoringRef false.
    fireLayoutChange();
    expect(setPanelsVersion).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(saveWorkspaceLayout).not.toHaveBeenCalled();

    // Let the restore settle.
    vi.advanceTimersByTime(0);

    // A real, post-restore layout change now schedules a debounced save.
    fireLayoutChange();
    expect(setPanelsVersion).toHaveBeenCalledTimes(2);
    expect(saveWorkspaceLayout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(saveWorkspaceLayout).toHaveBeenCalledTimes(1);
    expect(saveWorkspaceLayout).toHaveBeenCalledWith(1, { panels: {} });
  });

  it("flushes the OUTGOING workspace's pending autosave under ITS OWN id on a switch, not the incoming workspace's id", () => {
    vi.useFakeTimers();
    const { api, fireLayoutChange } = makeMockApi();
    const ws1 = makeWorkspace({ id: 1, layout: { ws: 1 } });
    const ws2 = makeWorkspace({ id: 2, layout: { ws: 2 } });
    const setPanelsVersion = vi.fn();

    const { rerender } = renderHook(
      ({ activeWorkspaceId, workspaces }: { activeWorkspaceId: number; workspaces: Workspace[] }) =>
        useWorkspacePersistence({
          dockviewApi: api,
          activeWorkspaceId,
          workspaces,
          isMobile: false,
          setPanelsVersion,
        }),
      { initialProps: { activeWorkspaceId: 1, workspaces: [ws1] } },
    );
    vi.advanceTimersByTime(0); // let ws1's restore settle

    // A real edit on ws1 arms a debounced save tagged with workspace 1's id
    // (PendingSave.workspaceId is captured at *schedule* time — see that
    // interface's own comment in the hook).
    fireLayoutChange();
    vi.advanceTimersByTime(100); // still well inside the 800ms debounce

    // Switch to ws2 before the debounce fires.
    rerender({ activeWorkspaceId: 2, workspaces: [ws1, ws2] });

    // The switch must flush ws1's pending save SYNCHRONOUSLY, tagged with
    // workspace 1's id — not workspace 2's, even though activeWorkspaceId
    // is already 2 by the time flushPendingSave runs. Getting this wrong
    // (e.g. reading activeWorkspaceId live instead of the captured id)
    // would silently write A's layout into B's row.
    expect(saveWorkspaceLayout).toHaveBeenCalledTimes(1);
    expect(saveWorkspaceLayout).toHaveBeenCalledWith(1, { panels: {} });

    saveWorkspaceLayout.mockClear();
    // The original 800ms debounce timer was cleared by the flush — letting
    // it "fire" on its original schedule must not produce a stale/duplicate
    // save for the workspace we've already navigated away from.
    vi.advanceTimersByTime(800);
    expect(saveWorkspaceLayout).not.toHaveBeenCalled();

    // ws2's own restore proceeded with its own layout.
    expect(api.fromJSON).toHaveBeenLastCalledWith(ws2.layout);
  });

  it("does nothing when there is no dockviewApi yet, or no activeWorkspaceId", () => {
    vi.useFakeTimers();
    const { api } = makeMockApi();
    const setPanelsVersion = vi.fn();

    renderHook(() =>
      useWorkspacePersistence({
        dockviewApi: null,
        activeWorkspaceId: 1,
        workspaces: [makeWorkspace()],
        isMobile: false,
        setPanelsVersion,
      }),
    );
    expect(api.clear).not.toHaveBeenCalled();

    renderHook(() =>
      useWorkspacePersistence({
        dockviewApi: api,
        activeWorkspaceId: null,
        workspaces: [makeWorkspace()],
        isMobile: false,
        setPanelsVersion,
      }),
    );
    expect(api.clear).not.toHaveBeenCalled();
  });
});
