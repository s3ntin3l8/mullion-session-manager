import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { useDashboardStore } from "./store.js";
import { CreateGroupModal } from "./CreateGroupModal.js";
import { KebabMenu } from "./KebabMenu.js";
import { ConfirmButton } from "./ConfirmButton.js";
import { computeReorder } from "./reorder.js";
import type { ReorderItem } from "./reorder.js";
import type { Group, Session, Workspace } from "./api.js";
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  GridIcon,
  GripIcon,
  PlusIcon,
  RenameIcon,
} from "./icons.js";

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
// (design section 07, "workspace-group choreography") — native HTML5 DnD, no
// library, matching the rest of this app's zero-dependency style. See
// reorder.ts for the pure reindex math this file drives. (Group reordering
// was part of that same phase but was later dropped in favor of alphabetical
// sort — see git history if resurrecting it.)

// A workspace's `layout` is an opaque dockview blob (see api.ts) — this
// walks it generically looking for any `sessionId` value, without assuming
// dockview's exact panel-tree shape, so a workspace's live status dot can
// reflect whichever sessions it currently references.
function extractSessionIds(layout: Record<string, unknown> | null): Set<number> {
  const ids = new Set<number>();
  if (!layout) return ids;

  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        if (key === "sessionId" && typeof val === "number") ids.add(val);
        else visit(val);
      }
    }
  };
  visit(layout);
  return ids;
}

type WorkspaceLiveStatus = "attention" | "working" | null;

function workspaceLiveStatus(workspace: Workspace, sessions: Session[]): WorkspaceLiveStatus {
  const ids = extractSessionIds(workspace.layout);
  if (ids.size === 0) return null;
  const referenced = sessions.filter((s) => ids.has(s.id));
  if (referenced.some((s) => s.attention)) return "attention";
  if (referenced.some((s) => s.activity === "working")) return "working";
  return null;
}

// --- Drag-and-drop orchestration -------------------------------------------
//
// Design decision (advisor-reviewed, see the plan's Phase 4d): the grip
// handle is the drag *source*, never the row/header itself — this keeps
// click-to-select, double-click-rename, and text selection inside the
// rename input completely unaffected. A group header plays three roles at
// once (drag source for its own grip, drop target for a workspace being
// dragged in, drop-position indicator when another group is dragged) —
// disambiguated below by branching on `dragging.kind`, not by which handler
// fired.
type DragState = { kind: "workspace"; id: number };

type DropTarget =
  | { mode: "workspace-reorder"; groupId: number | null; index: number }
  | { mode: "workspace-assign"; groupId: number };

interface DragCtx {
  dragging: DragState | null;
  dropTarget: DropTarget | null;
  setDropTarget: (t: DropTarget | null) => void;
  startWorkspaceDrag: (id: number) => void;
  commitWorkspaceDrop: (groupId: number | null, index: number) => void;
  endDrag: () => void;
}

export function WorkspaceSwitcher() {
  const {
    workspaces,
    groups,
    sessions,
    activeWorkspaceId,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    setActiveWorkspaceId,
    refreshGroups,
    createGroup,
    updateGroup,
    deleteGroup,
    reorderWorkspaces,
  } = useDashboardStore();
  const [showNewWorkspace, setShowNewWorkspace] = useState(false);
  const [addGroupOpen, setAddGroupOpen] = useState(false);
  const [dragging, setDragging] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  useEffect(() => {
    void refreshGroups();
  }, [refreshGroups]);

  const sortedGroups = [...groups].sort((a, b) => a.name.localeCompare(b.name));
  const ungrouped = workspaces
    .filter((w) => w.groupId === null)
    .sort((a, b) => a.position - b.position);

  // dragTokenRef guards the deferred setDragging call below (see
  // startWorkspaceDrag): applying dragging state synchronously inside the
  // native `dragstart` handler races with the browser's own drag-session
  // setup — a DOM mutation landing in that same tick (e.g. the
  // `.ws-dragging` class + transform) can make Chrome cancel the drag it
  // just started, which showed up as "grabbing an ungrouped workspace does
  // nothing" (mid-drag `dragend` firing within ~5ms, no `drag` events ever
  // fired). Deferring the state update by a tick avoids that, but introduces
  // its own race: a very fast drag can call endDrag() (from the native
  // `dragend`) *before* the deferred update lands, and without a guard the
  // stale update would resurrect `dragging` after the drag already ended,
  // permanently stuck. The token makes the deferred update a no-op if any
  // start/end has happened since it was scheduled.
  const dragTokenRef = useRef(0);

  const endDrag = () => {
    dragTokenRef.current += 1;
    setDragging(null);
    setDropTarget(null);
  };

  const dragCtx: DragCtx = {
    dragging,
    dropTarget,
    setDropTarget,
    startWorkspaceDrag: (id) => {
      const token = (dragTokenRef.current += 1);
      setTimeout(() => {
        if (dragTokenRef.current === token) setDragging({ kind: "workspace", id });
      }, 0);
    },
    commitWorkspaceDrop: (groupId, index) => {
      if (!dragging || dragging.kind !== "workspace") return;
      const asItems: ReorderItem[] = workspaces.map((w) => ({
        id: w.id,
        groupId: w.groupId,
        position: w.position,
      }));
      void reorderWorkspaces(computeReorder(asItems, dragging.id, index, groupId));
    },
    endDrag,
  };

  return (
    <div className="workspace-switcher">
      <div className="sidebar-section-header">
        <span className="sidebar-section-title">Workspaces</span>
        <button
          className="toolbar-icon-btn"
          style={{ width: 22, height: 22 }}
          title="New workspace group"
          onClick={() => setAddGroupOpen(true)}
        >
          <PlusIcon size={15} strokeLinecap="round" strokeWidth={1.9} />
        </button>
      </div>

      {addGroupOpen && (
        <CreateGroupModal
          onClose={() => setAddGroupOpen(false)}
          onCreate={(name, color) => createGroup(name, color)}
        />
      )}

      {sortedGroups.map((group) => (
        <GroupSection
          key={group.id}
          group={group}
          workspaces={workspaces
            .filter((w) => w.groupId === group.id)
            .sort((a, b) => a.position - b.position)}
          sessions={sessions}
          activeWorkspaceId={activeWorkspaceId}
          onSelect={setActiveWorkspaceId}
          onRename={(id, name) => void renameWorkspace(id, name)}
          onDelete={(id) => void deleteWorkspace(id)}
          onToggleCollapsed={() => void updateGroup(group.id, { collapsed: !group.collapsed })}
          onEditGroup={(name, color) => void updateGroup(group.id, { name, color })}
          onRenameGroup={(name) => void updateGroup(group.id, { name })}
          onDeleteGroup={() => void deleteGroup(group.id)}
          dragCtx={dragCtx}
          onHeaderDragOver={(e) => {
            if (!dragCtx.dragging) return;
            e.preventDefault();
            dragCtx.setDropTarget({ mode: "workspace-assign", groupId: group.id });
          }}
          onHeaderDrop={(e) => {
            if (!dragCtx.dragging) return;
            e.preventDefault();
            if (dragCtx.dropTarget?.mode === "workspace-assign") {
              dragCtx.commitWorkspaceDrop(dragCtx.dropTarget.groupId, 0);
            }
            dragCtx.endDrag();
          }}
        />
      ))}

      <WorkspaceList
        bucketGroupId={null}
        items={ungrouped}
        dragCtx={dragCtx}
        activeWorkspaceId={activeWorkspaceId}
        sessions={sessions}
        onSelect={setActiveWorkspaceId}
        onRename={(id, name) => void renameWorkspace(id, name)}
        onDelete={(id) => void deleteWorkspace(id)}
      />

      <div style={{ padding: "4px 12px 10px" }}>
        {showNewWorkspace ? (
          <NewWorkspaceForm
            onCreated={(workspace) => {
              setShowNewWorkspace(false);
              setActiveWorkspaceId(workspace.id);
            }}
            onCancel={() => setShowNewWorkspace(false)}
            createWorkspace={createWorkspace}
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
  );
}

function GroupSection({
  group,
  workspaces,
  sessions,
  activeWorkspaceId,
  onSelect,
  onRename,
  onDelete,
  onToggleCollapsed,
  onEditGroup,
  onRenameGroup,
  onDeleteGroup,
  dragCtx,
  onHeaderDragOver,
  onHeaderDrop,
}: {
  group: Group;
  workspaces: Workspace[];
  sessions: Session[];
  activeWorkspaceId: number | null;
  onSelect: (id: number) => void;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number) => void;
  onToggleCollapsed: () => void;
  onEditGroup: (name: string, color: string) => void;
  onRenameGroup: (name: string) => void;
  onDeleteGroup: () => void;
  dragCtx: DragCtx;
  onHeaderDragOver?: (e: DragEvent<HTMLDivElement>) => void;
  onHeaderDrop?: (e: DragEvent<HTMLDivElement>) => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(group.name);
  // Unmounting the focused <input> below (setEditingName(false)) fires a
  // native blur before this render's closure ever sees the *new* draftName/
  // group.name — so without this guard, Enter's onRenameGroup call would
  // double-fire via onBlur's own (stale) "still differs" check, and Escape's
  // onBlur would see the pre-reset typed text and commit the very rename the
  // user just tried to cancel. Both keydown branches arm this so onBlur only
  // ever runs for an actual click-away.
  const suppressBlurRef = useRef(false);

  const isAssignTarget =
    dragCtx.dragging?.kind === "workspace" &&
    dragCtx.dropTarget?.mode === "workspace-assign" &&
    dragCtx.dropTarget.groupId === group.id;

  return (
    <div className="ws-group">
      <div
        className={`ws-group-header${isAssignTarget ? " ws-group-drop-target" : ""}`}
        onClick={onToggleCollapsed}
        onDragOver={onHeaderDragOver}
        onDrop={onHeaderDrop}
      >
        <ChevronDownIcon
          size={12}
          className={`ws-group-chevron${group.collapsed ? " collapsed" : ""}`}
        />
        <button
          type="button"
          className="ws-group-color"
          style={{ background: group.color ?? "var(--dim)" }}
          title="Change group color"
          onClick={(e) => {
            e.stopPropagation();
            setEditOpen(true);
          }}
        />
        {editingName ? (
          <input
            autoFocus
            className="workspace-rename-input"
            value={draftName}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                suppressBlurRef.current = true;
                if (draftName.trim()) onRenameGroup(draftName.trim());
                setEditingName(false);
              } else if (e.key === "Escape") {
                suppressBlurRef.current = true;
                setDraftName(group.name);
                setEditingName(false);
              }
            }}
            onBlur={() => {
              if (!suppressBlurRef.current && draftName.trim() && draftName !== group.name) {
                onRenameGroup(draftName.trim());
              }
              setEditingName(false);
            }}
          />
        ) : (
          <span
            className="ws-group-name"
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => {
              e.stopPropagation();
              suppressBlurRef.current = false;
              setDraftName(group.name);
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
            title="More…"
            items={[
              {
                key: "edit",
                label: "Edit",
                icon: <RenameIcon size={14} style={{ color: "var(--muted)" }} />,
                onClick: () => setEditOpen(true),
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
        <div className="ws-group-body">
          <WorkspaceList
            bucketGroupId={group.id}
            items={workspaces}
            dragCtx={dragCtx}
            activeWorkspaceId={activeWorkspaceId}
            sessions={sessions}
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
// body, or the top-level ungrouped list) with drag-to-reorder and drag-to-
// reassign support. The dragged row itself stays rendered in place (with
// `.ws-dragging` styling) rather than being removed from the tree — native
// drag-and-drop snapshots the drag image at dragstart, so removing the
// source element mid-drag is an unnecessary risk for no benefit — while a
// running index counter that skips it gives every other row the correct
// "index within this bucket, excluding the dragged item" for
// reorder.ts's computeReorder, which expects exactly that.
function WorkspaceList({
  bucketGroupId,
  items,
  dragCtx,
  activeWorkspaceId,
  sessions,
  onSelect,
  onRename,
  onDelete,
}: {
  bucketGroupId: number | null;
  items: Workspace[];
  dragCtx: DragCtx;
  activeWorkspaceId: number | null;
  sessions: Session[];
  onSelect: (id: number) => void;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number) => void;
}) {
  const { dragging, dropTarget, setDropTarget, commitWorkspaceDrop, endDrag } = dragCtx;
  const draggingWorkspaceId = dragging?.kind === "workspace" ? dragging.id : null;

  const showIndicator = (idx: number) =>
    draggingWorkspaceId !== null &&
    dropTarget?.mode === "workspace-reorder" &&
    dropTarget.groupId === bucketGroupId &&
    dropTarget.index === idx;

  // Same lookup-not-mutation approach as the top-level group list above.
  const nonDraggedIds = items.filter((w) => w.id !== draggingWorkspaceId).map((w) => w.id);

  return (
    <div
      className="ws-drop-list"
      onDragOver={(e) => {
        if (draggingWorkspaceId === null) return;
        e.preventDefault();
        const nonDraggedCount = items.filter((w) => w.id !== draggingWorkspaceId).length;
        setDropTarget({
          mode: "workspace-reorder",
          groupId: bucketGroupId,
          index: nonDraggedCount,
        });
      }}
      onDrop={(e) => {
        if (draggingWorkspaceId === null) return;
        e.preventDefault();
        const nonDraggedCount = items.filter((w) => w.id !== draggingWorkspaceId).length;
        commitWorkspaceDrop(
          bucketGroupId,
          dropTarget?.mode === "workspace-reorder" ? dropTarget.index : nonDraggedCount,
        );
        endDrag();
      }}
    >
      {items.length === 0 && draggingWorkspaceId !== null && (
        // An empty bucket has no rows to hover — without this, dragging a
        // workspace out of every group and into an all-empty ungrouped list
        // (this app's own real starting state: every workspace can start
        // out grouped, with nothing ungrouped to drop next to) would have
        // nowhere to land, since a childless `.ws-drop-list` collapses to
        // zero height. This placeholder gives it real, always-visible drop
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
              liveStatus={workspaceLiveStatus(workspace, sessions)}
              active={workspace.id === activeWorkspaceId}
              onSelect={() => onSelect(workspace.id)}
              onRename={(name) => onRename(workspace.id, name)}
              onDelete={() => onDelete(workspace.id)}
              drag={{
                isDragging: isThisDragging,
                isDimmed: draggingWorkspaceId !== null && !isThisDragging,
                onGripDragStart: () => dragCtx.startWorkspaceDrag(workspace.id),
                onGripDragEnd: endDrag,
                onRowDragOver: isThisDragging
                  ? undefined
                  : (e) => {
                      if (draggingWorkspaceId === null) return;
                      e.preventDefault();
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      const before = e.clientY < rect.top + rect.height / 2;
                      setDropTarget({
                        mode: "workspace-reorder",
                        groupId: bucketGroupId,
                        index: before ? idx : idx + 1,
                      });
                    },
                onRowDrop: isThisDragging
                  ? undefined
                  : (e) => {
                      if (draggingWorkspaceId === null) return;
                      e.preventDefault();
                      e.stopPropagation();
                      commitWorkspaceDrop(
                        bucketGroupId,
                        dropTarget?.mode === "workspace-reorder" ? dropTarget.index : idx,
                      );
                      endDrag();
                    },
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
  onGripDragStart: () => void;
  onGripDragEnd: () => void;
  onRowDragOver?: (e: DragEvent<HTMLDivElement>) => void;
  onRowDrop?: (e: DragEvent<HTMLDivElement>) => void;
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
  const [draftName, setDraftName] = useState(workspace.name);
  const rowRef = useRef<HTMLDivElement>(null);
  // See the matching comment on GroupSection's suppressBlurRef — same
  // unmount-fires-blur-with-a-stale-closure hazard applies here.
  const suppressBlurRef = useRef(false);

  return (
    <div
      ref={rowRef}
      className={`workspace-item${active ? " active" : ""}${drag.isDragging ? " ws-dragging" : ""}${
        drag.isDimmed ? " ws-sibling-dim" : ""
      }`}
      onClick={onSelect}
      onDragOver={drag.onRowDragOver}
      onDrop={drag.onRowDrop}
    >
      <span
        className="ws-drag-handle"
        draggable
        title="Drag to reorder"
        onClick={(e) => e.stopPropagation()}
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(workspace.id));
          if (rowRef.current) {
            const rect = rowRef.current.getBoundingClientRect();
            e.dataTransfer.setDragImage(
              rowRef.current,
              e.clientX - rect.left,
              e.clientY - rect.top,
            );
          }
          drag.onGripDragStart();
        }}
        onDragEnd={drag.onGripDragEnd}
      >
        <GripIcon size={13} />
      </span>
      <GridIcon size={14} className="workspace-item-icon" />
      {editing ? (
        <input
          autoFocus
          className="workspace-rename-input"
          value={draftName}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              suppressBlurRef.current = true;
              if (draftName.trim()) onRename(draftName.trim());
              setEditing(false);
            } else if (e.key === "Escape") {
              suppressBlurRef.current = true;
              setDraftName(workspace.name);
              setEditing(false);
            }
          }}
          onBlur={() => {
            if (!suppressBlurRef.current && draftName.trim() && draftName !== workspace.name) {
              onRename(draftName.trim());
            }
            setEditing(false);
          }}
        />
      ) : (
        <span
          className="workspace-item-name"
          onDoubleClick={(e) => {
            e.stopPropagation();
            suppressBlurRef.current = false;
            setDraftName(workspace.name);
            setEditing(true);
          }}
        >
          {workspace.name}
        </span>
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
          title="More…"
          items={[
            {
              key: "edit",
              label: "Edit",
              icon: <RenameIcon size={14} style={{ color: "var(--muted)" }} />,
              onClick: () => {
                suppressBlurRef.current = false;
                setDraftName(workspace.name);
                setEditing(true);
              },
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
function NewWorkspaceForm({
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
      <input
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
