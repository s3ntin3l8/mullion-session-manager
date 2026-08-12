import { useEffect, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { DockviewApi } from "dockview-react";
import type { DockviewGroupDropLocation, DockviewGroupPanel, Position } from "dockview";
import { dropSessionPanel } from "../panelUtils.js";
import { useDashboardStore } from "../store/index.js";

export interface UseDockviewDropParams {
  dockviewApi: DockviewApi | null;
  // Must be the raw `useState` setter (stable identity forever) — same
  // requirement as `useWorkspacePersistence`'s `setPanelsVersion` and
  // `useMobileLayout`'s `setIsMobile` (see those hooks' own param comments).
  // An inline wrapper (e.g. `(v) => setSidebarOpen(v)`) would get a fresh
  // identity every render and, being read in these effects' dependency
  // arrays, re-subscribe every dockview/native listener below on every
  // render.
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
}

export interface UseDockviewDropResult {
  // Ref to the dockview container element for native DnD event handling
  // (sidebar session drag-to-dock — Task 3). Owned here (rather than in
  // App.tsx) since it exists purely to back this hook's native
  // dragover/drop/dragend/dragleave listener effect — but the DOM node it
  // points at is rendered by App.tsx itself (attached via
  // `<DockviewReact ref={dockviewRef} .../>`), so the ref object has to be
  // shared between the two rather than kept fully private.
  dockviewRef: RefObject<HTMLDivElement | null>;
}

// Extracted from App.tsx (PR 34c of the hook-extraction series) — sidebar
// session drag-to-dock: dragging a session row out of the Sidebar and
// dropping it onto the dockview grid to open/dock its panel. Three effects,
// all keyed off `dockviewApi`/`setSidebarOpen` only:
//
//   1. `onUnhandledDragOver` — shows drop indicators while dragging over the
//      workspace and records the last hovered drop target.
//   2. `onDidDrop` — dockview's own re-surfacing of drops it already handled
//      internally (onto an existing group's droptarget quadrant overlay,
//      which calls stopPropagation() on the native `drop` event before the
//      native listener below ever sees it — issue #121).
//   3. A native dragover/drop/dragend/dragleave listener on the dockview
//      container DOM node, for drops onto *empty* grid space (dockview has
//      no group there to intercept the drop, so it never reaches
//      `onDidDrop`).
//
// Effect ordering is NOT load-bearing here, unlike `useWorkspacePersistence`/
// `useMobileLayout`: nothing else in App.tsx reads `lastDropTargetRef`, and
// none of these three effects share state with the restore/mobile-layout
// effects or with each other beyond `lastDropTargetRef` itself (owned
// entirely inside this hook). Each effect is an independent subscription
// keyed only on `dockviewApi` (plus `setSidebarOpen`, whose identity never
// changes), so where App.tsx calls this hook relative to its other effects
// has no observable effect on behavior. Effect 3 in particular reads
// `dockviewRef.current` at setup time rather than depending on it directly —
// that's safe regardless of call position because React attaches a
// forwarded DOM ref during the commit phase, before ANY passive effect in
// the tree runs (this hook's own or any other's), so `dockviewRef.current`
// is already the mounted container by the time this effect's body executes,
// no matter where in App.tsx's render body this hook was called from. App.tsx
// still calls it at the exact position these three effects previously
// occupied (right after the mobile pane bar's rename-cancel effect, right
// before the global keyboard shortcuts effect) purely to keep the diff
// minimal and the file's effect ordering easy to audit — not because it's
// required.
export function useDockviewDrop({
  dockviewApi,
  setSidebarOpen,
}: UseDockviewDropParams): UseDockviewDropResult {
  const dockviewRef = useRef<HTMLDivElement>(null);
  const lastDropTargetRef = useRef<{
    group: DockviewGroupPanel | undefined;
    location: DockviewGroupDropLocation;
    position: Position;
  } | null>(null);

  // Sidebar drag-to-dock: subscribe to dockview's external drag-over events
  // so it shows drop indicators when a session row is dragged over the
  // workspace (the drag source sets application/x-mullion-session in dataTransfer).
  useEffect(() => {
    if (!dockviewApi) return;
    const disposable = dockviewApi.onUnhandledDragOver((event) => {
      const dt = event.nativeEvent instanceof DragEvent ? event.nativeEvent.dataTransfer : null;
      if (!dt || !dt.types.includes("application/x-mullion-session")) return;
      event.accept();
      lastDropTargetRef.current = {
        group: event.group,
        location: event.target,
        position: event.position,
      };
    });
    return () => disposable.dispose();
  }, [dockviewApi]);

  // Sidebar drag-to-dock onto an existing group: dockview's own droptarget
  // (the quadrant overlay shown while dragging over a pane) calls
  // stopPropagation() on the native `drop` event once it handles it, so the
  // native listener below never sees drops onto a group — only drops onto
  // empty grid space. dockview re-surfaces those handled drops via
  // onDidDrop, which is the only way to actually dock a session dragged onto
  // a pane (issue #121: "drag-and-drop onto a pane silently does nothing").
  // event.position is dockview's own quadrant classification for the drop:
  // "center" (including any drop on the tab bar) means add as a tab within
  // the group; any edge quadrant means split.
  useEffect(() => {
    if (!dockviewApi) return;
    const disposable = dockviewApi.onDidDrop((event) => {
      const dt = event.nativeEvent instanceof DragEvent ? event.nativeEvent.dataTransfer : null;
      const sessionIdStr = dt?.getData("application/x-mullion-session");
      if (!sessionIdStr) return;
      const sessionId = Number(sessionIdStr);
      if (isNaN(sessionId)) return;

      const panelId = `session-${sessionId}`;
      const existing = dockviewApi.getPanel(panelId);
      if (existing) {
        existing.api.setActive();
        return;
      }

      const { sessions, projects } = useDashboardStore.getState();
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return;

      dropSessionPanel(dockviewApi, session, projects, {
        group: event.group,
        location: event.position === "center" ? "content" : "edge",
        position: event.position,
      });
      lastDropTargetRef.current = null;
      setSidebarOpen(false);
    });
    return () => disposable.dispose();
  }, [dockviewApi, setSidebarOpen]);

  // Handle the native drop event for sidebar session drag-to-dock onto
  // *empty grid space* (dockview has no group there to intercept the drop, so
  // it reaches this listener rather than onDidDrop above). Reads the session
  // ID from dataTransfer and places the panel at the position tracked by
  // onUnhandledDragOver above, or docks into the grid when there's no target.
  useEffect(() => {
    const el = dockviewRef.current;
    if (!el) return;

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("application/x-mullion-session")) {
        e.preventDefault();
      }
    };

    const onDragEndOrLeave = (e: DragEvent) => {
      if (
        e.type === "dragleave" &&
        e.relatedTarget &&
        (e.currentTarget as Node)?.contains(e.relatedTarget as Node)
      ) {
        return;
      }
      lastDropTargetRef.current = null;
    };

    const onDrop = (e: DragEvent) => {
      const sessionIdStr = e.dataTransfer?.getData("application/x-mullion-session");
      if (!sessionIdStr) {
        e.preventDefault();
        lastDropTargetRef.current = null;
        return;
      }
      const sessionId = Number(sessionIdStr);
      if (isNaN(sessionId) || !dockviewApi) {
        e.preventDefault();
        lastDropTargetRef.current = null;
        return;
      }

      const panelId = `session-${sessionId}`;
      const existing = dockviewApi.getPanel(panelId);
      if (existing) {
        e.preventDefault();
        existing.api.setActive();
        lastDropTargetRef.current = null;
        return;
      }

      const { sessions, projects } = useDashboardStore.getState();
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) {
        e.preventDefault();
        lastDropTargetRef.current = null;
        return;
      }

      dropSessionPanel(dockviewApi, session, projects, lastDropTargetRef.current);
      lastDropTargetRef.current = null;
      setSidebarOpen(false);
    };

    el.addEventListener("dragover", onDragOver);
    el.addEventListener("drop", onDrop);
    el.addEventListener("dragend", onDragEndOrLeave);
    el.addEventListener("dragleave", onDragEndOrLeave);
    return () => {
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
      el.removeEventListener("dragend", onDragEndOrLeave);
      el.removeEventListener("dragleave", onDragEndOrLeave);
    };
  }, [dockviewApi, setSidebarOpen]);

  return { dockviewRef };
}
