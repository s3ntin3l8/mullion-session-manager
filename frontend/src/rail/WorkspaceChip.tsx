import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { Workspace } from "../api/index.js";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
import { useVisualViewportChange } from "../hooks/useVisualViewportChange.js";
import { groupColor, useWorkspaceTree } from "../hooks/useWorkspaceTree.js";
import type { WorkspaceLiveStatus } from "../hooks/useWorkspaceTree.js";
import { matchesQuery } from "../matchQuery.js";
import { useDashboardStore } from "../store/index.js";
import { themeClassName } from "../store/theme.js";
import { BottomSheet } from "../ui/BottomSheet.js";
import { GridIcon, PlusIcon } from "../ui/icons.js";
import { SearchInput } from "../ui/primitives.js";
import { NewWorkspaceForm } from "../WorkspaceSwitcher.js";
import { chipPopoverPosition } from "../lib/railPopoverPosition.js";

export interface WorkspaceChipProps {
  /** Switch to a workspace (App's handleSelectWorkspace). */
  onSelectWorkspace: (workspaceId: number) => void;
  /** Coarse pointer: the list is a bottom sheet with touch-size rows. */
  sheet: boolean;
}

// The rail's workspace chip (#3009): the current workspace's initial in a
// square outlined in its group's colour, its name, and one colour square per
// workspace group (grey for ungrouped workspaces), the current group's
// outlined. Chip and squares are one button, which opens the workspace list:
// a popover beside the chip, or a sheet under a coarse pointer.
export function WorkspaceChip({ onSelectWorkspace, sheet }: WorkspaceChipProps) {
  const tree = useWorkspaceTree();
  const activeWorkspaceId = useDashboardStore((s) => s.activeWorkspaceId);
  const theme = useDashboardStore((s) => s.theme);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<ReturnType<typeof chipPopoverPosition> | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const current = tree.workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const currentGroup =
    current?.groupId != null
      ? (tree.sortedGroups.find((g) => g.id === current.groupId) ?? null)
      : null;
  const name = current?.name ?? "No workspace";
  const initial = current ? (Array.from(current.name.trim())[0] ?? "?").toUpperCase() : "–";

  const squares = [
    ...tree.sortedGroups.map((g) => ({
      key: `g${g.id}`,
      color: groupColor(g),
      title: g.name,
      current: current !== null && current.groupId === g.id,
    })),
    ...(tree.ungrouped.length > 0
      ? [
          {
            key: "ungrouped",
            color: groupColor(null),
            title: "Ungrouped",
            current: current !== null && current.groupId === null,
          },
        ]
      : []),
  ];

  const reposition = useCallback(() => {
    if (!btnRef.current) return;
    setPos(
      chipPopoverPosition(
        btnRef.current.getBoundingClientRect(),
        window.innerWidth,
        window.innerHeight,
      ),
    );
  }, []);
  useVisualViewportChange(open && !sheet, reposition);

  const close = () => setOpen(false);
  const pick = (id: number) => {
    setOpen(false);
    onSelectWorkspace(id);
  };

  useEffect(() => {
    if (!open || sheet) return;
    const onOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open, sheet]);

  const { onKeyDown: onTrapKeyDown } = useFocusTrap({
    active: open && !sheet,
    containerRef: panelRef,
  });
  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
      btnRef.current?.focus();
      return;
    }
    onTrapKeyDown(e);
  };

  const groupTitle = currentGroup ? `, group ${currentGroup.name}` : "";
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="rail-ws-chip"
        aria-label={`Switch workspace, current: ${name}${groupTitle}`}
        title={`${name}${currentGroup ? ` (${currentGroup.name})` : ""}: switch workspace`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (!open && !sheet) reposition();
          setOpen((v) => !v);
        }}
      >
        <span
          className="rail-ws-initial"
          style={
            current
              ? { borderColor: groupColor(currentGroup), color: groupColor(currentGroup) }
              : undefined
          }
          aria-hidden="true"
        >
          {initial}
        </span>
        <span className="left-rail-label rail-ws-name" aria-hidden="true">
          {name}
        </span>
        {squares.length > 0 && (
          <span className="rail-ws-squares" aria-hidden="true">
            {squares.map((sq) => (
              <span
                key={sq.key}
                className={`rail-ws-square${sq.current ? " current" : ""}`}
                style={{ background: sq.color }}
                data-square={sq.key}
              />
            ))}
          </span>
        )}
      </button>
      {sheet ? (
        <BottomSheet
          open={open}
          onClose={close}
          label="Workspaces"
          closeLabel="Close workspaces"
          title="Workspaces"
          // The tablet width cap the session sheet uses (compact.css).
          sheetClassName="rail-ws-sheet mobile-session-sheet--tablet"
          backStack
        >
          {open && <WorkspaceListContent onPick={pick} touch />}
        </BottomSheet>
      ) : (
        open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            className={themeClassName(theme, "pane-tab-overflow-menu", "rail-ws-popover")}
            style={{ position: "fixed", top: pos.top, left: pos.left, maxHeight: pos.maxHeight }}
            role="dialog"
            aria-label="Workspaces"
            onKeyDown={onPanelKeyDown}
          >
            <WorkspaceListContent onPick={pick} touch={false} />
          </div>,
          document.body,
        )
      )}
    </>
  );
}

function LiveDot({ status }: { status: WorkspaceLiveStatus }) {
  if (status === "attention")
    return <span className="workspace-attn-dot" title="Session needs input" />;
  if (status === "working") return <span className="workspace-working-dot" title="Working" />;
  return null;
}

// The list's body: the sidebar's Workspaces section without its editing
// (groups in their colour with their workspaces, then the ungrouped ones, live
// dots, "New workspace"), plus a search box. Groups are shown expanded here:
// their collapsed state belongs to the sidebar, which persists it.
export function WorkspaceListContent({
  onPick,
  touch,
}: {
  onPick: (workspaceId: number) => void;
  /** Touch-size rows, and no autofocus that would raise the keyboard. */
  touch: boolean;
}) {
  const tree = useWorkspaceTree();
  const activeWorkspaceId = useDashboardStore((s) => s.activeWorkspaceId);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  const matching = (items: Workspace[], groupName: string | null) =>
    query.trim() ? items.filter((w) => matchesQuery([w.name, groupName], query)) : items;

  const groupSections = tree.sortedGroups
    .map((group) => ({ group, items: matching(tree.groupWorkspaces(group.id), group.name) }))
    .filter((section) => section.items.length > 0 || !query.trim());
  const ungrouped = matching(tree.ungrouped, null);
  const nothing = query.trim() !== "" && groupSections.length === 0 && ungrouped.length === 0;

  const row = (w: Workspace) => (
    <button
      key={w.id}
      type="button"
      className={`rail-ws-row${w.id === activeWorkspaceId ? " active" : ""}`}
      aria-current={w.id === activeWorkspaceId ? "true" : undefined}
      onClick={() => onPick(w.id)}
    >
      <GridIcon size={14} aria-hidden="true" />
      <span className="rail-ws-row-name">{w.name}</span>
      <LiveDot status={tree.liveStatusOf(w.id)} />
    </button>
  );

  return (
    <div className={`rail-ws-list${touch ? " touch" : ""}`}>
      <SearchInput
        small={!touch}
        className="rail-ws-search"
        placeholder="Search workspaces"
        aria-label="Search workspaces"
        value={query}
        autoFocus={!touch}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="rail-ws-scroll">
        {groupSections.map(({ group, items }) => (
          <div key={group.id} className="rail-ws-group" role="group" aria-label={group.name}>
            <div className="rail-ws-group-header" aria-hidden="true">
              <span className="rail-ws-group-color" style={{ background: groupColor(group) }} />
              <span className="rail-ws-group-name">{group.name}</span>
            </div>
            {items.map(row)}
          </div>
        ))}
        {ungrouped.length > 0 && <div className="rail-ws-group">{ungrouped.map(row)}</div>}
        {nothing && <div className="rail-ws-empty">No matching workspace</div>}
      </div>
      <div className="rail-ws-new">
        {creating ? (
          <NewWorkspaceForm
            onCreated={(workspace) => {
              setCreating(false);
              onPick(workspace.id);
            }}
            onCancel={() => setCreating(false)}
            createWorkspace={(name) => useDashboardStore.getState().createWorkspace(name)}
          />
        ) : (
          <button
            type="button"
            className="rail-ws-row rail-ws-new-btn"
            onClick={() => setCreating(true)}
          >
            <PlusIcon size={13} strokeLinecap="round" strokeWidth={2.2} aria-hidden="true" />
            <span className="rail-ws-row-name">New workspace</span>
          </button>
        )}
      </div>
    </div>
  );
}
