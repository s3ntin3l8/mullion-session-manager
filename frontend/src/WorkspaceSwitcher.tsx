import { useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useDashboardStore } from "./store/index.js";
import { CreateGroupModal } from "./CreateGroupModal.js";
import { KebabMenu } from "./ui/KebabMenu.js";
import { ConfirmButton } from "./ui/ConfirmButton.js";
import {
  deleteGroup,
  deleteWorkspace,
  moveWorkspace,
  renameGroup,
  renameWorkspace,
} from "./workspaceActions.js";
import type { Group, Session, Workspace } from "./api/index.js";
import {
  deriveWorkspaceLiveStatus,
  groupColor,
  useWorkspaceTree,
  type WorkspaceLiveStatus,
} from "./hooks/useWorkspaceTree.js";
import { STORAGE_KEYS, readBool, writeBool } from "./lib/persistedState.js";
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  GridIcon,
  GripIcon,
  PlusIcon,
  RenameIcon,
} from "./ui/icons.js";
import { WORKSPACE_FOCUS_FALLBACK } from "./paletteFocusTargets.js";
import { usePointerReorder } from "./hooks/usePointerReorder.js";
import type { PointerReorderState } from "./hooks/usePointerReorder.js";
import { TextInput } from "./ui/primitives.js";
import { InlineRenameInput } from "./ui/InlineRenameInput.js";

// Workspaces (named, persistent split-layouts — Mullion's own "tab" concept)
// and Projects/Sessions (the folder-grouped inventory of durable terminals
// you pull *into* a workspace) are two orthogonal, independently-scoped
// trees: a session can appear in any number of workspaces' layouts, and a
// workspace's layout can reference sessions from any project. This section
// sits above the Projects tree in the sidebar as the primary "which layout
// am I looking at" navigation, matching that ordering.
//
// Workspace Groups (vision #4): a collapsible named container a workspace
// can optionally belong to. Ported from the design's "Workspaces" section —
// groups render first (sorted alphabetically), then any ungrouped workspaces
// as a flat list below, same as before groups existed. Groups themselves are
// NOT drag-reorderable (alphabetical order is the whole point — nothing to
// choreograph); only workspaces are.
//
// Phase 4d added drag-and-drop for workspace reordering/group-assignment
// (design section 07, "workspace-group choreography"). See reorder.ts for the
// pure reindex math it drives. (Group reordering was part of that same phase
// but was later dropped in favor of alphabetical sort — see git history if
// resurrecting it.)
//
// #3224 — the drag is the same pointer drag as the rail's workspace picker
// (hooks/usePointerReorder.ts), so it works with a finger as well as a
// mouse. Only the grip handle starts it, never the row or header itself, so
// click-to-select, double-click-rename and text selection inside the rename
// input are unaffected. The hook hit-tests what this list renders:
//
// - each group's whole `.ws-group` box, header included, is a drop zone
//   (`data-drop-zone="<group id>"`): the header sits above the group's rows,
//   so a drop on it lands at index 0, and a collapsed group (a header and no
//   body) is still a target;
// - the ungrouped `.ws-drop-list` is the "no group" zone
//   (`data-drop-zone="none"`);
// - each workspace row is `data-drag-id="<workspace id>"`.
//
// Zones must not nest: a group's own inner list carries no zone attribute.

/** The nearest ancestor of `el` that scrolls vertically (the docked
 *  sidebar), where the drag auto-scrolls; `el` itself when none does. */
function scrollParent(el: HTMLElement): HTMLElement {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return el;
}

export interface WorkspaceSwitcherProps {
  onSelectWorkspace?: (workspaceId: number) => void;
}

export function WorkspaceSwitcher({ onSelectWorkspace }: WorkspaceSwitcherProps = {}) {
  // P1 perf fix — this used to be a single bare `useDashboardStore()` call
  // (no selector), subscribing to the ENTIRE store: any unrelated write
  // anywhere (settings, tasks, gitStatuses, the 4s sessions poll tick, …)
  // re-rendered this component, which re-walks every workspace's layout
  // (see P2/deriveWorkspaceLiveStatus above) and every group. Split into one
  // selector per field actually read for rendering, so this only re-renders
  // when one of THESE FIVE specifically changes identity. Actions are
  // deliberately NOT selected here — see the getState() calls at each call
  // site below, matching App.tsx's own established pattern for pure
  // action-callers (a store action's function identity never changes, so
  // selecting it wouldn't cost extra renders either, but getState() keeps
  // this component subscribed to strictly nothing but its own render data).
  const { workspaces, sessions, sortedGroups, groupWorkspaces, ungrouped, sessionIdsByWorkspace } =
    useWorkspaceTree();
  const activeWorkspaceId = useDashboardStore((s) => s.activeWorkspaceId);
  // Tasks-as-a-destination — Tasks isn't a workspace, so while it's the
  // active view (viewMode === "kanban") no workspace item should paint as
  // "active" here; that highlight would otherwise keep pointing at whatever
  // workspace was active before Tasks was opened, implying a scope Tasks
  // doesn't have. Only affects the WorkspaceItem `active` comparison below
  // (its one real read site) — the underlying activeWorkspaceId itself is
  // untouched, so switching back to list view restores the real highlight.
  const viewMode = useDashboardStore((s) => s.viewMode);
  const displayActiveWorkspaceId = viewMode === "kanban" ? null : activeWorkspaceId;
  const [showNewWorkspace, setShowNewWorkspace] = useState(false);
  const [addGroupOpen, setAddGroupOpen] = useState(false);
  // Sidebar declutter (issue #1465) — collapses the whole section, same
  // localStorage-backed boolean shape as App.tsx's own sidebarCollapsed.
  // Read once at mount (not through the Zustand store — this is a per-
  // browser UI preference with no backend field, same posture as
  // Sidebar.tsx's own `crs.projectCollapsed`).
  const [sectionCollapsed, setSectionCollapsed] = useState(() =>
    readBool(STORAGE_KEYS.workspacesSectionCollapsed, false),
  );
  const toggleSectionCollapsed = () => {
    const next = !sectionCollapsed;
    setSectionCollapsed(next);
    writeBool(STORAGE_KEYS.workspacesSectionCollapsed, next);
  };

  const handleSelectWorkspace = (id: number) => {
    if (onSelectWorkspace) {
      onSelectWorkspace(id);
    } else {
      useDashboardStore.getState().showWorkspace(id);
    }
  };

  // Sidebar declutter (issue #1465) — collapsing the section hides every
  // workspace's own attention/working dot; this rolls them up into one
  // aggregate dot on the header itself, same "signal survives collapse"
  // treatment ProjectHeader's own `project-attn-pill` gives a project's
  // sessions. Attention outranks working, matching deriveWorkspaceLiveStatus's
  // own per-workspace precedence.
  const aggregateLiveStatus = useMemo<WorkspaceLiveStatus>(() => {
    let working = false;
    for (const w of workspaces) {
      const status = deriveWorkspaceLiveStatus(sessionIdsByWorkspace.get(w.id), sessions);
      if (status === "attention") return "attention";
      if (status === "working") working = true;
    }
    return working ? "working" : null;
  }, [workspaces, sessionIdsByWorkspace, sessions]);

  // The list the drag hit-tests (the section body) and the element that
  // scrolls it (the whole sidebar), found when a drag starts.
  const listRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  const { dragging, onPointerDown } = usePointerReorder({
    scrollRef,
    listRef,
    enabled: true,
    onDrop: (id, target) => {
      const w = workspaces.find((x) => x.id === id);
      if (!w) return;
      const bucket = target.groupId === null ? ungrouped : groupWorkspaces(target.groupId);
      const from = bucket.findIndex((x) => x.id === id);
      // Dropped back where it was: nothing to save.
      if (target.groupId === w.groupId && target.index === from) return;
      moveWorkspace(workspaces, id, target.groupId, target.index);
    },
  });
  const startDrag = (id: number, e: ReactPointerEvent<HTMLElement>) => {
    if (listRef.current) scrollRef.current = scrollParent(listRef.current);
    onPointerDown(id, e);
  };

  return (
    <div className="workspace-switcher">
      {/* Sidebar declutter (issue #1465) — WORKSPACES gets the same
        collapse chevron every other sidebar section (Devices, each
        Project) already has, instead of always taking its ~5 rows of
        space. The row is not itself a button (#2886, axe `nested-interactive`:
        it holds the "+" button): the chevron and title are the disclosure
        button, and a click anywhere else on the row still toggles. */}
      <div className="sidebar-section-header ws-section-header" onClick={toggleSectionCollapsed}>
        <button
          type="button"
          className="ws-row-btn ws-section-toggle"
          aria-expanded={!sectionCollapsed}
          aria-controls="workspaces-section-body"
          onClick={(e) => {
            e.stopPropagation();
            toggleSectionCollapsed();
          }}
        >
          <ChevronDownIcon
            size={12}
            className={`ws-group-chevron${sectionCollapsed ? " collapsed" : ""}`}
          />
          <span className="sidebar-section-title">Workspaces</span>
        </button>
        {/* Collapsing hides every workspace's own attention/working dot —
          this rolls them up into one aggregate so the signal survives
          collapse, same "signal survives collapse" treatment
          ProjectHeader's own project-attn-pill gives a project's sessions. */}
        {sectionCollapsed && aggregateLiveStatus === "attention" && (
          <span
            className="workspace-attn-dot"
            role="img"
            aria-label="A workspace has a session that needs input"
            title="A workspace has a session that needs input"
          />
        )}
        {sectionCollapsed && aggregateLiveStatus === "working" && (
          <span
            className="workspace-working-dot"
            role="img"
            aria-label="A workspace has a working session"
            title="A workspace has a working session"
          />
        )}
        <button
          className="toolbar-icon-btn"
          style={{ width: 22, height: 22 }}
          title="New workspace group"
          onClick={(e) => {
            e.stopPropagation();
            setAddGroupOpen(true);
          }}
        >
          <PlusIcon size={15} strokeLinecap="round" strokeWidth={1.9} />
        </button>
      </div>

      {addGroupOpen && (
        <CreateGroupModal
          onClose={() => setAddGroupOpen(false)}
          onCreate={(name, color) => useDashboardStore.getState().createGroup(name, color)}
        />
      )}

      {!sectionCollapsed && (
        <div id="workspaces-section-body" ref={listRef}>
          {sortedGroups.map((group) => (
            <GroupSection
              key={group.id}
              group={group}
              workspaces={groupWorkspaces(group.id)}
              sessions={sessions}
              sessionIdsByWorkspace={sessionIdsByWorkspace}
              activeWorkspaceId={displayActiveWorkspaceId}
              onSelect={(id) => handleSelectWorkspace(id)}
              // workspaceActions.ts reports a rejected request rather than
              // leaving it unhandled (audit finding 12).
              onRename={renameWorkspace}
              onDelete={deleteWorkspace}
              onToggleCollapsed={() =>
                void useDashboardStore
                  .getState()
                  .updateGroup(group.id, { collapsed: !group.collapsed })
              }
              onEditGroup={(name, color) =>
                void useDashboardStore.getState().updateGroup(group.id, { name, color })
              }
              onRenameGroup={(name) => renameGroup(group.id, name)}
              onDeleteGroup={() => deleteGroup(group.id)}
              dragging={dragging}
              onDragStart={startDrag}
            />
          ))}

          <WorkspaceList
            bucketGroupId={null}
            items={ungrouped}
            dropZone
            dragging={dragging}
            onDragStart={startDrag}
            activeWorkspaceId={displayActiveWorkspaceId}
            sessions={sessions}
            sessionIdsByWorkspace={sessionIdsByWorkspace}
            onSelect={(id) => handleSelectWorkspace(id)}
            onRename={renameWorkspace}
            onDelete={deleteWorkspace}
          />

          <div style={{ padding: "4px 12px 10px" }}>
            {showNewWorkspace ? (
              <NewWorkspaceForm
                onCreated={(workspace) => {
                  setShowNewWorkspace(false);
                  handleSelectWorkspace(workspace.id);
                }}
                onCancel={() => setShowNewWorkspace(false)}
                createWorkspace={(name) => useDashboardStore.getState().createWorkspace(name)}
              />
            ) : (
              <button
                className="discover-header"
                style={{ border: "1px dashed var(--border)", width: "100%" }}
                onClick={() => setShowNewWorkspace(true)}
              >
                <PlusIcon size={13} strokeLinecap="round" strokeWidth={2.2} />
                <span className="discover-title">New workspace</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function GroupSection({
  group,
  workspaces,
  sessions,
  sessionIdsByWorkspace,
  activeWorkspaceId,
  onSelect,
  onRename,
  onDelete,
  onToggleCollapsed,
  onEditGroup,
  onRenameGroup,
  onDeleteGroup,
  dragging,
  onDragStart,
}: {
  group: Group;
  workspaces: Workspace[];
  sessions: Session[];
  sessionIdsByWorkspace: Map<number, Set<number>>;
  activeWorkspaceId: number | null;
  onSelect: (id: number) => void;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number) => void;
  onToggleCollapsed: () => void;
  onEditGroup: (name: string, color: string) => void;
  onRenameGroup: (name: string) => void;
  onDeleteGroup: () => void;
  dragging: PointerReorderState | null;
  onDragStart: (id: number, e: ReactPointerEvent<HTMLElement>) => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);

  // A collapsed group has no rows to draw the drop line between, so its
  // header lights up instead when the drag would land in it. (An expanded
  // group shows the line, or its empty "Drop here" box.)
  const isAssignTarget = group.collapsed && dragging?.target?.groupId === group.id;

  return (
    // The whole group, header included, is one drop zone (see the top of
    // this file).
    <div className="ws-group" data-drop-zone={group.id}>
      <div
        className={`ws-group-header${isAssignTarget ? " ws-group-drop-target" : ""}`}
        onClick={onToggleCollapsed}
        // Not itself a button (#2886, axe `nested-interactive`): it holds a
        // color swatch button, a rename input and an actions strip. The
        // chevron is the disclosure button; a click anywhere else on the
        // header still toggles.
      >
        <button
          type="button"
          className="ws-row-btn ws-group-toggle"
          aria-label={group.name}
          aria-expanded={!group.collapsed}
          // Pairs aria-expanded with the collapsible region it governs,
          // matching UnifiedBoard.tsx's own lane-collapse button — the
          // disclosure-button pattern the APG documents. The target only
          // exists in the DOM while expanded (see the body div below).
          aria-controls={`ws-group-body-${group.id}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapsed();
          }}
        >
          <ChevronDownIcon
            size={12}
            className={`ws-group-chevron${group.collapsed ? " collapsed" : ""}`}
          />
        </button>
        <button
          type="button"
          className="ws-group-color"
          style={{ background: groupColor(group) }}
          title="Change group color"
          onClick={(e) => {
            e.stopPropagation();
            setEditOpen(true);
          }}
        />
        {editingName ? (
          <InlineRenameInput
            name={group.name}
            onCommit={onRenameGroup}
            onDone={() => setEditingName(false)}
          />
        ) : (
          <span
            className="ws-group-name"
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditingName(true);
            }}
          >
            {group.name}
          </span>
        )}
        {isAssignTarget && <span className="ws-group-drop-label">drop here</span>}
        <span className="ws-group-count">{workspaces.length}</span>
        <span className="ws-group-actions" onClick={(e) => e.stopPropagation()}>
          <ConfirmButton title="Delete group" onConfirm={onDeleteGroup}>
            <CloseIcon size={13} />
          </ConfirmButton>
          <KebabMenu
            menuPlacement="auto"
            title="More…"
            items={[
              {
                key: "edit",
                label: "Edit",
                icon: <RenameIcon size={14} style={{ color: "var(--muted)" }} />,
                onClick: () => setEditOpen(true),
                // Opens the Edit-group modal, which traps focus itself.
                opensOverlay: true,
              },
              {
                key: "delete",
                label: "Delete group",
                armLabel: "Click again to delete",
                icon: <CloseIcon size={14} />,
                danger: true,
                confirm: true,
                onClick: onDeleteGroup,
              },
            ]}
          />
        </span>
      </div>
      {editOpen && (
        <div onClick={(e) => e.stopPropagation()}>
          <CreateGroupModal
            mode="edit"
            initialName={group.name}
            initialColor={group.color ?? undefined}
            onClose={() => setEditOpen(false)}
            onCreate={(name, color) => {
              onEditGroup(name, color);
              return Promise.resolve();
            }}
          />
        </div>
      )}
      {!group.collapsed && (
        <div className="ws-group-body" id={`ws-group-body-${group.id}`}>
          <WorkspaceList
            bucketGroupId={group.id}
            items={workspaces}
            dragging={dragging}
            onDragStart={onDragStart}
            activeWorkspaceId={activeWorkspaceId}
            sessions={sessions}
            sessionIdsByWorkspace={sessionIdsByWorkspace}
            onSelect={onSelect}
            onRename={onRename}
            onDelete={onDelete}
          />
        </div>
      )}
    </div>
  );
}

// Renders one bucket's worth of workspace rows (either a specific group's
// body, or the top-level ungrouped list) with the drop indicator where a
// dragged row would land. The dragged row itself stays rendered in place
// (with `.ws-dragging` styling): its handle holds the drag's pointer
// capture, and unmounting it would cancel the drag. A running index that
// skips it gives every other row its "index within this bucket, excluding
// the dragged item", the index rule of moveWorkspace and the drag hook.
function WorkspaceList({
  bucketGroupId,
  items,
  dropZone = false,
  dragging,
  onDragStart,
  activeWorkspaceId,
  sessions,
  sessionIdsByWorkspace,
  onSelect,
  onRename,
  onDelete,
}: {
  bucketGroupId: number | null;
  items: Workspace[];
  /** Whether this list is itself a drop zone (the ungrouped one); a group's
   *  list sits inside its group's zone. */
  dropZone?: boolean;
  dragging: PointerReorderState | null;
  onDragStart: (id: number, e: ReactPointerEvent<HTMLElement>) => void;
  activeWorkspaceId: number | null;
  sessions: Session[];
  sessionIdsByWorkspace: Map<number, Set<number>>;
  onSelect: (id: number) => void;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number) => void;
}) {
  const draggingWorkspaceId = dragging?.id ?? null;
  const target = dragging?.target;
  const showIndicator = (idx: number) =>
    target != null && target.groupId === bucketGroupId && target.index === idx;

  const nonDraggedIds = items.filter((w) => w.id !== draggingWorkspaceId).map((w) => w.id);

  return (
    <div className="ws-drop-list" data-drop-zone={dropZone ? "none" : undefined}>
      {items.length === 0 && draggingWorkspaceId !== null && (
        // An empty bucket has no rows to hover — without this, dragging a
        // workspace out of every group and into an all-empty ungrouped list
        // (this app's own real starting state: every workspace can start
        // out grouped, with nothing ungrouped to drop next to) would have
        // nowhere to land, since a childless `.ws-drop-list` collapses to
        // its 6px minimum. This placeholder gives it real, always-visible drop
        // area, matching the same dashed-dropzone idiom used elsewhere in
        // this app (e.g. the empty tiled grid).
        <div className="ws-drop-list-empty-hint">
          {bucketGroupId === null ? "Drop here to ungroup" : "Drop here"}
        </div>
      )}
      {items.map((workspace) => {
        const isThisDragging = draggingWorkspaceId === workspace.id;
        const idx = isThisDragging ? nonDraggedIds.length : nonDraggedIds.indexOf(workspace.id);

        return (
          <div key={workspace.id}>
            {!isThisDragging && showIndicator(idx) && <div className="ws-drop-indicator" />}
            <WorkspaceItem
              workspace={workspace}
              liveStatus={deriveWorkspaceLiveStatus(
                sessionIdsByWorkspace.get(workspace.id),
                sessions,
              )}
              active={workspace.id === activeWorkspaceId}
              onSelect={() => onSelect(workspace.id)}
              onRename={(name) => onRename(workspace.id, name)}
              onDelete={() => onDelete(workspace.id)}
              drag={{
                isDragging: isThisDragging,
                isDimmed: draggingWorkspaceId !== null && !isThisDragging,
                onHandlePointerDown: (e) => onDragStart(workspace.id, e),
              }}
            />
          </div>
        );
      })}
      {showIndicator(nonDraggedIds.length) && <div className="ws-drop-indicator" />}
    </div>
  );
}

interface WorkspaceItemDrag {
  isDragging: boolean;
  isDimmed: boolean;
  onHandlePointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
}

function WorkspaceItem({
  workspace,
  liveStatus,
  active,
  onSelect,
  onRename,
  onDelete,
  drag,
}: {
  workspace: Workspace;
  liveStatus: WorkspaceLiveStatus;
  active: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  drag: WorkspaceItemDrag;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <div
      data-drag-id={workspace.id}
      className={`workspace-item${active ? " active" : ""}${drag.isDragging ? " ws-dragging" : ""}${
        drag.isDimmed ? " ws-sibling-dim" : ""
      }`}
      // Not itself a button (#2886, axe `nested-interactive`): the row holds
      // a grip handle, a rename input and a delete/kebab strip. The name is
      // the row's one button; a click anywhere else on the row still selects.
      onClick={onSelect}
    >
      <span
        className="ws-drag-handle"
        title="Drag to reorder"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={drag.onHandlePointerDown}
      >
        <GripIcon size={13} />
      </span>
      <GridIcon size={14} className="workspace-item-icon" />
      {editing ? (
        <InlineRenameInput
          name={workspace.name}
          onCommit={onRename}
          onDone={() => setEditing(false)}
        />
      ) : (
        <button
          type="button"
          className="ws-row-btn workspace-item-name"
          // The palette's focus fallback after a workspace switch lands here
          // when the opener will not survive. Only the active row — a stale
          // highlight is not a place to put the caret.
          data-focus-fallback={active ? WORKSPACE_FOCUS_FALLBACK : undefined}
          // Which workspace is currently in effect. `aria-current` is how a
          // screen reader announces "you are here" in a list like this; the
          // visual `.active` class alone says nothing to one.
          aria-current={active ? "true" : undefined}
          onClick={(e) => {
            e.stopPropagation();
            onSelect();
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          {workspace.name}
        </button>
      )}
      {liveStatus === "attention" && (
        <span className="workspace-attn-dot" title="Session needs input" />
      )}
      {liveStatus === "working" && <span className="workspace-working-dot" title="Working" />}
      <span className="workspace-item-actions" onClick={(e) => e.stopPropagation()}>
        <ConfirmButton title="Delete workspace" onConfirm={onDelete}>
          <CloseIcon size={13} />
        </ConfirmButton>
        <KebabMenu
          menuPlacement="auto"
          title="More…"
          items={[
            {
              key: "edit",
              label: "Edit",
              icon: <RenameIcon size={14} style={{ color: "var(--muted)" }} />,
              onClick: () => setEditing(true),
            },
            {
              key: "delete",
              label: "Delete workspace",
              armLabel: "Click again to delete",
              icon: <CloseIcon size={14} />,
              danger: true,
              confirm: true,
              onClick: onDelete,
            },
          ]}
        />
      </span>
    </div>
  );
}

// Inline forms instead of window.prompt() — a native prompt() blocks the
// entire tab (same hazard as window.confirm(), fixed the same way in M3's
// ConfirmButton) until dismissed, freezing our own WS connections along
// with it. Renders in place of the "+ New workspace" button that summons
// it, so confirming/cancelling swaps it straight back — no extra rows.
export function NewWorkspaceForm({
  onCreated,
  onCancel,
  createWorkspace,
}: {
  onCreated: (workspace: Workspace) => void;
  onCancel: () => void;
  createWorkspace: (name: string) => Promise<Workspace>;
}) {
  const [name, setName] = useState("");

  return (
    <form
      className="new-workspace-inline"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        void createWorkspace(name.trim()).then(onCreated);
      }}
    >
      <TextInput
        small
        autoFocus
        className="workspace-rename-input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="workspace name"
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        onBlur={onCancel}
      />
      <button
        type="submit"
        className="new-workspace-confirm"
        title="Create workspace"
        onMouseDown={(e) => e.preventDefault()}
      >
        <CheckIcon size={13} strokeLinecap="round" strokeWidth={2.2} />
      </button>
    </form>
  );
}
