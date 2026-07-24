import { useEffect, useState } from "react";
import { api } from "./api.js";
import type { Session, Project } from "./api.js";
import { useDashboardStore } from "./store.js";
import { Dropdown } from "./settings/primitives.js";
import { GitBranchIcon, CloseIcon } from "./icons.js";

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

  const [branches, setBranches] = useState<string[]>([]);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [baseRef, setBaseRef] = useState(session.promoteSuggestedBaseRef ?? "");
  const [branchName, setBranchName] = useState("");
  const [seedPrompt, setSeedPrompt] = useState(session.promoteSummary ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.getProjectGitBranches(project.id).then((result) => {
      if (cancelled || !result) return;
      const local = result.branches.map((b) => b.name);
      setBranches([...local, ...result.remoteBranches]);
      const current = result.branches.find((b) => b.isCurrent)?.name ?? null;
      setCurrentBranch(current);
      setBaseRef((prev) => prev || current || local[0] || "");
    });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

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

  return (
    <div className="create-modal-backdrop" onClick={cancel}>
      <div className="create-modal" onClick={(e) => e.stopPropagation()}>
        <div className="create-modal-header">
          <span className="create-modal-icon">
            <GitBranchIcon size={16} />
          </span>
          <span className="create-modal-header-text">
            <span className="create-modal-title">Promote to worktree</span>
            <span className="create-modal-subtitle">
              {isPending
                ? "The agent asked to start work in an isolated worktree."
                : "Move this session's work into a fresh, isolated worktree."}
            </span>
          </span>
          <button className="create-modal-close" onClick={cancel}>
            <CloseIcon size={15} />
          </button>
        </div>

        <div className="create-modal-body">
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
        </div>

        <div className="create-modal-footer">
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
        </div>
      </div>
    </div>
  );
}
