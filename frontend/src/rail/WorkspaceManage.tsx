import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { Group, Workspace } from "../api/index.js";
import { groupColor, useWorkspaceTree } from "../hooks/useWorkspaceTree.js";
import { ConfirmButton } from "../ui/ConfirmButton.js";
import { InlineRenameInput } from "../ui/InlineRenameInput.js";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  CloseIcon,
  FolderIcon,
  RenameIcon,
} from "../ui/icons.js";
import {
  deleteGroup,
  deleteWorkspace,
  moveWorkspace,
  renameGroup,
  renameWorkspace,
} from "../workspaceActions.js";

// What the workspace picker's "⋯" opened (#3048): a workspace's or a group's
// actions, shown in place of the list rather than in a menu of their own. The
// list is already a popover (fine pointer) or a sheet (coarse); a second,
// portaled menu on top would fight the popover's outside-click close and the
// sheet's stacking, and in place it is the same on desktop and touch.
export type ManageTarget =
  | { kind: "workspace"; id: number; step: "menu" | "rename" | "group" }
  | { kind: "group"; id: number; step: "menu" | "rename" };

export function WorkspaceManage({
  target,
  onChange,
  onBack,
  touch,
}: {
  target: ManageTarget;
  onChange: (target: ManageTarget) => void;
  // Back to the list (also after a delete).
  onBack: () => void;
  touch: boolean;
}) {
  const tree = useWorkspaceTree();
  const rootRef = useRef<HTMLDivElement>(null);

  // Each step lands focus on its first control, so a keyboard user is not
  // left on a button that just unmounted.
  useEffect(() => {
    if (target.step === "rename") return; // the field takes focus itself
    rootRef.current
      ?.querySelector<HTMLElement>(
        ".rail-ws-manage-body button:not(:disabled):not([aria-disabled='true'])",
      )
      ?.focus();
  }, [target.kind, target.id, target.step]);

  const workspace =
    target.kind === "workspace" ? tree.workspaces.find((w) => w.id === target.id) : undefined;
  const group =
    target.kind === "group" ? tree.sortedGroups.find((g) => g.id === target.id) : undefined;

  // Gone (deleted here or elsewhere): nothing left to manage.
  const missing = workspace === undefined && group === undefined;
  useEffect(() => {
    if (missing) onBack();
  }, [missing, onBack]);
  if (missing) return null;

  const stepBack = () => {
    if (target.step === "menu") onBack();
    else onChange({ ...target, step: "menu" } as ManageTarget);
  };
  // Escape goes back one step instead of closing the whole list. The rename
  // field handles its own Escape (and stops it).
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    stepBack();
  };

  const title = workspace?.name ?? group?.name ?? "";
  const deleteArmLabel = touch ? "Tap again to delete" : "Click again to delete";

  let body: ReactNode;
  let subtitle: string | null = null;
  if (workspace) {
    const bucketGroup =
      workspace.groupId !== null ? tree.sortedGroups.find((g) => g.id === workspace.groupId) : null;
    const bucket =
      workspace.groupId !== null ? tree.groupWorkspaces(workspace.groupId) : tree.ungrouped;
    const index = bucket.findIndex((w) => w.id === workspace.id);
    subtitle = `${index + 1} of ${bucket.length}${bucketGroup ? ` in ${bucketGroup.name}` : ", no group"}`;
    body = workspaceBody({
      workspace,
      step: target.step as "menu" | "rename" | "group",
      index,
      bucketLength: bucket.length,
      groups: tree.sortedGroups,
      bucketSize: (groupId) =>
        groupId === null ? tree.ungrouped.length : tree.groupWorkspaces(groupId).length,
      move: (groupId, toIndex) => moveWorkspace(tree.workspaces, workspace.id, groupId, toIndex),
      setStep: (step) => onChange({ kind: "workspace", id: workspace.id, step }),
      onDeleted: onBack,
      deleteArmLabel,
    });
  } else if (group) {
    const count = tree.groupWorkspaces(group.id).length;
    subtitle = `Group, ${count} workspace${count === 1 ? "" : "s"}`;
    body =
      target.step === "rename" ? (
        <InlineRenameInput
          name={group.name}
          ariaLabel="Group name"
          onCommit={(name) => renameGroup(group.id, name)}
          onDone={() => onChange({ kind: "group", id: group.id, step: "menu" })}
        />
      ) : (
        <>
          <button
            type="button"
            className="rail-ws-row"
            onClick={() => onChange({ kind: "group", id: group.id, step: "rename" })}
          >
            <RenameIcon size={14} aria-hidden="true" />
            <span className="rail-ws-row-name">Rename</span>
          </button>
          <ConfirmButton
            title="Delete group"
            className="rail-ws-row"
            armedLabel={deleteArmLabel}
            onConfirm={() => {
              deleteGroup(group.id);
              onBack();
            }}
          >
            <CloseIcon size={14} aria-hidden="true" />
            <span className="rail-ws-row-name">Delete group</span>
          </ConfirmButton>
        </>
      );
  }

  return (
    <div
      ref={rootRef}
      className="rail-ws-manage"
      role="group"
      aria-label={`Manage ${title}`}
      onKeyDown={onKeyDown}
    >
      <div className="rail-ws-manage-head">
        <button
          type="button"
          className="rail-ws-back"
          aria-label={target.step === "menu" ? "Back to workspaces" : "Back"}
          title={target.step === "menu" ? "Back to workspaces" : "Back"}
          // Keeps a rename field's focus: its blur would commit and leave the
          // rename step before this click, which would then step back twice.
          onMouseDown={(e) => e.preventDefault()}
          onClick={stepBack}
        >
          <ChevronLeftIcon size={15} aria-hidden="true" />
        </button>
        <span className="rail-ws-manage-title">
          {group && (
            <span
              className="rail-ws-group-color"
              style={{ background: groupColor(group) }}
              aria-hidden="true"
            />
          )}
          <span className="rail-ws-row-name">{title}</span>
          {subtitle && <span className="rail-ws-manage-sub">{subtitle}</span>}
        </span>
      </div>
      <div className="rail-ws-manage-body">{body}</div>
    </div>
  );
}

function workspaceBody({
  workspace,
  step,
  index,
  bucketLength,
  groups,
  bucketSize,
  move,
  setStep,
  onDeleted,
  deleteArmLabel,
}: {
  workspace: Workspace;
  step: "menu" | "rename" | "group";
  index: number;
  bucketLength: number;
  groups: Group[];
  bucketSize: (groupId: number | null) => number;
  move: (groupId: number | null, index: number) => void;
  setStep: (step: "menu" | "rename" | "group") => void;
  onDeleted: () => void;
  deleteArmLabel: string;
}): ReactNode {
  if (step === "rename") {
    return (
      <InlineRenameInput
        name={workspace.name}
        ariaLabel="Workspace name"
        onCommit={(name) => renameWorkspace(workspace.id, name)}
        onDone={() => setStep("menu")}
      />
    );
  }
  if (step === "group") {
    const choices: Array<{ id: number | null; name: string; color: string }> = [
      ...groups.map((g) => ({ id: g.id, name: g.name, color: groupColor(g) })),
      { id: null, name: "No group", color: groupColor(null) },
    ];
    return choices.map((choice) => {
      const current = choice.id === workspace.groupId;
      return (
        <button
          key={choice.id ?? "none"}
          type="button"
          className={`rail-ws-row${current ? " active" : ""}`}
          aria-current={current ? "true" : undefined}
          disabled={current}
          onClick={() => {
            // To the end of the group it joins.
            move(choice.id, bucketSize(choice.id));
            setStep("menu");
          }}
        >
          <span className="rail-ws-group-color" style={{ background: choice.color }} />
          <span className="rail-ws-row-name">{choice.name}</span>
          {current && <CheckIcon size={13} aria-hidden="true" />}
        </button>
      );
    });
  }
  return (
    <>
      <button type="button" className="rail-ws-row" onClick={() => setStep("rename")}>
        <RenameIcon size={14} aria-hidden="true" />
        <span className="rail-ws-row-name">Rename</span>
      </button>
      <button
        type="button"
        className="rail-ws-row"
        // aria-disabled, not disabled: the move that reaches the end must not
        // drop keyboard focus out of the popover from the button just pressed.
        aria-disabled={index <= 0 || undefined}
        onClick={() => {
          if (index > 0) move(workspace.groupId, index - 1);
        }}
      >
        <ChevronDownIcon size={14} aria-hidden="true" style={{ rotate: "180deg" }} />
        <span className="rail-ws-row-name">Move up</span>
      </button>
      <button
        type="button"
        className="rail-ws-row"
        aria-disabled={index < 0 || index >= bucketLength - 1 || undefined}
        onClick={() => {
          if (index >= 0 && index < bucketLength - 1) move(workspace.groupId, index + 1);
        }}
      >
        <ChevronDownIcon size={14} aria-hidden="true" />
        <span className="rail-ws-row-name">Move down</span>
      </button>
      <button type="button" className="rail-ws-row" onClick={() => setStep("group")}>
        <FolderIcon size={14} aria-hidden="true" />
        <span className="rail-ws-row-name">Move to group</span>
      </button>
      <ConfirmButton
        title="Delete workspace"
        className="rail-ws-row"
        armedLabel={deleteArmLabel}
        onConfirm={() => {
          deleteWorkspace(workspace.id);
          onDeleted();
        }}
      >
        <CloseIcon size={14} aria-hidden="true" />
        <span className="rail-ws-row-name">Delete workspace</span>
      </ConfirmButton>
    </>
  );
}
