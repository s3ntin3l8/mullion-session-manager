import { useRef } from "react";
import type { GitHubPrDetail } from "../api/types.js";
import { BotIcon, MessageIcon, PlayTriangleIcon, PullIcon } from "../ui/icons.js";
import { Modal } from "../ui/Modal.js";
import { Button, IconButton } from "../ui/sidebar/index.js";
import type { NextStep } from "./prNextStep.js";

// The PR detail's action bar: ONE labelled button for what the PR needs next,
// then equal-size icon buttons for the rest. What the PR needs next is read
// from its phase, so the button says why a merge is not on offer instead of a
// merge button that is simply disabled.

export function PrActionBar({
  open,
  step,
  busy,
  sessionLabel,
  behind,
  composerOpen,
  onStep,
  onSession,
  onReReview,
  hermesLabel = "Re-review",
  onUpdateBranch,
  onToggleComposer,
}: {
  /** False for a closed or merged PR: only commenting is left. */
  open: boolean;
  step: NextStep;
  busy: boolean;
  /** "Open session" or "Open existing session". */
  sessionLabel: string;
  /** Behind its base but not required to update: the optional "Update branch". */
  behind: boolean;
  composerOpen: boolean;
  onStep: () => void;
  onSession: () => void;
  onReReview: () => void;
  /** Label of the Hermes re-review button; spelled out for a task PR, whose own reviewer is Task Master's. */
  hermesLabel?: string;
  onUpdateBranch: () => void;
  onToggleComposer: () => void;
}) {
  const comment = (
    <IconButton
      label="Comment or review"
      aria-pressed={composerOpen}
      className={composerOpen ? "sb-ibtn--on" : undefined}
      onClick={onToggleComposer}
    >
      <MessageIcon size={14} />
    </IconButton>
  );
  if (!open) {
    return (
      <div className="pr-actionbar" role="toolbar" aria-label="Pull request actions">
        <span className="pr-actionbar-next-spacer" />
        {comment}
      </div>
    );
  }
  return (
    <div className="pr-actionbar" role="toolbar" aria-label="Pull request actions">
      <Button
        variant={step.kind === "merge" ? "primary" : "secondary"}
        size="sm"
        className="pr-actionbar-next"
        disabled={step.disabled || busy}
        title={step.label}
        onClick={onStep}
      >
        {step.label}
      </Button>
      {behind && (
        <IconButton label="Update branch" disabled={busy} onClick={onUpdateBranch}>
          <PullIcon size={14} />
        </IconButton>
      )}
      <IconButton label={sessionLabel} disabled={busy} onClick={onSession}>
        <PlayTriangleIcon size={14} />
      </IconButton>
      <IconButton label={hermesLabel} disabled={busy} onClick={onReReview}>
        <BotIcon size={14} />
      </IconButton>
      {comment}
    </div>
  );
}

/**
 * Merging is the one action that cannot be undone, and the bar's primary
 * button changes meaning with the PR's state — so it is confirmed here, with
 * the commit message that will land, rather than by a second click in place.
 */
export function MergeConfirmModal({
  pr,
  busy,
  onCancel,
  onConfirm,
}: {
  pr: Pick<GitHubPrDetail, "number" | "title" | "baseBranch" | "headBranch">;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      // Escape, the backdrop and the X cannot dismiss a merge in flight, as
      // the Cancel button cannot. Nothing in the dialog is `disabled` meanwhile
      // (that would drop focus to the page behind): the buttons are
      // `aria-disabled` and ignore clicks.
      onClose={busy ? () => {} : onCancel}
      closeDisabled={busy}
      title={`Squash and merge #${pr.number}`}
      initialFocusRef={cancelRef}
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            className="sb-btn sb-btn--secondary"
            aria-disabled={busy || undefined}
            onClick={busy ? undefined : onCancel}
          >
            Cancel
          </button>
          <Button
            variant="primary"
            aria-disabled={busy || undefined}
            onClick={busy ? undefined : onConfirm}
          >
            {busy ? "Merging…" : "Merge"}
          </Button>
        </>
      }
    >
      <p className="pr-merge-line">
        <code>{pr.headBranch}</code> → <code>{pr.baseBranch}</code>
      </p>
      <p className="pr-merge-line">
        Commit message: <strong>{`${pr.title} (#${pr.number})`}</strong>
      </p>
    </Modal>
  );
}
