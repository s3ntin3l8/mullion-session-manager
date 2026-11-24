import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Group, Workspace } from "../api/index.js";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
import { usePointerReorder } from "../hooks/usePointerReorder.js";
import { usePresence } from "../hooks/usePresence.js";
import { useVisualViewportChange } from "../hooks/useVisualViewportChange.js";
import { groupColor, useWorkspaceTree } from "../hooks/useWorkspaceTree.js";
import type { WorkspaceLiveStatus } from "../hooks/useWorkspaceTree.js";
import { matchesQuery } from "../matchQuery.js";
import { useDashboardStore } from "../store/index.js";
import { themeClassName } from "../store/theme.js";
import { BottomSheet } from "../ui/BottomSheet.js";
import {
  CloseIcon,
  FolderIcon,
  GridIcon,
  GripIcon,
  OverflowIcon,
  PlusIcon,
  RenameIcon,
} from "../ui/icons.js";
import { SearchInput } from "../ui/primitives.js";
import { NewWorkspaceForm } from "../WorkspaceSwitcher.js";
import { chipPopoverPosition } from "../lib/railPopoverPosition.js";
import { CreateGroupModal } from "../CreateGroupModal.js";
import { ThemedPortal } from "../ui/ThemedPortal.js";
import { InlineRenameInput } from "../ui/InlineRenameInput.js";
import { KebabMenu } from "../ui/KebabMenu.js";
import type { KebabMenuItem } from "../ui/KebabMenu.js";
import {
  deleteGroup,
  deleteWorkspace,
  moveWorkspace,
  renameGroup,
  renameWorkspace,
} from "../workspaceActions.js";
import { Presence } from "../ui/Presence.js";

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
  // The chip sits in the rail's scrolling middle region: follow it.
  useEffect(() => {
    if (!open || sheet) return;
    window.addEventListener("scroll", reposition, true);
    return () => window.removeEventListener("scroll", reposition, true);
  }, [open, sheet, reposition]);

  const close = () => setOpen(false);
  // "New group" leaves the list for CreateGroupModal: a modal inside the
  // popover would close with it on the first click, which lands outside it.
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const newGroup = () => {
    setOpen(false);
    setNewGroupOpen(true);
  };
  const pick = (id: number) => {
    setOpen(false);
    onSelectWorkspace(id);
  };

  useEffect(() => {
    if (!open || sheet) return;
    const onOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      // A row's "⋯" menu is open (#3073). It is portaled outside the panel,
      // and a press outside closes that menu first (KebabMenu's own
      // listener), the picker only on the next press. This probe relies on
      // KebabMenu rendering its trigger inline (inside the panel, with
      // `aria-expanded`) and portaling only the menu: if the trigger ever
      // moves out of the panel, this check must change with it.
      if (panelRef.current?.querySelector('.rail-ws-more[aria-expanded="true"]')) return;
      setOpen(false);
      // The focused search box goes with the popover. Unless the click put
      // focus somewhere else, return it to the chip instead of <body>.
      requestAnimationFrame(() => {
        if (document.activeElement === document.body || document.activeElement === null) {
          btnRef.current?.focus();
        }
      });
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open, sheet]);

  const { onKeyDown: onTrapKeyDown } = useFocusTrap({
    active: open && !sheet,
    containerRef: panelRef,
  });
  // #3015 — stays mounted while it leaves (styles/motion.css plays the exit).
  const { present: popoverPresent, state: popoverPresence } = usePresence(open && !sheet, panelRef);
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
        // The name starts with the chip's visible text, the workspace name
        // (WCAG 2.5.3, axe's label-content-name-mismatch, #2886); the initial
        // is drawn by CSS from data-initial, so it is not part of that text.
        aria-label={`${name}${groupTitle}, switch workspace`}
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
          data-initial={initial}
          aria-hidden="true"
        />
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
                title={sq.title}
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
          sheetClassName="mobile-session-sheet--tablet"
          backStack
        >
          {open && <WorkspaceListContent onPick={pick} onNewGroup={newGroup} touch />}
        </BottomSheet>
      ) : (
        popoverPresent &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            data-presence={popoverPresence}
            inert={popoverPresence === "leaving"}
            className={themeClassName(theme, "pane-tab-overflow-menu", "rail-ws-popover")}
            style={{ position: "fixed", top: pos.top, left: pos.left, maxHeight: pos.maxHeight }}
            role="dialog"
            aria-label="Workspaces"
            onKeyDown={onPanelKeyDown}
          >
            <WorkspaceListContent onPick={pick} onNewGroup={newGroup} touch={false} />
          </div>,
          document.body,
        )
      )}
      <Presence when={newGroupOpen}>
        <ThemedPortal>
          <CreateGroupModal
            onClose={() => {
              setNewGroupOpen(false);
              // "New group" closed the list on its way here, so the dialog's
              // own focus return has nothing to go back to: the chip it was
              // opened from takes focus instead.
              btnRef.current?.focus();
            }}
            onCreate={(groupName, color) =>
              useDashboardStore.getState().createGroup(groupName, color)
            }
          />
        </ThemedPortal>
      </Presence>
    </>
  );
}

function LiveDot({ status }: { status: WorkspaceLiveStatus }) {
  if (status === "attention")
    return <span className="workspace-attn-dot" title="Session needs input" />;
  if (status === "working") return <span className="workspace-working-dot" title="Working" />;
  return null;
}

type Renaming = { kind: "workspace" | "group"; id: number };
const DELETED = "deleted";

// The list's body: the sidebar's Workspaces section (groups in their colour
// with their workspaces, then the ungrouped ones, live dots, "New workspace"),
// plus a search box. Groups are shown expanded here: their collapsed state
// belongs to the sidebar, which persists it. A row's one tap switches; its
// "⋯" opens that workspace's (or group's) actions in a menu beside the row,
// a bottom sheet under a coarse pointer (#3073, ui/KebabMenu.tsx), with the
// list left in place behind it. Rename happens on the row itself.
export function WorkspaceListContent({
  onPick,
  onNewGroup,
  touch,
}: {
  onPick: (workspaceId: number) => void;
  // "New group": the caller closes the list and opens CreateGroupModal.
  onNewGroup: () => void;
  /** Touch-size rows, and no autofocus that would raise the keyboard. */
  touch: boolean;
}) {
  const tree = useWorkspaceTree();
  const activeWorkspaceId = useDashboardStore((s) => s.activeWorkspaceId);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Where focus goes once the list has re-rendered: a row's "⋯" after a
  // rename, and after a move, which can re-mount the row under another group
  // (the menu's own focus return would find its trigger gone); after a
  // delete, which took the row's "⋯" with it, or when the row is not shown
  // (a search filters it out), the search box, or under touch (where
  // focusing the field would raise the keyboard) "New workspace". Only when
  // focus has fallen, a frame later: a rename ended by clicking elsewhere
  // leaves focus where that click put it.
  const [focusRequest, setFocusRequest] = useState<{ key: string; control: string } | null>(null);
  useEffect(() => {
    if (focusRequest === null) return;
    const frame = requestAnimationFrame(() => {
      // Focus still on the item just chosen, in the menu playing its exit
      // (inert), counts as fallen: it drops to <body> once the menu goes.
      const active = document.activeElement;
      const fallen =
        active === null ||
        active === document.body ||
        !active.isConnected ||
        active.closest('[role="menu"], [inert]') !== null;
      if (!fallen) return;
      const list = listRef.current;
      const row =
        focusRequest.key === DELETED
          ? null
          : list?.querySelector<HTMLElement>(
              `[data-manage="${focusRequest.key}"] ${focusRequest.control}`,
            );
      const target =
        row ?? list?.querySelector<HTMLElement>(touch ? ".rail-ws-new-btn" : ".rail-ws-search");
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, touch]);
  const focusAfter = (key: string, control = ".rail-ws-more") => setFocusRequest({ key, control });

  const deleteArmLabel = touch ? "Tap again to delete" : "Click again to delete";

  const matching = (items: Workspace[], groupName: string | null) =>
    query.trim() ? items.filter((w) => matchesQuery([w.name, groupName], query)) : items;

  const groupSections = tree.sortedGroups
    .map((group) => ({ group, items: matching(tree.groupWorkspaces(group.id), group.name) }))
    .filter((section) => section.items.length > 0 || !query.trim());
  const ungrouped = matching(tree.ungrouped, null);
  const nothing = query.trim() !== "" && groupSections.length === 0 && ungrouped.length === 0;
  const hasGroups = tree.sortedGroups.length > 0;

  // #3217 — reorder by dragging a row's handle (hooks/usePointerReorder.ts),
  // or with Arrow Up / Arrow Down on it. Not while a search filters the list:
  // the rows shown are then not the groups' real order.
  const scrollRef = useRef<HTMLDivElement>(null);
  const reorderable = query.trim() === "";
  const bucketOf = (groupId: number | null) =>
    groupId === null ? tree.ungrouped : tree.groupWorkspaces(groupId);
  const bucketName = (groupId: number | null) =>
    groupId === null
      ? "No group"
      : (tree.sortedGroups.find((g) => g.id === groupId)?.name ?? "No group");
  const [announcement, setAnnouncement] = useState("");
  const announceMove = (w: Workspace, groupId: number | null, index: number, size: number) =>
    setAnnouncement(
      `${w.name} moved to position ${index + 1} of ${size} in ${bucketName(groupId)}`,
    );
  const { dragging, onPointerDown } = usePointerReorder({
    scrollRef,
    enabled: reorderable,
    onDrop: (id, target) => {
      const w = tree.workspaces.find((x) => x.id === id);
      if (!w) return;
      const others = bucketOf(target.groupId).filter((x) => x.id !== id);
      const index = Math.min(target.index, others.length);
      const from = bucketOf(w.groupId).findIndex((x) => x.id === id);
      if (target.groupId === w.groupId && index === from) return;
      moveWorkspace(tree.workspaces, id, target.groupId, index);
      announceMove(w, target.groupId, index, others.length + 1);
    },
  });
  const keyboardMove = (w: Workspace, delta: -1 | 1) => {
    const bucket = bucketOf(w.groupId);
    const from = bucket.findIndex((x) => x.id === w.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= bucket.length) {
      setAnnouncement(
        `${w.name} is already ${delta < 0 ? "first" : "last"} in ${bucketName(w.groupId)}`,
      );
      return;
    }
    moveWorkspace(tree.workspaces, w.id, w.groupId, to);
    announceMove(w, w.groupId, to, bucket.length);
    // React may re-insert the row's node to reorder it, which drops focus.
    focusAfter(`workspace-${w.id}`, ".rail-ws-grip");
  };
  const hintId = useId();

  const workspaceItems = (w: Workspace): KebabMenuItem[] => {
    const key = `workspace-${w.id}`;
    const bucketSize = (groupId: number | null) =>
      groupId === null ? tree.ungrouped.length : tree.groupWorkspaces(groupId).length;
    const move = (groupId: number | null, toIndex: number) => {
      moveWorkspace(tree.workspaces, w.id, groupId, toIndex);
      focusAfter(key);
    };
    // One item per group the workspace can move to (to the end of it), the
    // menu having no submenus; "No group" for a grouped one. These are the
    // keyboard and screen-reader path between groups; order within a group
    // is the handle's (drag, or Arrow Up / Arrow Down), #3217.
    const groupMoves: KebabMenuItem[] = [
      ...tree.sortedGroups
        .filter((g) => g.id !== w.groupId)
        .map((g) => ({
          key: `group-${g.id}`,
          label: `Move to ${g.name}`,
          icon: <FolderIcon size={14} aria-hidden="true" style={{ color: groupColor(g) }} />,
          opensOverlay: true,
          onClick: () => move(g.id, bucketSize(g.id)),
        })),
      ...(w.groupId !== null
        ? [
            {
              key: "group-none",
              label: "Move to No group",
              icon: <FolderIcon size={14} aria-hidden="true" />,
              opensOverlay: true,
              onClick: () => move(null, bucketSize(null)),
            },
          ]
        : []),
    ];
    return [
      {
        key: "rename",
        label: "Rename",
        icon: <RenameIcon size={14} aria-hidden="true" />,
        // The rename field takes focus: the menu must not pull it back.
        opensOverlay: true,
        onClick: () => setRenaming({ kind: "workspace", id: w.id }),
      },
      ...groupMoves,
      {
        key: "delete",
        label: "Delete workspace",
        armLabel: deleteArmLabel,
        icon: <CloseIcon size={14} aria-hidden="true" />,
        danger: true,
        confirm: true,
        opensOverlay: true,
        onClick: () => {
          deleteWorkspace(w.id);
          focusAfter(DELETED);
        },
      },
    ];
  };

  const groupItems = (group: Group): KebabMenuItem[] => [
    {
      key: "rename",
      label: "Rename",
      icon: <RenameIcon size={14} aria-hidden="true" />,
      opensOverlay: true,
      onClick: () => setRenaming({ kind: "group", id: group.id }),
    },
    {
      key: "delete",
      label: "Delete group",
      armLabel: deleteArmLabel,
      icon: <CloseIcon size={14} aria-hidden="true" />,
      danger: true,
      confirm: true,
      opensOverlay: true,
      onClick: () => {
        deleteGroup(group.id);
        focusAfter(DELETED);
      },
    },
  ];

  const isRenaming = (kind: Renaming["kind"], id: number) =>
    renaming?.kind === kind && renaming.id === id;
  const endRename = (key: string) => {
    setRenaming(null);
    focusAfter(key);
  };

  const more = (title: string, subject: string, items: KebabMenuItem[]) => (
    <KebabMenu
      items={items}
      title={title}
      menuLabel={`${subject} actions`}
      triggerClassName="rail-ws-more"
      trigger={<OverflowIcon size={15} aria-hidden="true" />}
      // Beside the row, over the picker, the list left visible (#3073).
      menuPlacement="side"
      menuClassName="rail-ws-menu"
      sheet={{ title: subject, closeLabel: `Close ${subject} actions` }}
    />
  );

  const row = (w: Workspace) => {
    const key = `workspace-${w.id}`;
    const isDragged = dragging?.id === w.id;
    return (
      <div
        key={w.id}
        className={`rail-ws-item${isDragged ? " dragging" : ""}`}
        data-manage={key}
        data-drag-id={w.id}
      >
        <button
          type="button"
          className="rail-ws-grip"
          aria-label={`Reorder ${w.name}`}
          aria-describedby={reorderable ? hintId : undefined}
          title={reorderable ? "Drag to reorder" : "Clear the search to reorder"}
          disabled={!reorderable}
          onPointerDown={(e) => onPointerDown(w.id, e)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            keyboardMove(w, e.key === "ArrowUp" ? -1 : 1);
          }}
        >
          <GripIcon size={14} aria-hidden="true" />
        </button>
        {isRenaming("workspace", w.id) ? (
          <div className="rail-ws-row rail-ws-renaming">
            <GridIcon size={14} aria-hidden="true" />
            <InlineRenameInput
              name={w.name}
              ariaLabel="Workspace name"
              onCommit={(name) => renameWorkspace(w.id, name)}
              onDone={() => endRename(key)}
            />
          </div>
        ) : (
          <button
            type="button"
            className={`rail-ws-row${w.id === activeWorkspaceId ? " active" : ""}`}
            aria-current={w.id === activeWorkspaceId ? "true" : undefined}
            onClick={() => onPick(w.id)}
          >
            <GridIcon size={14} aria-hidden="true" />
            <span className="rail-ws-row-name">{w.name}</span>
            <LiveDot status={tree.liveStatusOf(w.id)} />
          </button>
        )}
        {more(`Manage ${w.name}`, w.name, workspaceItems(w))}
      </div>
    );
  };

  // A section's rows, with the drop indicator where the dragged row would
  // land (indices count the other rows only, the drop's own rule).
  const rows = (groupId: number | null, items: Workspace[], emptyHint: string | null) => {
    const target = dragging?.target;
    const at = target && target.groupId === groupId ? target.index : -1;
    const out: ReactNode[] = [];
    let index = 0;
    for (const w of items) {
      if (w.id !== dragging?.id) {
        if (index === at) out.push(<div key="drop" className="rail-ws-drop-indicator" />);
        index += 1;
      }
      out.push(row(w));
    }
    // An empty section's own box lights up instead (.drop-target).
    if (at >= index && items.length > 0)
      out.push(<div key="drop" className="rail-ws-drop-indicator" />);
    if (items.length === 0 && emptyHint)
      out.push(
        <div key="empty" className="rail-ws-drop-empty">
          {emptyHint}
        </div>,
      );
    return out;
  };
  const zoneClass = (groupId: number | null, extra: string) =>
    `rail-ws-group ${extra}${dragging?.target?.groupId === groupId ? " drop-target" : ""}`;

  // Groups read as a hierarchy (#3217): a header in the group's colour (a
  // label, not a row), its workspaces indented under it, and the ungrouped
  // ones in a "No group" section of their own once any group exists. Each
  // section is a drop zone, an empty one included.
  return (
    <div ref={listRef} className={`rail-ws-list${touch ? " touch" : ""}`}>
      <SearchInput
        small={!touch}
        className="rail-ws-search"
        placeholder="Search workspaces"
        aria-label="Search workspaces"
        value={query}
        autoFocus={!touch}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div ref={scrollRef} className={`rail-ws-scroll${dragging ? " reordering" : ""}`}>
        {groupSections.map(({ group, items }) => {
          const key = `group-${group.id}`;
          return (
            <div
              key={group.id}
              className={zoneClass(group.id, "grouped")}
              role="group"
              aria-label={group.name}
              data-drop-zone={group.id}
            >
              <div className="rail-ws-group-header" data-manage={key}>
                <span className="rail-ws-group-color" style={{ background: groupColor(group) }} />
                {isRenaming("group", group.id) ? (
                  <InlineRenameInput
                    name={group.name}
                    ariaLabel="Group name"
                    onCommit={(name) => renameGroup(group.id, name)}
                    onDone={() => endRename(key)}
                  />
                ) : (
                  <span className="rail-ws-group-name" aria-hidden="true">
                    {group.name}
                  </span>
                )}
                <span className="rail-ws-group-count" aria-hidden="true">
                  {/* The rows shown: the whole group, or its matches while a
                      search filters the list. */}
                  {items.length}
                </span>
                {more(`Manage group ${group.name}`, group.name, groupItems(group))}
              </div>
              <div className="rail-ws-group-body">
                {rows(group.id, items, reorderable ? "No workspaces: drag one here" : null)}
              </div>
            </div>
          );
        })}
        {(ungrouped.length > 0 || (dragging && hasGroups)) && (
          <div
            className={zoneClass(null, hasGroups ? "ungrouped" : "")}
            role="group"
            aria-label={hasGroups ? "No group" : "Workspaces"}
            data-drop-zone="none"
          >
            {hasGroups && (
              <div className="rail-ws-group-header rail-ws-ungrouped-header" aria-hidden="true">
                <span className="rail-ws-group-name">No group</span>
              </div>
            )}
            <div className="rail-ws-group-body">
              {rows(null, ungrouped, "Drop here to take it out of its group")}
            </div>
          </div>
        )}
        {nothing && <div className="rail-ws-empty">No matching workspace</div>}
      </div>
      <span id={hintId} className="visually-hidden">
        Drag, or press Arrow Up or Arrow Down, to reorder within the group.
      </span>
      <div className="visually-hidden" role="status" aria-live="polite">
        {announcement}
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
          <div className="rail-ws-new-row">
            <button
              type="button"
              className="rail-ws-row rail-ws-new-btn"
              onClick={() => setCreating(true)}
            >
              <PlusIcon size={13} strokeLinecap="round" strokeWidth={2.2} aria-hidden="true" />
              <span className="rail-ws-row-name">New workspace</span>
            </button>
            <button type="button" className="rail-ws-row rail-ws-new-btn" onClick={onNewGroup}>
              <PlusIcon size={13} strokeLinecap="round" strokeWidth={2.2} aria-hidden="true" />
              <span className="rail-ws-row-name">New group</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
