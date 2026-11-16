// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { DockviewApi } from "dockview-react";
import { api as http } from "../api/index.js";
import type { PendingOpen, Session } from "../api/index.js";
import { makeProject, makeSession } from "../test/fixtures.js";
import { useApplyPendingOpens } from "./useApplyPendingOpens.js";
import { useCloseKilledSessionPanels } from "./useCloseKilledSessionPanels.js";
import type { UseApplyPendingOpensParams } from "./useApplyPendingOpens.js";

// #3033 — a desktop client adds the sessions opened on the fold or the phone,
// by the placement rule, once the restore has finished, without activating
// them, and acknowledges each once.

type Rect = { x: number; y: number; width: number; height: number };

function makeDock(groupRects: Record<string, Rect>, panelGroups: Record<string, string>) {
  const groups = Object.entries(groupRects).map(([id, r]) => ({
    id,
    api: { location: { type: "grid" as const } },
    element: {
      getBoundingClientRect: () => ({ left: r.x, top: r.y, width: r.width, height: r.height }),
    },
  }));
  const panels = Object.entries(panelGroups).map(([id, groupId]) => ({
    id,
    group: groups.find((g) => g.id === groupId),
  }));
  const api = {
    groups,
    panels,
    activeGroup: groups[0],
    getPanel: (id: string) => panels.find((p) => p.id === id),
    getGroup: (id: string) => groups.find((g) => g.id === id),
    addPanel: vi.fn((opts: { id: string }) => {
      panels.push({ id: opts.id, group: groups[0] });
    }),
  };
  return { api, groups };
}

let pending: PendingOpen[] = [];
let listPendingOpens: ReturnType<typeof vi.spyOn>;
let acknowledgePendingOpen: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  pending = [];
  listPendingOpens = vi.spyOn(http, "listPendingOpens").mockImplementation(async () => pending);
  acknowledgePendingOpen = vi
    .spyOn(http, "acknowledgePendingOpen")
    .mockResolvedValue({ acknowledged: true });
});
afterEach(() => vi.restoreAllMocks());

function open(sessionId: number, referenceSessionId: number | null = null): PendingOpen {
  return { sessionId, referenceSessionId, createdAt: "2026-11-16T00:00:00.000Z" };
}

function setup(dock: ReturnType<typeof makeDock>, over: Partial<UseApplyPendingOpensParams> = {}) {
  const sessions: Session[] = [
    makeSession({ id: 1 }),
    makeSession({ id: 2 }),
    makeSession({ id: 3 }),
  ];
  const props: UseApplyPendingOpensParams = {
    dockviewApi: dock.api as unknown as DockviewApi,
    activeWorkspaceId: 1,
    presentation: "grid",
    sessions,
    sessionsLoaded: true,
    projects: [makeProject({ id: 1, name: "demo" })],
    terminalFontSize: 14,
    restoringRef: { current: false },
    restoredWorkspaceIdRef: { current: 1 },
    isSaveSuspended: () => false,
    ...over,
  };
  const hook = renderHook((p: UseApplyPendingOpensParams) => useApplyPendingOpens(p), {
    initialProps: props,
  });
  return { ...hook, props };
}

// Two panes at 50/50: two columns of 800 x 1000 px.
const twoColumns = () =>
  makeDock(
    { a: { x: 0, y: 0, width: 800, height: 1000 }, b: { x: 800, y: 0, width: 800, height: 1000 } },
    { "session-1": "a", "session-2": "b" },
  );

describe("useApplyPendingOpens", () => {
  it("adds a third pane below its reference's column, inactive, and acknowledges it once", async () => {
    pending = [open(3, 2)];
    const dock = twoColumns();
    const { rerender, props } = setup(dock);
    await waitFor(() => expect(dock.api.addPanel).toHaveBeenCalledTimes(1));
    // Below, not right: the two columns keep their widths (no column added).
    expect(dock.api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-3",
        component: "terminal",
        params: { sessionId: 3 },
        inactive: true,
        position: { referenceGroup: dock.groups[1], direction: "below" },
      }),
    );
    await waitFor(() => expect(acknowledgePendingOpen).toHaveBeenCalledWith(1, 3));

    // The effect re-running (a sessions poll) adds nothing more.
    rerender({ ...props, sessions: [...props.sessions] });
    rerender({ ...props, sessions: [...props.sessions] });
    expect(dock.api.addPanel).toHaveBeenCalledTimes(1);
    expect(acknowledgePendingOpen).toHaveBeenCalledTimes(1);
  });

  it("adds nothing before the restore has finished, then adds it", async () => {
    pending = [open(3)];
    const dock = twoColumns();
    const restoringRef = { current: true };
    const { rerender, props } = setup(dock, { restoringRef });
    await waitFor(() => expect(listPendingOpens).toHaveBeenCalled());
    rerender({ ...props, sessions: [...props.sessions] });
    expect(dock.api.addPanel).not.toHaveBeenCalled();
    expect(acknowledgePendingOpen).not.toHaveBeenCalled();

    restoringRef.current = false;
    rerender({ ...props, sessions: [...props.sessions] });
    expect(dock.api.addPanel).toHaveBeenCalledTimes(1);
  });

  it("adds nothing while another workspace's restore is what ran, or saves are suspended", async () => {
    pending = [open(3)];
    const dock = twoColumns();
    const { rerender, props } = setup(dock, {
      restoredWorkspaceIdRef: { current: 2 },
    });
    await waitFor(() => expect(listPendingOpens).toHaveBeenCalled());
    rerender({ ...props, sessions: [...props.sessions] });
    rerender({
      ...props,
      sessions: [...props.sessions],
      restoredWorkspaceIdRef: { current: 1 },
      isSaveSuspended: () => true,
    });
    expect(dock.api.addPanel).not.toHaveBeenCalled();
  });

  it("does not poll off the desk", () => {
    const dock = twoColumns();
    setup(dock, { presentation: "halves" });
    expect(listPendingOpens).not.toHaveBeenCalled();
  });

  it("acknowledges without adding a session already open, or one that has ended", async () => {
    pending = [open(2), open(3)];
    const dock = twoColumns();
    const sessions = [
      makeSession({ id: 1 }),
      makeSession({ id: 2 }),
      makeSession({ id: 3, status: "exited" }),
    ];
    setup(dock, { sessions });
    await waitFor(() => expect(acknowledgePendingOpen).toHaveBeenCalledTimes(2));
    expect(acknowledgePendingOpen).toHaveBeenCalledWith(1, 2);
    expect(acknowledgePendingOpen).toHaveBeenCalledWith(1, 3);
    expect(dock.api.addPanel).not.toHaveBeenCalled();
  });

  // A session killed on the fold: the server drops its pending open when it
  // is killed, and useCloseKilledSessionPanels closes its pane at the desk.
  // Should the desk still read the open in between, it adds nothing, and the
  // killed session's pane is closed (useCloseKilledSessionPanels).
  it("never adds a killed session's pane, and the desk closes the one it had", async () => {
    pending = [open(3)];
    const dock = twoColumns();
    const close = vi.fn();
    const killed = makeSession({ id: 1, status: "killed" });
    (dock.api.panels[0] as unknown as { api: { close: () => void } }).api = { close };
    const sessions = [killed, makeSession({ id: 2 }), makeSession({ id: 3, status: "killed" })];
    setup(dock, { sessions });
    renderHook(() =>
      useCloseKilledSessionPanels({ sessions, dockviewApi: dock.api as unknown as DockviewApi }),
    );
    await waitFor(() => expect(acknowledgePendingOpen).toHaveBeenCalledWith(1, 3));
    expect(dock.api.addPanel).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("waits for a session this client has not listed yet", async () => {
    pending = [open(4)];
    const dock = twoColumns();
    const { rerender, props } = setup(dock);
    await waitFor(() => expect(listPendingOpens).toHaveBeenCalled());
    rerender({ ...props, sessions: [...props.sessions] });
    expect(acknowledgePendingOpen).not.toHaveBeenCalled();

    rerender({ ...props, sessions: [...props.sessions, makeSession({ id: 4 })] });
    expect(dock.api.addPanel).toHaveBeenCalledWith(expect.objectContaining({ id: "session-4" }));
  });

  it("tabs onto the reference pane at 2x2, and opens a lone pane's neighbour to its right", async () => {
    pending = [open(3, 1)];
    const quad = makeDock(
      {
        a1: { x: 0, y: 0, width: 800, height: 500 },
        a2: { x: 0, y: 500, width: 800, height: 500 },
        b1: { x: 800, y: 0, width: 800, height: 500 },
        b2: { x: 800, y: 500, width: 800, height: 500 },
      },
      { "session-1": "b2" },
    );
    setup(quad);
    await waitFor(() => expect(quad.api.addPanel).toHaveBeenCalled());
    expect(quad.api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        inactive: true,
        position: { referenceGroup: quad.groups[3], direction: "within" },
      }),
    );

    const lone = makeDock({ a: { x: 0, y: 0, width: 1600, height: 1000 } }, { "session-1": "a" });
    setup(lone);
    await waitFor(() => expect(lone.api.addPanel).toHaveBeenCalled());
    expect(lone.api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ position: { referenceGroup: lone.groups[0], direction: "right" } }),
    );
  });

  it("makes the session an empty workspace's single pane", async () => {
    pending = [open(3)];
    const empty = makeDock({}, {});
    setup(empty);
    await waitFor(() => expect(empty.api.addPanel).toHaveBeenCalled());
    expect(empty.api.addPanel.mock.calls[0]![0]).not.toHaveProperty("position");
  });

  it("retries an acknowledge that failed", async () => {
    pending = [open(3)];
    acknowledgePendingOpen.mockRejectedValueOnce(new Error("offline"));
    const dock = twoColumns();
    const { rerender, props } = setup(dock);
    await waitFor(() => expect(acknowledgePendingOpen).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    rerender({ ...props, sessions: [...props.sessions] });
    await waitFor(() => expect(acknowledgePendingOpen).toHaveBeenCalledTimes(2));
    // The pane is open by then: it is only acknowledged, not added again.
    expect(dock.api.addPanel).toHaveBeenCalledTimes(1);
  });
});
