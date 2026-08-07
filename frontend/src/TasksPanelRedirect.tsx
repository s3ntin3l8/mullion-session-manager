import { GridIcon, LayersIcon } from "./icons.js";

// The task board (formerly TasksPanel.tsx, a dockview panel) is now the
// unified Kanban view (UnifiedBoard.tsx) — see the "combine TaskPanel into
// the Kanban view" plan. This component replaces TasksPanel as the `tasks`
// dockview component so App.tsx's `components` registry can keep the id
// registered: an already-saved `workspaces.layout` blob (an opaque backend
// blob, never parsed server-side) referencing a "tasks" panel would
// otherwise throw when dockview-react's createComponent resolves an
// unregistered component name to `undefined` and hands it to
// ReactPanelContentPart, whose ReactPart.createPortal throws synchronously
// (its own isReactComponent guard rejects `undefined` before React.
// createElement is ever reached) — which fromJSON's own catch handles by
// reverting the ENTIRE restored layout, not just this one panel (verified
// against dockview-core's fromJSON/catch and dockview-react's ReactPart
// source).
//
// The follow-up cutover PR will also make App.tsx's restore effect call
// panelUtils.ts's closeLegacyPanels right after fromJSON, closing any
// restored "tasks" panel and scheduling a save — so in practice this
// component's own UI will rarely be seen once that lands: the sweep runs on
// every restore before a user could click through to it. That does NOT make
// this component deletable once blobs look clean: the sweep only runs on a
// workspace that gets *activated* (restored) after the upgrade ships, and
// createComponent resolves DURING fromJSON, before the sweep has a chance to
// run — so this is what prevents the throw, not the sweep. A workspace never
// reactivated keeps a "tasks" id in its blob indefinitely. Keep this
// registered.
//
// This is unwired on this branch — nothing renders <TasksPanelRedirect> or
// registers it as the "tasks" dockview component yet (that's the cutover
// PR too). Note for that follow-up: a dockview panel component receives
// `{ params, api, containerApi }`, not a bare `onOpenBoard` callback — the
// registered component must be a small wrapper (same shape as the
// TasksPanelWrapper this replaces) that resolves `onOpenBoard` itself (e.g.
// `setViewMode("kanban")` + `props.api.close()`) and passes it down to this
// component as a plain prop, keeping this component itself dockview-agnostic
// and easy to unit test standalone.
export function TasksPanelRedirect({ onOpenBoard }: { onOpenBoard: () => void }) {
  return (
    <div className="tasks-panel-redirect">
      <LayersIcon size={20} />
      <div className="tasks-panel-redirect-title">The task board moved</div>
      <div className="tasks-panel-redirect-hint">
        Tasks now live in the Kanban view, alongside every session. This panel can be closed.
      </div>
      <button type="button" className="tasks-panel-redirect-open" onClick={onOpenBoard}>
        <GridIcon size={14} />
        Open the Kanban view
      </button>
    </div>
  );
}
