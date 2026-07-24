// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  openSessionPanel,
  openTimelinePanel,
  dropSessionPanel,
  hasTiledPanels,
  stripFloatingPanels,
  attentionTransitionPanelIds,
} from "./panelUtils.js";
import type { DockviewApi, DockviewGroupPanel, SerializedDockview } from "dockview-react";
import { DEFAULT_SETTINGS } from "./api.js";
import type { Session } from "./api.js";

// `location.type` mirrors the live dockview panel API this module reads to
// decide float-vs-dock (issue #121): "grid" for anything actually tiled
// (including edge/split groups), "floating" for a peek panel.
function mockPanel(id: string, locationType: "grid" | "floating" = "grid", overrides = {}) {
  return {
    id,
    api: { setActive: vi.fn(), close: vi.fn(), location: { type: locationType } },
    ...overrides,
  } as unknown as ReturnType<DockviewApi["getPanel"]>;
}

// A grid-target group for dropSessionPanel tests — real DockviewGroupPanels
// expose the same `api.location.type` shape panels do.
function mockGroup(id: string, locationType: "grid" | "floating" = "grid") {
  return { id, api: { location: { type: locationType } } } as unknown as DockviewGroupPanel;
}

function mockDockviewApi(): DockviewApi {
  const panels = new Map<string, ReturnType<DockviewApi["getPanel"]>>();
  return {
    getPanel: vi.fn((id: string) => panels.get(id) ?? null),
    addPanel: vi.fn((opts) => {
      const p = mockPanel(opts.id, opts.floating ? "floating" : "grid", opts);
      panels.set(opts.id, p);
      return p;
    }),
    maximizeGroup: vi.fn(),
    get panels() {
      return Array.from(panels.values());
    },
  } as unknown as DockviewApi;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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
  gateState: "idle",
  gatePrompt: null,
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

  it("docks full-screen into an empty workspace (issue #121)", () => {
    const api = mockDockviewApi();

    openSessionPanel(api, NEW_SESSION, false, PROJECTS);

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-2",
        position: { direction: "right" },
      }),
    );
    const addCall = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(addCall).not.toHaveProperty("floating");
    expect(api.maximizeGroup).not.toHaveBeenCalled();
  });

  it("floats (peeks) when a tiled panel already exists", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} }); // tiled

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

// openTimelinePanel (issue #212) has no isMobile param — see panelUtils.ts's
// own comment on why: it's called from PaneTab.tsx's overflow menu, which
// has no access to App.tsx's live isMobile React state. It reads a live
// matchMedia() check instead, so these tests stub that directly rather than
// passing a boolean like openSessionPanel's tests do above.
function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

describe("openTimelinePanel", () => {
  it("focuses an existing timeline panel without creating a new one", () => {
    stubMatchMedia(false);
    const api = mockDockviewApi();
    api.addPanel({ id: "timeline-1", component: "timeline", params: {} });
    const existing = api.getPanel("timeline-1")!;
    existing.api.setActive = vi.fn();

    openTimelinePanel(api, EXISTING_SESSION);

    expect(existing.api.setActive).toHaveBeenCalledTimes(1);
    expect(api.addPanel).toHaveBeenCalledTimes(1); // only the setup call
  });

  it("docks full-screen into an empty workspace, same as openSessionPanel", () => {
    stubMatchMedia(false);
    const api = mockDockviewApi();

    openTimelinePanel(api, NEW_SESSION);

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "timeline-2",
        component: "timeline",
        params: { sessionId: 2 },
        position: { direction: "right" },
      }),
    );
    expect(api.maximizeGroup).not.toHaveBeenCalled();
  });

  it("floats (peeks) when a tiled panel already exists", () => {
    stubMatchMedia(false);
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} }); // tiled

    openTimelinePanel(api, NEW_SESSION);

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "timeline-2", floating: true }),
    );
    expect(api.maximizeGroup).not.toHaveBeenCalled();
  });

  it("does not float on mobile (per matchMedia); maximizes instead", () => {
    stubMatchMedia(true);
    const api = mockDockviewApi();

    openTimelinePanel(api, NEW_SESSION);

    const addCall = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(addCall.id).toBe("timeline-2");
    expect(addCall).not.toHaveProperty("floating");
    expect(api.maximizeGroup).toHaveBeenCalledTimes(1);
  });

  it("titles the panel using the session's name, falling back to its command", () => {
    stubMatchMedia(false);
    const api = mockDockviewApi();

    openTimelinePanel(api, NEW_SESSION);

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining("codex") }),
    );
  });
});

describe("hasTiledPanels", () => {
  it("is false for an empty workspace", () => {
    const api = mockDockviewApi();
    expect(hasTiledPanels(api)).toBe(false);
  });

  it("is false when the only panel is floating", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {}, floating: true });
    expect(hasTiledPanels(api)).toBe(false);
  });

  it("is true once a tiled panel exists", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} });
    expect(hasTiledPanels(api)).toBe(true);
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

  it("docks into the grid when dropped on empty space (issue #121)", () => {
    const api = mockDockviewApi();

    dropSessionPanel(api, NEW_SESSION, PROJECTS, null);

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-2",
        position: { direction: "right" },
      }),
    );
    const addCall = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(addCall).not.toHaveProperty("floating");
  });

  it("docks into the grid when the drop target is a floating group, not floats onto it", () => {
    const api = mockDockviewApi();
    const floatingGroup = mockGroup("float-group-1", "floating");

    dropSessionPanel(api, NEW_SESSION, PROJECTS, {
      group: floatingGroup,
      location: "content",
      position: "center",
    });

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-2",
        position: { direction: "right" },
      }),
    );
    const addCall = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(addCall).not.toHaveProperty("floating");
  });

  it("adds a panel within a group when dropped on the center", () => {
    const api = mockDockviewApi();
    const group = mockGroup("group-1");

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
    const group = mockGroup("group-1");

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

describe("attentionTransitionPanelIds (#98 item 4 — auto-focus on attention)", () => {
  // App.tsx's effect gates the whole feature on this before even calling
  // attentionTransitionPanelIds — asserting the actual default here (rather
  // than assuming) is the "off by default" half of this feature's test
  // coverage; the transition-detection tests below are the "properly
  // gated" half.
  it("defaults to off", () => {
    expect(DEFAULT_SETTINGS.notifications.autoFocusOnAttention).toBe(false);
  });

  it("returns a panel id for a session newly in attention", () => {
    const sessions = [{ id: 1, attention: true }];
    expect(attentionTransitionPanelIds(sessions, new Set())).toEqual(["session-1"]);
  });

  it("excludes a session already attention on the previous tick — fires once per transition, not every tick", () => {
    const sessions = [{ id: 1, attention: true }];
    expect(attentionTransitionPanelIds(sessions, new Set([1]))).toEqual([]);
  });

  it("excludes sessions that aren't currently in attention", () => {
    const sessions = [
      { id: 1, attention: false },
      { id: 2, attention: false },
    ];
    expect(attentionTransitionPanelIds(sessions, new Set())).toEqual([]);
  });

  it("handles a mix — new transition, already-seen, and never-attention — independently", () => {
    const sessions = [
      { id: 1, attention: true }, // new transition
      { id: 2, attention: true }, // already seen last tick
      { id: 3, attention: false }, // never attention
    ];
    expect(attentionTransitionPanelIds(sessions, new Set([2]))).toEqual(["session-1"]);
  });
});
