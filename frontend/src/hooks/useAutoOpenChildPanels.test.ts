// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { DockviewApi } from "dockview-react";
import type { AppSettings, Session } from "../api/index.js";
import { DEFAULT_SETTINGS } from "../api/index.js";
import { makeProject, makeSession } from "../test/fixtures.js";
import { useAutoOpenChildPanels } from "./useAutoOpenChildPanels.js";
import type { UseAutoOpenChildPanelsParams } from "./useAutoOpenChildPanels.js";

function childSettings(autoOpenChildPanels: boolean): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    sessions: { ...DEFAULT_SETTINGS.sessions, autoOpenChildPanels },
  };
}

function fakePanel(id: string) {
  return {
    id,
    api: {
      setActive: vi.fn(),
      close: vi.fn(),
      location: { type: "grid" as const },
      updateParameters: vi.fn(),
    },
  };
}

function makeApi(panels: ReturnType<typeof fakePanel>[] = []) {
  return {
    panels,
    getPanel: (id: string) => panels.find((panel) => panel.id === id),
    addPanel: vi.fn(),
  };
}

function parentSession(): Session {
  return makeSession({ id: 1, parentSessionId: null });
}

describe("useAutoOpenChildPanels", () => {
  it("does not seed while any gate is closed", () => {
    const parent = parentSession();
    const api = makeApi([fakePanel("session-1")]);
    const restoringRef = { current: true };
    const restoredWorkspaceIdRef = { current: null as number | null };
    const seen = { current: new Set<number>() };
    const seeded = { current: false };
    const initial: UseAutoOpenChildPanelsParams = {
      sessions: [parent],
      sessionsLoaded: false,
      settings: childSettings(true),
      dockviewApi: null,
      activeWorkspaceId: null,
      projects: [],
      restoringRef,
      restoredWorkspaceIdRef,
      seenChildSessionIdsRef: seen,
      hasSeededChildSessionsRef: seeded,
    };
    const { rerender } = renderHook(
      (p: UseAutoOpenChildPanelsParams) => useAutoOpenChildPanels(p),
      {
        initialProps: initial,
      },
    );

    restoredWorkspaceIdRef.current = 1;
    restoringRef.current = false;
    rerender({
      ...initial,
      sessions: [parent],
      sessionsLoaded: true,
      dockviewApi: api as unknown as DockviewApi,
      activeWorkspaceId: 1,
      settings: childSettings(false),
    });
    expect(seeded.current).toBe(false);
    expect(seen.current.size).toBe(0);
    expect(api.addPanel).not.toHaveBeenCalled();
  });

  it("seeds existing sessions, then opens a child that appears beside its parent", () => {
    const parent = parentSession();
    const parentPanel = fakePanel("session-1");
    const api = makeApi([parentPanel]);
    const seen = { current: new Set<number>() };
    const seeded = { current: false };
    const projects = [makeProject({ id: 1, name: "demo" })];
    const base: UseAutoOpenChildPanelsParams = {
      sessions: [parent],
      sessionsLoaded: true,
      settings: childSettings(true),
      dockviewApi: api as unknown as DockviewApi,
      activeWorkspaceId: 1,
      projects,
      restoringRef: { current: false },
      restoredWorkspaceIdRef: { current: 1 },
      seenChildSessionIdsRef: seen,
      hasSeededChildSessionsRef: seeded,
    };
    const { rerender } = renderHook(
      (p: UseAutoOpenChildPanelsParams) => useAutoOpenChildPanels(p),
      {
        initialProps: base,
      },
    );
    expect(seeded.current).toBe(true);
    expect(seen.current.has(1)).toBe(true);
    expect(api.addPanel).not.toHaveBeenCalled();

    const child = makeSession({
      id: 2,
      parentSessionId: 1,
      projectId: 1,
      status: "active",
      lastTitle: "run",
      openHint: "below",
      createdAt: new Date().toISOString(),
    });
    rerender({ ...base, sessions: [parent, child] });
    expect(api.addPanel).toHaveBeenCalledTimes(1);
    expect(api.addPanel).toHaveBeenCalledWith({
      id: "session-2",
      component: "terminal",
      tabComponent: "terminal",
      title: "run · demo",
      params: { sessionId: 2 },
      position: { referencePanel: parentPanel, direction: "below" },
    });
    expect(seen.current.has(2)).toBe(true);
  });

  it("does not open a child that showed up while restore was still running, until restore finishes", () => {
    const parent = parentSession();
    const parentPanel = fakePanel("session-1");
    const api = makeApi([parentPanel]);
    const restoringRef = { current: false };
    const seen = { current: new Set<number>() };
    const seeded = { current: false };
    const base: UseAutoOpenChildPanelsParams = {
      sessions: [parent],
      sessionsLoaded: true,
      settings: childSettings(true),
      dockviewApi: api as unknown as DockviewApi,
      activeWorkspaceId: 1,
      projects: [makeProject()],
      restoringRef,
      restoredWorkspaceIdRef: { current: 1 },
      seenChildSessionIdsRef: seen,
      hasSeededChildSessionsRef: seeded,
    };
    const { rerender } = renderHook(
      (p: UseAutoOpenChildPanelsParams) => useAutoOpenChildPanels(p),
      {
        initialProps: base,
      },
    );
    expect(seeded.current).toBe(true);

    const child = makeSession({ id: 2, parentSessionId: 1, status: "active" });
    restoringRef.current = true;
    rerender({ ...base, sessions: [parent, child] });
    expect(api.addPanel).not.toHaveBeenCalled();
    expect(seen.current.has(2)).toBe(false);

    restoringRef.current = false;
    rerender({ ...base, sessions: [parent, child], projects: [makeProject({ name: "again" })] });
    expect(api.addPanel).toHaveBeenCalledTimes(1);
    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-2",
        position: { referencePanel: parentPanel, direction: "right" },
      }),
    );
  });

  it("opens a fresh hinted child even when the setting is off, after the seed tick", () => {
    const parent = parentSession();
    const parentPanel = fakePanel("session-1");
    const api = makeApi([parentPanel]);
    const child = makeSession({
      id: 6,
      parentSessionId: 1,
      status: "active",
      openHint: "right",
      createdAt: new Date().toISOString(),
    });
    const seen = { current: new Set<number>() };
    const seeded = { current: false };
    const base: UseAutoOpenChildPanelsParams = {
      sessions: [parent, child],
      sessionsLoaded: true,
      settings: childSettings(false),
      dockviewApi: api as unknown as DockviewApi,
      activeWorkspaceId: 1,
      projects: [],
      restoringRef: { current: false },
      restoredWorkspaceIdRef: { current: 1 },
      seenChildSessionIdsRef: seen,
      hasSeededChildSessionsRef: seeded,
    };
    const { rerender } = renderHook(
      (p: UseAutoOpenChildPanelsParams) => useAutoOpenChildPanels(p),
      {
        initialProps: base,
      },
    );
    // First successful tick only seeds. A fresh hint stays unseen so the
    // next tick can still open it.
    expect(seeded.current).toBe(true);
    expect(api.addPanel).not.toHaveBeenCalled();
    expect(seen.current.has(6)).toBe(false);

    rerender({ ...base, projects: [makeProject()] });
    expect(api.addPanel).toHaveBeenCalledTimes(1);
    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-6",
        title: child.command,
        position: { referencePanel: parentPanel, direction: "right" },
      }),
    );
  });

  it("does not open a child whose parent panel is not in this dock", () => {
    const parent = parentSession();
    const api = makeApi([]);
    const seen = { current: new Set<number>([1]) };
    const child = makeSession({ id: 2, parentSessionId: 1, status: "active" });
    renderHook(() =>
      useAutoOpenChildPanels({
        sessions: [parent, child],
        sessionsLoaded: true,
        settings: childSettings(true),
        dockviewApi: api as unknown as DockviewApi,
        activeWorkspaceId: 1,
        projects: [],
        restoringRef: { current: false },
        restoredWorkspaceIdRef: { current: 1 },
        seenChildSessionIdsRef: seen,
        hasSeededChildSessionsRef: { current: true },
      }),
    );
    expect(api.addPanel).not.toHaveBeenCalled();
  });
});
