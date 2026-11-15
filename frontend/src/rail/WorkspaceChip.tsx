import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { Group, Workspace } from "../api/index.js";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
import { usePresence } from "../hooks/usePresence.js";
import { useVisualViewportChange } from "../hooks/useVisualViewportChange.js";
import { groupColor, useWorkspaceTree } from "../hooks/useWorkspaceTree.js";
import type { WorkspaceLiveStatus } from "../hooks/useWorkspaceTree.js";
import { matchesQuery } from "../matchQuery.js";
import { useDashboardStore } from "../store/index.js";
import { themeClassName } from "../store/theme.js";
import { BottomSheet } from "../ui/BottomSheet.js";
import {
  ChevronDownIcon,
  CloseIcon,
  FolderIcon,
  GridIcon,
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
      // listener), the picker only on the next press.
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
      {newGroupOpen && (
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
  // delete, which took the row's "⋯" with it, the search box, or under touch
  // (where focusing the field would raise the keyboard) "New workspace". A
  // fresh object per request; the effect handles each one once.
  const [focusRequest, setFocusRequest] = useState<{ key: string } | null>(null);
  const handledFocusRef = useRef<{ key: string } | null>(null);
  useEffect(() => {
    if (focusRequest === null || handledFocusRef.current === focusRequest) return;
    const list = listRef.current;
    const target =
      focusRequest.key === DELETED
        ? list?.querySelector<HTMLElement>(touch ? ".rail-ws-new-btn" : ".rail-ws-search")
        : list?.querySelector<HTMLElement>(`[data-manage="${focusRequest.key}"] .rail-ws-more`);
    // Not rendered yet: the next render brings it.
    if (!target) return;
    handledFocusRef.current = focusRequest;
    target.focus();
  }, [focusRequest, touch, tree.workspaces, tree.sortedGroups]);
  const focusAfter = (key: string) => setFocusRequest({ key });

  const deleteArmLabel = touch ? "Tap again to delete" : "Click again to delete";

  const matching = (items: Workspace[], groupName: string | null) =>
    query.trim() ? items.filter((w) => matchesQuery([w.name, groupName], query)) : items;

  const groupSections = tree.sortedGroups
    .map((group) => ({ group, items: matching(tree.groupWorkspaces(group.id), group.name) }))
    .filter((section) => section.items.length > 0 || !query.trim());
  const ungrouped = matching(tree.ungrouped, null);
  const nothing = query.trim() !== "" && groupSections.length === 0 && ungrouped.length === 0;

  const workspaceItems = (w: Workspace): KebabMenuItem[] => {
    const key = `workspace-${w.id}`;
    const bucket = w.groupId !== null ? tree.groupWorkspaces(w.groupId) : tree.ungrouped;
    const index = bucket.findIndex((x) => x.id === w.id);
    const bucketSize = (groupId: number | null) =>
      groupId === null ? tree.ungrouped.length : tree.groupWorkspaces(groupId).length;
    const move = (groupId: number | null, toIndex: number) => {
      moveWorkspace(tree.workspaces, w.id, groupId, toIndex);
      focusAfter(key);
    };
    // One item per group the workspace can move to (to the end of it), the
    // menu having no submenus; "No group" for a grouped one.
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
      {
        key: "up",
        label: "Move up",
        icon: <ChevronDownIcon size={14} aria-hidden="true" style={{ rotate: "180deg" }} />,
        disabled: index <= 0,
        opensOverlay: true,
        onClick: () => move(w.groupId, index - 1),
      },
      {
        key: "down",
        label: "Move down",
        icon: <ChevronDownIcon size={14} aria-hidden="true" />,
        disabled: index < 0 || index >= bucket.length - 1,
        opensOverlay: true,
        onClick: () => move(w.groupId, index + 1),
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
    return (
      <div key={w.id} className="rail-ws-item" data-manage={key}>
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
      <div className="rail-ws-scroll">
        {groupSections.map(({ group, items }) => {
          const key = `group-${group.id}`;
          return (
            <div key={group.id} className="rail-ws-group" role="group" aria-label={group.name}>
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
                {more(`Manage group ${group.name}`, group.name, groupItems(group))}
              </div>
              {items.map(row)}
            </div>
          );
        })}
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
