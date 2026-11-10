// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { DockviewApi } from "dockview-react";
import { makeProject } from "../test/fixtures.js";
import { useCloseStaleProjectPanels } from "./useCloseStaleProjectPanels.js";

function panel(id: string) {
  const close = vi.fn();
  return { id, close, api: { close } };
}

function makeApi(panels: ReturnType<typeof panel>[]) {
  return {
    panels,
    getPanel: (id: string) => panels.find((item) => item.id === id),
  } as unknown as DockviewApi;
}

describe("useCloseStaleProjectPanels", () => {
  it("does nothing without a dock, before projects load, or after a failed load", () => {
    const stale = panel("project-hub-9");
    const api = makeApi([stale]);
    renderHook(() =>
      useCloseStaleProjectPanels({
        projects: [],
        projectsLoaded: true,
        projectsError: null,
        dockviewApi: null,
      }),
    );
    renderHook(() =>
      useCloseStaleProjectPanels({
        projects: [],
        projectsLoaded: false,
        projectsError: null,
        dockviewApi: api,
      }),
    );
    renderHook(() =>
      useCloseStaleProjectPanels({
        projects: [],
        projectsLoaded: true,
        projectsError: "offline",
        dockviewApi: api,
      }),
    );
    expect(stale.close).not.toHaveBeenCalled();
  });

  it("closes project panels whose project is gone", () => {
    const kept = panel("project-hub-1");
    const hub = panel("project-hub-9");
    const editor = panel("file-editor-9");
    const session = panel("session-9");
    const api = makeApi([kept, hub, editor, session]);
    renderHook(() =>
      useCloseStaleProjectPanels({
        projects: [makeProject({ id: 1 })],
        projectsLoaded: true,
        projectsError: null,
        dockviewApi: api,
      }),
    );
    expect(kept.close).not.toHaveBeenCalled();
    expect(hub.close).toHaveBeenCalledTimes(1);
    expect(editor.close).toHaveBeenCalledTimes(1);
    expect(session.close).not.toHaveBeenCalled();
  });
});
