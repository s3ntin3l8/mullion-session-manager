// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { openSessionPanel, dropSessionPanel, stripFloatingPanels } from "./panelUtils.js";
import type { DockviewApi, DockviewGroupPanel, SerializedDockview } from "dockview-react";
import type { Session } from "./api.js";

function mockPanel(id: string, overrides = {}) {
  return {
    id,
    api: { setActive: vi.fn(), close: vi.fn() },
    ...overrides,
  } as unknown as ReturnType<DockviewApi["getPanel"]>;
}

function mockDockviewApi(): DockviewApi {
  const panels = new Map<string, ReturnType<DockviewApi["getPanel"]>>();
  return {
    getPanel: vi.fn((id: string) => panels.get(id) ?? null),
    addPanel: vi.fn((opts) => {
      const p = mockPanel(opts.id, opts);
      panels.set(opts.id, p);
      return p;
    }),
    maximizeGroup: vi.fn(),
  } as unknown as DockviewApi;
}

const PROJECTS = [
  { id: 1, name: "project-alpha" },
  { id: 2, name: null },
];

const EXISTING_SESSION: Session = {
  id: 1,
  projectId: 1,
  command: "claude",
  name: null,
  nameLocked: false,
  cwd: null,
  kind: "terminal",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastAttachedAt: "2026-01-01T00:00:00.000Z",
  alive: true,
  subscriberCount: 1,
  activity: "working",
  lastActivityAt: Date.now(),
  attention: false,
  attentionAt: null,
  lastTitle: null,
};

const NEW_SESSION: Session = {
  ...EXISTING_SESSION,
  id: 2,
  projectId: 1,
  command: "codex",
};

const SESSION_NO_PROJECT: Session = {
  ...EXISTING_SESSION,
  id: 3,
  projectId: 999,
  command: "opencode",
};

describe("openSessionPanel", () => {
  it("focuses an existing panel without creating a new one", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} });
    const existing = api.getPanel("session-1")!;
    existing.api.setActive = vi.fn();

    openSessionPanel(api, EXISTING_SESSION, false, PROJECTS);

    expect(existing.api.setActive).toHaveBeenCalledTimes(1);
    expect(api.addPanel).toHaveBeenCalledTimes(1); // only the setup call
  });

  it("opens a floating panel for sessions not in the current workspace", () => {
    const api = mockDockviewApi();

    openSessionPanel(api, NEW_SESSION, false, PROJECTS);

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-2",
        floating: true,
      }),
    );
    expect(api.maximizeGroup).not.toHaveBeenCalled();
  });

  it("does not float on mobile; maximizes instead", () => {
    const api = mockDockviewApi();

    openSessionPanel(api, NEW_SESSION, true, PROJECTS);

    const addCall = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(addCall.id).toBe("session-2");
    expect(addCall).not.toHaveProperty("floating");
    expect(api.maximizeGroup).toHaveBeenCalledTimes(1);
  });

  it("creates a panel with the session command as title", () => {
    const api = mockDockviewApi();

    openSessionPanel(api, NEW_SESSION, false, PROJECTS);

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("codex"),
      }),
    );
  });

  it("handles a session with no matching project gracefully", () => {
    const api = mockDockviewApi();

    openSessionPanel(api, SESSION_NO_PROJECT, false, PROJECTS);

    expect(api.addPanel).toHaveBeenCalledTimes(1);
  });
});

describe("dropSessionPanel", () => {
  it("focuses an existing panel", () => {
    const api = mockDockviewApi();
    const target = null;
    api.addPanel({ id: "session-2", component: "terminal", params: {} });
    const existing = api.getPanel("session-2")!;
    existing.api.setActive = vi.fn();

    dropSessionPanel(api, NEW_SESSION, PROJECTS, target);

    expect(existing.api.setActive).toHaveBeenCalledTimes(1);
    expect(api.addPanel).toHaveBeenCalledTimes(1);
  });

  it("adds a floating panel when dropped on empty space", () => {
    const api = mockDockviewApi();

    dropSessionPanel(api, NEW_SESSION, PROJECTS, null);

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-2",
        floating: true,
      }),
    );
  });

  it("adds a panel within a group when dropped on the center", () => {
    const api = mockDockviewApi();
    const group = { id: "group-1" } as DockviewGroupPanel;

    dropSessionPanel(api, NEW_SESSION, PROJECTS, {
      group,
      location: "content",
      position: "center",
    });

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-2",
        position: { referenceGroup: group, direction: "within" },
      }),
    );
  });

  it("adds a panel on the edge of a group with the correct direction", () => {
    const api = mockDockviewApi();
    const group = { id: "group-1" } as DockviewGroupPanel;

    dropSessionPanel(api, NEW_SESSION, PROJECTS, {
      group,
      location: "edge",
      position: "right",
    });

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-2",
      }),
    );
    const addCall = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(addCall.position.referenceGroup).toBe(group);
    expect(addCall.position.direction).toBe("right");
  });
});

describe("stripFloatingPanels", () => {
  const GRID_PANEL = { id: "session-1", contentComponent: "terminal", title: "alpha" };
  const FLOAT_PANEL_SINGLE = { id: "session-2", contentComponent: "terminal", title: "bravo" };
  const FLOAT_PANEL_GRID = { id: "session-3", contentComponent: "terminal", title: "charlie" };

  function makeSerialized(overrides?: {
    floatingGroups?: unknown[];
    activeGroup?: string;
    extraPanels?: Record<string, unknown>;
  }): SerializedDockview {
    const panels: Record<string, unknown> = {
      "session-1": GRID_PANEL,
      "session-2": FLOAT_PANEL_SINGLE,
      ...(overrides?.extraPanels ?? {}),
    };
    const floatingGroups =
      overrides && "floatingGroups" in overrides
        ? overrides.floatingGroups
        : [
            {
              data: { views: ["session-2"], activeView: "session-2", id: "float-group-1" },
              position: { width: 400, height: 300, x: 100, y: 100 },
            },
          ];
    return {
      grid: {
        root: {
          type: "leaf" as const,
          data: { views: ["session-1"], activeView: "session-1", id: "main-group" },
        },
        height: 500,
        width: 800,
        orientation: "HORIZONTAL",
      },
      panels,
      activeGroup: overrides?.activeGroup ?? "main-group",
      floatingGroups,
    } as unknown as SerializedDockview;
  }

  it("strips a floating group backed by fg.data", () => {
    const serialized = makeSerialized();
    const result = stripFloatingPanels(serialized);

    expect(result.panels).not.toHaveProperty("session-2");
    expect(result.panels).toHaveProperty("session-1");
  });

  it("strips a floating group backed by fg.grid", () => {
    const serialized = makeSerialized({
      extraPanels: { "session-3": FLOAT_PANEL_GRID },
      floatingGroups: [
        {
          grid: {
            root: {
              type: "leaf" as const,
              data: { views: ["session-3"], activeView: "session-3", id: "float-group-2" },
            },
            width: 300,
            height: 200,
            orientation: "HORIZONTAL" as const,
          },
          position: { width: 400, height: 300, x: 200, y: 100 },
        },
      ],
    });

    const result = stripFloatingPanels(serialized);
    expect(result.panels).not.toHaveProperty("session-3");
  });

  it("preserves the main grid panels untouched", () => {
    const serialized = makeSerialized();
    const result = stripFloatingPanels(serialized);

    expect(result.panels).toHaveProperty("session-1");
    expect(result.panels["session-1"]).toEqual(GRID_PANEL);
    expect(result.panels).not.toHaveProperty("session-2");
  });

  it("clears activeGroup when it points to a floating group", () => {
    const serialized = makeSerialized({ activeGroup: "session-2" });
    const result = stripFloatingPanels(serialized);

    expect(result).not.toHaveProperty("activeGroup");
  });

  it("preserves activeGroup when it points to the main grid", () => {
    const serialized = makeSerialized({ activeGroup: "session-1" });
    const result = stripFloatingPanels(serialized);

    expect(result.activeGroup).toBe("session-1");
  });

  it("removes the floatingGroups key from the output", () => {
    const serialized = makeSerialized();
    const result = stripFloatingPanels(serialized);

    expect(result).not.toHaveProperty("floatingGroups");
  });

  it("returns the input unchanged when there are no floating groups", () => {
    const serialized = makeSerialized({ floatingGroups: undefined });
    const result = stripFloatingPanels(serialized);

    expect(result).toBe(serialized);
    expect(result.panels).toHaveProperty("session-1");
    expect(result.panels).toHaveProperty("session-2");
  });

  it("does not mutate the input", () => {
    const serialized = makeSerialized();
    const copy = makeSerialized();

    stripFloatingPanels(serialized);

    expect(serialized).toEqual(copy);
  });
});
