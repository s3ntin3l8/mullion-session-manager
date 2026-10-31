import { useEffect, useState } from "react";
import { api, ApiError } from "../api/index.js";
import type { SetupStatus } from "../api/index.js";
import { Modal } from "./Modal.js";

// Issue #2245 — the badge a session (its tab) and its task card show while the
// project's setup recipe runs in the session's fresh worktree, and after it.
// Clicking it opens the recipe's log. A failed or timed-out recipe never
// blocks the session; this is only the flag that says so.
const LABELS: Record<SetupStatus, string> = {
  running: "setup running",
  ok: "setup ok",
  failed: "setup failed",
  timeout: "setup timed out",
};

export function SetupBadge({
  sessionId,
  status,
}: {
  sessionId: number;
  status: SetupStatus | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  if (!status) return null;
  return (
    <>
      <button
        type="button"
        className={`setup-badge setup-badge-${status}`}
        title={`${LABELS[status]} — view the log`}
        aria-label={`${LABELS[status]}, view the setup log`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {LABELS[status]}
      </button>
      {open && (
        <SetupLogModal sessionId={sessionId} status={status} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function SetupLogModal({
  sessionId,
  status,
  onClose,
}: {
  sessionId: number;
  status: SetupStatus;
  onClose: () => void;
}) {
  const [log, setLog] = useState<{ content: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getSessionSetupLog(sessionId)
      .then((value) => {
        if (!cancelled) setLog(value);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof ApiError && err.statusCode === 404
            ? "No log yet — the recipe has not written any output."
            : "Couldn't load the setup log.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, status]);
  return (
    <Modal title="Setup log" subtitle={LABELS[status]} onClose={onClose}>
      {error ? (
        <div>{error}</div>
      ) : log === null ? (
        <div>Loading…</div>
      ) : (
        <>
          {log.truncated && <div>Showing the end of the log.</div>}
          <pre className="setup-log">{log.content || "(empty)"}</pre>
        </>
      )}
    </Modal>
  );
}
