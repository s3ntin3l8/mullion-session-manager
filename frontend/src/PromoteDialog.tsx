import { useState } from "react";
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
// = the project's current branch, or the model's own suggestedBaseRef when
// a promote request is pending.
export function PromoteDialog({
  session,
  project,
  onClose,
}: {
  session: Session;
  project: Project;
  onClose: () => void;
}) {
  const promoteSession = useDashboardStore((s) => s.promoteSession);
  const declinePromote = useDashboardStore((s) => s.declinePromote);

  const isPending = session.promoteState === "pending";

  const [baseRef, setBaseRef] = useState(session.promoteSuggestedBaseRef ?? "");
  const [branchName, setBranchName] = useState("");
  const [seedPrompt, setSeedPrompt] = useState(session.promoteSummary ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-extraction, this fetch had no `.catch` at all (an unhandled
  // rejection on failure) — useGitBranches always tracks its own `error`
  // internally, which this dialog doesn't read/render, so that unhandled
  // rejection is quietly absorbed rather than reproduced. A deliberate,
  // strictly-an-improvement side effect of sharing this hook with
  // CommandPalette.tsx (which does render its own error).
  const { branches, currentBranch } = useGitBranches(project.id, {
    onLoaded: ({ branches, currentBranch }) => {
      setBaseRef((prev) => prev || currentBranch || branches[0] || "");
    },
  });

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
      .then(onClose)
      .catch(() => {
        setSubmitting(false);
        setError("Failed to create the worktree — check that the base ref exists.");
      });
  };

  const cancel = () => {
    if (isPending) {
      void declinePromote(session.id).then(onClose);
    } else {
      onClose();
    }
  };

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
          <Dropdown
            value={baseRef}
            onChange={setBaseRef}
            options={branches.map((name) => ({
              value: name,
              label: name === currentBranch ? `${name} (current)` : name,
            }))}
          />
        </span>
        <span className="create-modal-field-hint">
          The new worktree's branch is created off this ref.
        </span>
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
          placeholder="Context for the new session — delivered as additional context when it starts."
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
