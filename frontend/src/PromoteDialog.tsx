import { useState } from "react";
import { ApiError } from "./api/index.js";
import type { Session, Project } from "./api/index.js";
import { useDashboardStore } from "./store/index.js";
import { useGitBranches } from "./hooks/useGitBranches.js";
import { Dropdown } from "./ui/primitives.js";
import { Modal } from "./ui/Modal.js";
import { GitBranchIcon } from "./ui/icons.js";

// Issue #271, option 2 — "promote an existing session" into a fresh git
// worktree. Reused for two triggers: a human's SessionRow kebab action
// (session.promoteState === "idle", nothing pending) and an agent-triggered
// `promote_to_worktree` MCP tool call (session.promoteState === "pending",
// which this dialog auto-opens for and must resolve one way or another —
// closing it without deciding would leave the model's tool call blocked
// until hooks.ts's own server-side timeout eventually declines it).
//
// Base-ref picker (the roadmap's "not one hardcoded rule" requirement for
// the interactive path): local branches + remote-tracking branches, default
// = the project's current branch — the model's own suggestedBaseRef is a
// starting point while branches are still loading, never a value the
// current-branch fetch is prevented from correcting (see `userEditedBaseRef`
// below: a bug found in production had the suggestion permanently pin
// `baseRef` via a `prev || …` guard, so a successful branches load could
// never override a stale/wrong suggestion — the worktree silently got cut
// from the wrong commit).
export function PromoteDialog({
  session,
  project,
  onClose,
  onPromoted,
}: {
  session: Session;
  project: Project;
  onClose: () => void;
  // Called with the newly-created replacement session once promote
  // succeeds, before onClose — lets the caller focus it (and close the
  // now-dead source pane) instead of the replacement silently existing only
  // in the sidebar. Without this, a promote from an open pane read as "my
  // session died and nothing replaced it" even though the backend really
  // did spawn a replacement.
  onPromoted?: (newSession: Session) => void;
}) {
  const promoteSession = useDashboardStore((s) => s.promoteSession);
  const declinePromote = useDashboardStore((s) => s.declinePromote);

  const isPending = session.promoteState === "pending";
  const suggestedBaseRef = session.promoteSuggestedBaseRef ?? null;

  const [baseRef, setBaseRef] = useState(suggestedBaseRef ?? "");
  // Tracks whether the user has explicitly chosen a ref (dropdown pick,
  // free-text edit, or clicking "Use suggestion"). Once true, neither the
  // branches load nor the initial suggestion is allowed to overwrite it.
  const [userEditedBaseRef, setUserEditedBaseRef] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [seedPrompt, setSeedPrompt] = useState(session.promoteSummary ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Issue #679 — non-fatal notes on an otherwise-successful promote (e.g.
  // resolvePendingPromote failed on a remote host). Distinct from `error`
  // above: the promoted session IS running, so this keeps the dialog open
  // to show the note (rather than silently closing per usual) instead of
  // treating it as a failed submission. Holds the promoted session itself
  // too — `onPromoted` (which tears down the source pane and focuses the
  // replacement) is deliberately deferred until the user acknowledges the
  // warning below, not fired the moment the response comes back; see
  // `acknowledgeWarnings`.
  const [promotedWithWarnings, setPromotedWithWarnings] = useState<{
    session: Session;
    warnings: string[];
  } | null>(null);

  const {
    branches,
    currentBranch,
    error: branchesError,
  } = useGitBranches(project.id, {
    onLoaded: ({ branches, currentBranch }) => {
      if (userEditedBaseRef) return;
      // Current branch wins over the model's suggestion once we actually
      // know it — the suggestion only exists as a fallback for when this
      // fetch never succeeds (rate-limited, host unreachable, etc.).
      setBaseRef(currentBranch || suggestedBaseRef || branches[0] || "");
    },
  });

  const setBaseRefManually = (ref: string) => {
    setUserEditedBaseRef(true);
    setBaseRef(ref);
  };

  // The dropdown only ever offers what git-branches returned; if that fetch
  // failed or is still pending, fall back to a free-text field so a known
  // suggestion (or a ref the user types themselves) is still submittable —
  // rather than an empty, unselectable control.
  const canPickFromList = branches.length > 0;
  const dropdownOptions = (
    baseRef && !branches.includes(baseRef) ? [baseRef, ...branches] : branches
  ).map((name) => ({
    value: name,
    label: name === currentBranch ? `${name} (current)` : name,
  }));

  const confirm = () => {
    const trimmedBaseRef = baseRef.trim();
    if (!trimmedBaseRef) return;
    setSubmitting(true);
    setError(null);
    void promoteSession(session.id, {
      baseRef: trimmedBaseRef,
      branchName: branchName.trim() || undefined,
      seedPrompt: seedPrompt.trim() || undefined,
    })
      .then((newSession) => {
        const newWarnings = newSession?.warnings ?? [];
        if (newWarnings.length > 0) {
          // Issue #679 — do NOT call onPromoted yet. onPromoted tears down
          // the source pane and focuses the replacement (Sidebar.tsx's
          // onSessionEnded+onOpenSession / PaneActionsMenu.tsx's
          // api.close()+openOrFocusSessionPanel), and this dialog may be
          // rendered from within that same source pane's tree. Running it
          // now, while the warning still needs to be shown, risks the
          // dialog being disposed alongside its parent before the user
          // ever sees the note — the same class of problem PR #680's
          // Hermes fix addressed for the throw case, just reached eagerly
          // instead of via a throw. Stay open and defer onPromoted to
          // `acknowledgeWarnings`, once the user closes this view.
          setSubmitting(false);
          setPromotedWithWarnings({ session: newSession, warnings: newWarnings });
          return;
        }
        // try/finally (Hermes review, PR #680): promote itself already
        // succeeded by this point — if onPromoted throws (e.g.
        // PaneActionsMenu's handler calling into a dockview api that's
        // since been torn down), the dialog must still leave `submitting`
        // in a settled state. Without this the dialog stayed mounted with
        // `submitting` stuck true, on top of whatever onPromoted's own
        // failure already did.
        try {
          onPromoted?.(newSession);
        } finally {
          onClose();
        }
      })
      .catch((err: unknown) => {
        setSubmitting(false);
        // Issue #677 — the backend now forwards the actual reason a
        // worktree failed to create (e.g. "a branch named '...' already
        // exists") as the error body's message, instead of always the same
        // generic "check that the base ref exists" regardless of cause.
        // Hermes review, this PR — specifically ApiError (a real response
        // from the backend), not `instanceof Error` generally: a
        // network-level failure (e.g. a fetch TypeError "Failed to fetch")
        // is also an Error, but its message isn't a backend-supplied reason
        // and would otherwise leak a confusing raw string instead of the
        // generic fallback.
        setError(
          err instanceof ApiError
            ? err.message
            : "Failed to create the worktree — check that the base ref exists.",
        );
      });
  };

  const cancel = () => {
    if (isPending) {
      void declinePromote(session.id).then(onClose);
    } else {
      onClose();
    }
  };

  // Issue #679 — the promote already succeeded by the time
  // `promotedWithWarnings` is set (see the `confirm` handler above); this
  // is an acknowledgment view, not a retry/cancel one, so it deliberately
  // doesn't reuse `cancel` (which would decline a since-resolved pending
  // promote request) or the ordinary base-ref/branch-name/seed form below.
  if (promotedWithWarnings) {
    // Fires onPromoted (pane teardown + replacement focus) only now, on
    // acknowledgment — see the comment in `confirm` for why this is
    // deferred rather than run the moment the response came back. Used for
    // the Close button AND Modal's own onClose (Escape/backdrop/header X),
    // so every path out of this view still hands off to the replacement.
    const acknowledgeWarnings = () => {
      try {
        onPromoted?.(promotedWithWarnings.session);
      } finally {
        onClose();
      }
    };
    return (
      <Modal
        onClose={acknowledgeWarnings}
        icon={<GitBranchIcon size={16} />}
        title="Promoted with a warning"
        footer={
          <button className="create-modal-submit" onClick={acknowledgeWarnings}>
            Close
          </button>
        }
      >
        {promotedWithWarnings.warnings.map((w) => (
          <p key={w} className="create-modal-field-hint" style={{ color: "var(--y)" }}>
            {w}
          </p>
        ))}
      </Modal>
    );
  }

  // PR 24 pilot — migrated onto the shared `ui/Modal.tsx` shell. Every
  // field/behavior below is unchanged from the hand-rolled version this
  // replaces; the only NEW behavior is what `Modal` itself adds: Escape now
  // closes the dialog (routed through `cancel`, so a pending promote request
  // still declines correctly, exactly like the header close button and
  // backdrop click already did), a Tab focus trap activates, and
  // `role="dialog"`/`aria-modal="true"` are now present. See `Modal`'s own
  // header comment for why `cancel` (not a bare `onClose`) is the right
  // thing to hand it.
  return (
    <Modal
      onClose={cancel}
      icon={<GitBranchIcon size={16} />}
      title="Promote to worktree"
      subtitle={
        isPending
          ? "The agent asked to start work in an isolated worktree."
          : "Move this session's work into a fresh, isolated worktree."
      }
      footer={
        <>
          <span className="create-modal-footer-hint">
            {isPending
              ? "Declining lets the agent continue on the main checkout."
              : "The source session is ended once the new one starts."}
          </span>
          <button className="create-modal-cancel" onClick={cancel}>
            {isPending ? "Decline" : "Cancel"}
          </button>
          <button className="create-modal-submit" disabled={submitting} onClick={confirm}>
            {submitting ? "Creating…" : "Create worktree"}
          </button>
        </>
      }
    >
      <label className="create-modal-field">
        <span className="create-modal-field-label">Base ref</span>
        <span className="create-modal-input-row">
          <GitBranchIcon size={15} style={{ color: "var(--muted)", flexShrink: 0 }} />
          {canPickFromList ? (
            <Dropdown value={baseRef} onChange={setBaseRefManually} options={dropdownOptions} />
          ) : (
            <input
              className="mono"
              value={baseRef}
              onChange={(e) => setBaseRefManually(e.target.value)}
              placeholder="e.g. main or origin/main"
            />
          )}
        </span>
        <span className="create-modal-field-hint">
          The new worktree's branch is created off this ref.
        </span>
        {branchesError && (
          <span className="create-modal-field-hint error">
            Couldn't load the branch list ({branchesError}) — type the ref directly.
          </span>
        )}
        {suggestedBaseRef && suggestedBaseRef !== baseRef && (
          <span className="create-modal-field-hint">
            The agent suggested <code className="mono">{suggestedBaseRef}</code> —{" "}
            <button
              type="button"
              className="create-modal-inline-link"
              onClick={() => setBaseRefManually(suggestedBaseRef)}
            >
              use it
            </button>
            .
          </span>
        )}
      </label>

      <label className="create-modal-field">
        <span className="create-modal-field-label">Branch name (optional)</span>
        <span className="create-modal-input-row">
          <input
            className="mono"
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            placeholder={`mullion/session-${session.id}`}
          />
        </span>
      </label>

      <label className="create-modal-field">
        <span className="create-modal-field-label">Seed prompt (optional)</span>
        <textarea
          className="create-modal-textarea"
          value={seedPrompt}
          onChange={(e) => setSeedPrompt(e.target.value)}
          placeholder="Context for the new session — sent as its first message, so it starts working right away."
          rows={4}
        />
      </label>

      {error && (
        <span className="create-modal-field-hint" style={{ color: "var(--r)" }}>
          {error}
        </span>
      )}
    </Modal>
  );
}
