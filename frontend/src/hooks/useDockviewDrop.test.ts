// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDockviewDrop } from "./useDockviewDrop.js";
import type { DockviewApi } from "dockview-react";
import type { Session } from "../api/index.js";

// Mirrors useWorkspacePersistence.test.ts's own store-mock shape: a
// `storeState()` factory serving `useDashboardStore.getState()`, the only
// call form this hook uses (sessions/projects lookups inside the onDidDrop
// and native-drop handlers).
let sessions: Session[] = [];
let projects: { id: number; name: string | null }[] = [];

function storeState() {
  return { sessions, projects };
}

vi.mock("../store/index.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  };
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

// dropSessionPanel's own branching (edge vs content, existing-panel
// short-circuit, etc.) is panelUtils.ts's concern and already covered there
// — this hook only needs to be proven to call it with the right arguments,
// so it's mocked rather than re-exercised here.
const dropSessionPanel = vi.fn();
vi.mock("../panelUtils.js", () => ({
  dropSessionPanel: (...args: unknown[]) => dropSessionPanel(...args),
}));

// jsdom doesn't implement DragEvent (confirmed against jsdom 30, the version
// pinned in package.json) — same gap Sidebar.test.tsx's own
// createDataTransfer comment notes for DataTransfer. The onUnhandledDragOver
// handler explicitly branches on `event.nativeEvent instanceof DragEvent`,
// so exercising both sides of that branch needs a real class the global
// `DragEvent` identifier resolves to at call time.
class FakeDragEvent extends Event {
  dataTransfer: DataTransfer | null;
  constructor(type: string, dataTransfer: DataTransfer | null = null) {
    super(type);
    this.dataTransfer = dataTransfer;
  }
}

function makeDataTransfer(entries: Record<string, string> = {}): DataTransfer {
  const map = new Map(Object.entries(entries));
  return {
    setData(type, val) {
      map.set(type, val);
    },
    getData(type) {
      return map.get(type) ?? "";
    },
    get types() {
      return Array.from(map.keys());
    },
    effectAllowed: "none" as DataTransfer["effectAllowed"],
    dropEffect: "none" as DataTransfer["dropEffect"],
    clearData(format) {
      if (format) map.delete(format);
      else map.clear();
    },
    setDragImage() {},
    items: {} as DataTransfer["items"],
    files: {} as FileList,
  } as DataTransfer;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 1,
    projectId: 1,
    name: "my session",
    command: "claude",
    status: "running",
    sessionStatus: "idle",
    attention: false,
    parentSessionId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Session;
}

// A minimal fake DockviewApi covering exactly the surface the two
// dockview-event effects touch: onUnhandledDragOver/onDidDrop to register
// (and let a test fire) their callbacks, plus getPanel for the
// existing-panel short-circuit both effects (and the native-drop handler)
// share.
function makeMockApi() {
  const unhandledDragOverListeners: Array<(event: Record<string, unknown>) => void> = [];
  const didDropListeners: Array<(event: Record<string, unknown>) => void> = [];
  const panels = new Map<string, { api: { setActive: ReturnType<typeof vi.fn> } }>();
  const api = {
    onUnhandledDragOver: vi.fn((cb: (event: Record<string, unknown>) => void) => {
      unhandledDragOverListeners.push(cb);
      return { dispose: vi.fn() };
    }),
    onDidDrop: vi.fn((cb: (event: Record<string, unknown>) => void) => {
      didDropListeners.push(cb);
      return { dispose: vi.fn() };
    }),
    getPanel: vi.fn((id: string) => panels.get(id) ?? null),
  };
  return {
    api: api as unknown as DockviewApi,
    fireUnhandledDragOver: (event: Record<string, unknown>) =>
      unhandledDragOverListeners.forEach((cb) => cb(event)),
    fireDidDrop: (event: Record<string, unknown>) => didDropListeners.forEach((cb) => cb(event)),
    addExistingPanel: (id: string) => {
      const panel = { api: { setActive: vi.fn() } };
      panels.set(id, panel);
      return panel;
    },
  };
}

beforeEach(() => {
  sessions = [];
  projects = [];
  dropSessionPanel.mockClear();
  vi.stubGlobal("DragEvent", FakeDragEvent);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useDockviewDrop", () => {
  describe("onUnhandledDragOver effect", () => {
    it("does not subscribe when dockviewApi is null", () => {
      expect(() =>
        renderHook(() => useDockviewDrop({ dockviewApi: null, setSidebarOpen: vi.fn() })),
      ).not.toThrow();
    });

    it("ignores a native event that isn't a real DragEvent", () => {
      const { api, fireUnhandledDragOver } = makeMockApi();
      renderHook(() => useDockviewDrop({ dockviewApi: api, setSidebarOpen: vi.fn() }));

      const accept = vi.fn();
      fireUnhandledDragOver({ nativeEvent: new Event("dragover"), accept });

      expect(accept).not.toHaveBeenCalled();
    });

    it("ignores a DragEvent whose dataTransfer doesn't carry the mullion session type", () => {
      const { api, fireUnhandledDragOver } = makeMockApi();
      renderHook(() => useDockviewDrop({ dockviewApi: api, setSidebarOpen: vi.fn() }));

      const accept = vi.fn();
      const nativeEvent = new FakeDragEvent("dragover", makeDataTransfer({ "text/plain": "x" }));
      fireUnhandledDragOver({ nativeEvent, accept });

      expect(accept).not.toHaveBeenCalled();
    });

    it("accepts and records the drop target for a matching drag", () => {
      const { api, fireUnhandledDragOver, fireDidDrop } = makeMockApi();
      renderHook(() => useDockviewDrop({ dockviewApi: api, setSidebarOpen: vi.fn() }));

      const accept = vi.fn();
      const nativeEvent = new FakeDragEvent(
        "dragover",
        makeDataTransfer({ "application/x-mullion-session": "1" }),
      );
      const group = { id: "group-1" };
      fireUnhandledDragOver({ nativeEvent, accept, group, target: "edge", position: "left" });

      expect(accept).toHaveBeenCalledTimes(1);

      // Proves the recorded target is actually consumed later: onDidDrop's
      // own success path always resets it to null, so drive that instead of
      // reaching into the hook's private ref.
      const session = makeSession({ id: 1 });
      sessions = [session];
      const dropDt = makeDataTransfer({ "application/x-mullion-session": "1" });
      fireDidDrop({
        nativeEvent: new FakeDragEvent("drop", dropDt),
        group,
        position: "center",
      });
      expect(dropSessionPanel).toHaveBeenCalledWith(api, session, projects, {
        group,
        location: "content",
        position: "center",
      });
    });
  });

  describe("onDidDrop effect", () => {
    it("does not subscribe when dockviewApi is null", () => {
      expect(() =>
        renderHook(() => useDockviewDrop({ dockviewApi: null, setSidebarOpen: vi.fn() })),
      ).not.toThrow();
    });

    it("ignores a drop with no session id in dataTransfer", () => {
      const { api, fireDidDrop } = makeMockApi();
      renderHook(() => useDockviewDrop({ dockviewApi: api, setSidebarOpen: vi.fn() }));

      fireDidDrop({ nativeEvent: new FakeDragEvent("drop", makeDataTransfer()) });

      expect(dropSessionPanel).not.toHaveBeenCalled();
    });

    it("ignores a drop whose native event isn't a real DragEvent", () => {
      const { api, fireDidDrop } = makeMockApi();
      renderHook(() => useDockviewDrop({ dockviewApi: api, setSidebarOpen: vi.fn() }));

      // A non-DragEvent nativeEvent forces `dt` to null regardless of what a
      // (nonexistent, on this branch) dataTransfer would have said — mirrors
      // the equivalent onUnhandledDragOver test above.
      fireDidDrop({ nativeEvent: new Event("drop") });

      expect(dropSessionPanel).not.toHaveBeenCalled();
    });

    it("ignores a drop with a non-numeric session id", () => {
      const { api, fireDidDrop } = makeMockApi();
      renderHook(() => useDockviewDrop({ dockviewApi: api, setSidebarOpen: vi.fn() }));

      fireDidDrop({
        nativeEvent: new FakeDragEvent(
          "drop",
          makeDataTransfer({ "application/x-mullion-session": "not-a-number" }),
        ),
      });

      expect(dropSessionPanel).not.toHaveBeenCalled();
    });

    it("activates an already-open panel instead of re-adding it", () => {
      const { api, fireDidDrop, addExistingPanel } = makeMockApi();
      const panel = addExistingPanel("session-42");
      const setSidebarOpen = vi.fn();
      renderHook(() => useDockviewDrop({ dockviewApi: api, setSidebarOpen }));

      fireDidDrop({
        nativeEvent: new FakeDragEvent(
          "drop",
          makeDataTransfer({ "application/x-mullion-session": "42" }),
        ),
      });

      expect(panel.api.setActive).toHaveBeenCalledTimes(1);
      expect(dropSessionPanel).not.toHaveBeenCalled();
      // Only the native-drop handler's success path and the sidebar's own
      // session-row click close the sidebar — the existing-panel
      // short-circuit intentionally leaves it as-is.
      expect(setSidebarOpen).not.toHaveBeenCalled();
    });

    it("does nothing when the dropped session id has no matching session in the store", () => {
      const { api, fireDidDrop } = makeMockApi();
      sessions = [];
      renderHook(() => useDockviewDrop({ dockviewApi: api, setSidebarOpen: vi.fn() }));

      fireDidDrop({
        nativeEvent: new FakeDragEvent(
          "drop",
          makeDataTransfer({ "application/x-mullion-session": "7" }),
        ),
      });

      expect(dropSessionPanel).not.toHaveBeenCalled();
    });

    it("docks a new panel, classifying an edge position as location 'edge'", () => {
      const { api, fireDidDrop } = makeMockApi();
      const session = makeSession({ id: 5 });
      sessions = [session];
      projects = [{ id: 1, name: "proj" }];
      const setSidebarOpen = vi.fn();
      renderHook(() => useDockviewDrop({ dockviewApi: api, setSidebarOpen }));

      const group = { id: "g1" };
      fireDidDrop({
        nativeEvent: new FakeDragEvent(
          "drop",
          makeDataTransfer({ "application/x-mullion-session": "5" }),
        ),
        group,
        position: "top",
      });

      expect(dropSessionPanel).toHaveBeenCalledWith(api, session, projects, {
        group,
        location: "edge",
        position: "top",
      });
      expect(setSidebarOpen).toHaveBeenCalledWith(false);
    });
  });

  describe("native drop-on-empty-grid effect", () => {
    // dockviewRef is created and owned by the hook itself, and nothing in
    // this test suite renders it into the DOM the way App.tsx's
    // `<DockviewReact ref={dockviewRef} .../>` does, so `renderHook` alone
    // never populates `.current`. In the real app this ref IS already
    // non-null by the time any effect in the tree runs (React attaches a
    // forwarded DOM ref during the commit phase, before passive effects
    // flush — `DockviewReact` forwards to its container `HTMLDivElement`,
    // see `dockview-react`'s own `.d.ts`), so setting `.current` by hand and
    // forcing the effect to re-run (via a dockviewApi identity change,
    // exactly like the real onReady transition) reproduces that same
    // ref-already-populated-before-effects invariant rather than working
    // around a real ordering gap.
    function renderWithAttachedContainer(el: HTMLDivElement, setSidebarOpen = vi.fn()) {
      const rendered = renderHook(
        ({ dockviewApi }: { dockviewApi: DockviewApi | null }) =>
          useDockviewDrop({ dockviewApi, setSidebarOpen }),
        { initialProps: { dockviewApi: null as DockviewApi | null } },
      );
      rendered.result.current.dockviewRef.current = el;
      return rendered;
    }

    it("does not throw and attaches no listeners when dockviewRef.current is null", () => {
      const addEventListenerSpy = vi.spyOn(EventTarget.prototype, "addEventListener");
      expect(() =>
        renderHook(() => useDockviewDrop({ dockviewApi: null, setSidebarOpen: vi.fn() })),
      ).not.toThrow();
      // Nothing in this render ever assigns dockviewRef.current, so the
      // effect's own `if (!el) return` guard should have fired without
      // registering any of the four listeners.
      expect(addEventListenerSpy).not.toHaveBeenCalledWith("dragover", expect.anything());
      addEventListenerSpy.mockRestore();
    });

    it("registers all four native listeners once the container is attached", () => {
      const el = document.createElement("div");
      const addSpy = vi.spyOn(el, "addEventListener");
      const { rerender } = renderWithAttachedContainer(el);

      // The effect's dependency array is [dockviewApi, setSidebarOpen] — a
      // bare ref write triggers no re-render/re-run on its own, so the test
      // drives the same dockviewApi identity change the real onReady
      // transition produces.
      const { api } = makeMockApi();
      rerender({ dockviewApi: api });

      expect(addSpy).toHaveBeenCalledWith("dragover", expect.any(Function));
      expect(addSpy).toHaveBeenCalledWith("drop", expect.any(Function));
      expect(addSpy).toHaveBeenCalledWith("dragend", expect.any(Function));
      expect(addSpy).toHaveBeenCalledWith("dragleave", expect.any(Function));
    });

    function attachAndGetHandlers(dockviewApi: DockviewApi | null) {
      const el = document.createElement("div");
      const handlers: Record<string, (e: Record<string, unknown>) => void> = {};
      vi.spyOn(el, "addEventListener").mockImplementation(((type: string, cb: unknown) => {
        handlers[type] = cb as (e: Record<string, unknown>) => void;
      }) as typeof el.addEventListener);
      const removeSpy = vi.spyOn(el, "removeEventListener");
      const setSidebarOpen = vi.fn();
      const { rerender, unmount } = renderHook(
        ({ dockviewApi }: { dockviewApi: DockviewApi | null }) => {
          const result = useDockviewDrop({ dockviewApi, setSidebarOpen });
          result.dockviewRef.current = el;
          return result;
        },
        { initialProps: { dockviewApi: null as DockviewApi | null } },
      );
      // Force the effect to (re-)run now that dockviewRef.current is set,
      // same reasoning as renderWithAttachedContainer above.
      rerender({ dockviewApi });
      return { handlers, removeSpy, setSidebarOpen, unmount, el };
    }

    it("preventDefaults dragover only for a matching drag, and is a no-op otherwise", () => {
      const { handlers } = attachAndGetHandlers(null);
      const matching = {
        dataTransfer: makeDataTransfer({ "application/x-mullion-session": "1" }),
        preventDefault: vi.fn(),
      };
      handlers.dragover(matching);
      expect(matching.preventDefault).toHaveBeenCalledTimes(1);

      const nonMatching = {
        dataTransfer: makeDataTransfer({ "text/plain": "x" }),
        preventDefault: vi.fn(),
      };
      handlers.dragover(nonMatching);
      expect(nonMatching.preventDefault).not.toHaveBeenCalled();
    });

    it("dragleave with a relatedTarget still inside the container does not clear the tracked drop target", () => {
      const { api, fireUnhandledDragOver } = makeMockApi();
      const { handlers } = attachAndGetHandlers(api);
      const container = { contains: vi.fn(() => true) };

      // Seed a recorded target the same way effect 1 would.
      fireUnhandledDragOver({
        nativeEvent: new FakeDragEvent(
          "dragover",
          makeDataTransfer({ "application/x-mullion-session": "1" }),
        ),
        accept: vi.fn(),
        group: { id: "g" },
        target: "content",
        position: "center",
      });

      handlers.dragleave({
        type: "dragleave",
        relatedTarget: {},
        currentTarget: container,
      });

      const session = makeSession({ id: 1 });
      sessions = [session];
      handlers.drop({
        dataTransfer: makeDataTransfer({ "application/x-mullion-session": "1" }),
        preventDefault: vi.fn(),
      });

      // Target survived the dragleave (container still "contains" the
      // related target), so it's passed through to dropSessionPanel intact.
      expect(dropSessionPanel).toHaveBeenCalledWith(api, session, projects, {
        group: { id: "g" },
        location: "content",
        position: "center",
      });
    });

    it("dragleave off the container, and dragend, both clear the tracked drop target", () => {
      const { api, fireUnhandledDragOver } = makeMockApi();
      const { handlers } = attachAndGetHandlers(api);

      fireUnhandledDragOver({
        nativeEvent: new FakeDragEvent(
          "dragover",
          makeDataTransfer({ "application/x-mullion-session": "1" }),
        ),
        accept: vi.fn(),
        group: { id: "g" },
        target: "content",
        position: "center",
      });

      const container = { contains: vi.fn(() => false) };
      handlers.dragleave({ type: "dragleave", relatedTarget: {}, currentTarget: container });

      const session = makeSession({ id: 1 });
      sessions = [session];
      handlers.drop({
        dataTransfer: makeDataTransfer({ "application/x-mullion-session": "1" }),
        preventDefault: vi.fn(),
      });

      expect(dropSessionPanel).toHaveBeenCalledWith(api, session, projects, null);
    });

    it("drop: no session id in dataTransfer preventDefaults and does not dock", () => {
      const { handlers } = attachAndGetHandlers(null);
      const preventDefault = vi.fn();
      handlers.drop({ dataTransfer: makeDataTransfer(), preventDefault });

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(dropSessionPanel).not.toHaveBeenCalled();
    });

    it("drop: non-numeric session id preventDefaults and does not dock", () => {
      const { api } = makeMockApi();
      const { handlers } = attachAndGetHandlers(api);
      const preventDefault = vi.fn();
      handlers.drop({
        dataTransfer: makeDataTransfer({ "application/x-mullion-session": "abc" }),
        preventDefault,
      });

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(dropSessionPanel).not.toHaveBeenCalled();
    });

    it("drop: missing dockviewApi preventDefaults and does not dock", () => {
      const { handlers } = attachAndGetHandlers(null);
      const preventDefault = vi.fn();
      handlers.drop({
        dataTransfer: makeDataTransfer({ "application/x-mullion-session": "1" }),
        preventDefault,
      });

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(dropSessionPanel).not.toHaveBeenCalled();
    });

    it("drop: activates an already-open panel instead of re-adding it", () => {
      const { api, addExistingPanel } = makeMockApi();
      const panel = addExistingPanel("session-9");
      const { handlers } = attachAndGetHandlers(api);
      const preventDefault = vi.fn();

      handlers.drop({
        dataTransfer: makeDataTransfer({ "application/x-mullion-session": "9" }),
        preventDefault,
      });

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(panel.api.setActive).toHaveBeenCalledTimes(1);
      expect(dropSessionPanel).not.toHaveBeenCalled();
    });

    it("drop: no matching session in the store preventDefaults and does not dock", () => {
      const { api } = makeMockApi();
      sessions = [];
      const { handlers } = attachAndGetHandlers(api);
      const preventDefault = vi.fn();

      handlers.drop({
        dataTransfer: makeDataTransfer({ "application/x-mullion-session": "3" }),
        preventDefault,
      });

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(dropSessionPanel).not.toHaveBeenCalled();
    });

    it("drop: docks onto empty grid space using the last tracked target, then closes the sidebar", () => {
      const { api } = makeMockApi();
      const session = makeSession({ id: 11 });
      sessions = [session];
      projects = [{ id: 1, name: "proj" }];
      const { handlers, setSidebarOpen } = attachAndGetHandlers(api);

      handlers.drop({
        dataTransfer: makeDataTransfer({ "application/x-mullion-session": "11" }),
        preventDefault: vi.fn(),
      });

      // No onUnhandledDragOver fired first in this test, so the tracked
      // target is still null — same as a drop that never crossed a group's
      // own droptarget overlay.
      expect(dropSessionPanel).toHaveBeenCalledWith(api, session, projects, null);
      expect(setSidebarOpen).toHaveBeenCalledWith(false);
    });

    it("removes all four listeners on unmount", () => {
      const { removeSpy, unmount } = attachAndGetHandlers(null);
      unmount();

      expect(removeSpy).toHaveBeenCalledWith("dragover", expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith("drop", expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith("dragend", expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith("dragleave", expect.any(Function));
    });
  });
});
