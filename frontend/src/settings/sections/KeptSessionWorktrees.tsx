import { useState } from "react";
import { api } from "../../api/index.js";
import type { Session, WorktreeKeptReason } from "../../api/index.js";
import { useDashboardStore } from "../../store/index.js";
import { formatRelativeAge } from "../../relativeTime.js";
import { ConfirmButton } from "../../ui/ConfirmButton.js";
import { ErrorText } from "../../ui/ErrorText.js";
import { SecondaryButton } from "../../ui/primitives.js";
import { describeError } from "../../lib/describeError.js";
import { FORCEABLE_REASONS, reasonMessage } from "../../git/gitReasons.js";
import { keptSessionWorktrees } from "./keptSessionWorktreesFilter.js";

// Issue #2026 — the isolated-session worktrees (#1964) that Mullion's reclaim
// sweep left in place, and why. Not the developer `.wt/` worktrees above them
// in Storage: these are the ones Mullion cut for a session (the launcher's
// isolate toggle, `--isolate`, promote_to_worktree) and tracks on its row.

const REASON_LABEL: Record<WorktreeKeptReason, string> = {
  "in-use": "another session is working in it",
  "still-running": "its process is still running",
  unpushed: "branch not pushed",
  "branch-missing": "its branch is gone",
  dirty: "uncommitted changes",
  conflicts: "merge conflicts",
  "remove-failed": "removal failed",
};

/** What the user can do about it, per reason. null: nothing beyond Remove. */
function Remedy({ reason, branch }: { reason: WorktreeKeptReason | null; branch: string }) {
  const [copied, setCopied] = useState(false);
  switch (reason) {
    case "unpushed": {
      const command = `git push -u origin ${branch}`;
      return (
        <span className="kept-worktree-remedy">
          Push it with an upstream and the next sweep removes it: <code>{command}</code>{" "}
          <SecondaryButton
            onClick={() => {
              void navigator.clipboard?.writeText(command).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            {copied ? "Copied" : "Copy"}
          </SecondaryButton>
        </span>
      );
    }
    case "dirty":
    case "conflicts":
      return (
        <span className="kept-worktree-remedy">
          Commit the work (and push it with <code>-u</code>) or discard it; the next sweep then
          removes the worktree.
        </span>
      );
    case "in-use":
    case "still-running":
      return (
        <span className="kept-worktree-remedy">
          Removed automatically once nothing is running in it.
        </span>
      );
    default:
      return null;
  }
}

function KeptRow({
  session,
  projectName,
  hostName,
  zebra,
}: {
  session: Session;
  projectName: string;
  hostName: string;
  zebra: boolean;
}) {
  const refreshSessions = useDashboardStore((s) => s.refreshSessions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; reason?: string } | null>(null);
  const path = session.cwd ?? "";
  const branch = session.worktreeBranch ?? "";
  const reason = session.worktreeKeptReason ?? null;
  const lastAttempt = session.worktreeLastAttemptAt
    ? formatRelativeAge(Date.parse(session.worktreeLastAttemptAt))
    : "not yet";

  const remove = async (force: boolean) => {
    setBusy(true);
    try {
      const result = await api.removeProjectGitWorktree(session.projectId, path, force, session.id);
      if (result.removed) {
        setError(null);
        await refreshSessions();
        return;
      }
      setError({ message: reasonMessage(result.reason, result.detail), reason: result.reason });
    } catch (err) {
      setError({ message: describeError(err, "Request failed — try again.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`settings-info-row kept-worktree-row${zebra ? " zebra" : ""}`}>
      <span className="settings-info-key">
        {projectName} · {hostName} · <code>{branch}</code>
      </span>
      <span className="settings-info-value">
        <span className="kept-worktree-path" title={path}>
          {path}
        </span>
        <span className="kept-worktree-reason">
          Kept: {reason ? REASON_LABEL[reason] : "not tried yet"} · last tried {lastAttempt}
        </span>
        <Remedy reason={reason} branch={branch} />
        {error && <ErrorText>{error.message}</ErrorText>}
        <span className="kept-worktree-actions">
          <ConfirmButton
            title={`Remove ${path} (the branch ${branch} is kept)`}
            armedLabel="Confirm remove"
            disabled={busy}
            onConfirm={() => void remove(false)}
          >
            Remove worktree
          </ConfirmButton>
          {error?.reason && FORCEABLE_REASONS.has(error.reason) && (
            <ConfirmButton
              title={`Force-remove ${path}, discarding its uncommitted changes`}
              armedLabel="Confirm force remove"
              disabled={busy}
              onConfirm={() => void remove(true)}
            >
              Force remove
            </ConfirmButton>
          )}
        </span>
      </span>
    </div>
  );
}

export function KeptSessionWorktrees() {
  const sessions = useDashboardStore((s) => s.sessions);
  const projects = useDashboardStore((s) => s.projects);
  const hosts = useDashboardStore((s) => s.hosts);
  const kept = keptSessionWorktrees(sessions);
  if (kept.length === 0) return null;

  const projectName = (id: number) => projects.find((p) => p.id === id)?.name ?? `project ${id}`;
  const hostName = (id: string) => hosts.find((h) => h.id === id)?.name ?? id;

  return (
    <>
      <div className="storage-subhead">Kept session worktrees</div>
      <div className="settings-info-table">
        {kept.map((session, i) => (
          <KeptRow
            key={session.id}
            session={session}
            projectName={projectName(session.projectId)}
            hostName={hostName(session.resolvedHostId)}
            zebra={i % 2 === 0}
          />
        ))}
      </div>
      <div className="settings-footer-note">
        Worktrees Mullion cut for an isolated session that it left in place when the session ended,
        because removing them could lose work. The sweep retries them, so fixing the reason is
        enough. Removing one here keeps its branch; only the directory, and what git ignores in it,
        goes.
      </div>
    </>
  );
}
