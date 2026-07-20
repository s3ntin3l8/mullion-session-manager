// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { openSessionPanel, dropSessionPanel } from "./panelUtils.js";
import type { DockviewApi, DockviewGroupPanel } from "dockview-react";
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
