import { useEffect, useState } from "react";
import { api } from "./api/index.js";
import { ApiError } from "./api/client.js";
import type {
  BlockingAlertDismissal,
  BlockingAlertDismissReason,
  BlockingAlertEntry,
  BlockingAlertPriorDismissal,
  BlockingAlertsResponse,
} from "./api/blocking-alerts-types.js";
import { parseMergeBlockedThreads, safeGithubUrl } from "./needsHuman.js";

function priorText(d: BlockingAlertPriorDismissal): string {
  const reason = d.reason ?? "dismissed";
  const by = d.dismissedBy ? ` by ${d.dismissedBy}` : "";
  const comment = d.comment ? `: ${d.comment}` : "";
  return `#${d.number}${d.path ? ` ${d.path}` : ""}: ${reason}${by}${comment}`;
}

const COMMENT_MAX = 280;
const REASONS: BlockingAlertDismissReason[] = ["false positive", "won't fix", "used in tests"];

/** Inline confirm (the `notif-gate-*` pattern of DeleteTaskAction): restates
 * the rule and location, and needs a reason and a comment before it posts. */
function DismissAction({
  taskId,
  number,
  rule,
  where,
  onDismissed,
}: {
  taskId: number;
  number: number;
  rule: string;
  where: string | null;
  onDismissed: (d: BlockingAlertDismissal) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<BlockingAlertDismissReason>("false positive");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = comment.trim();
  const valid = trimmed.length > 0 && trimmed.length <= COMMENT_MAX;

  if (!open) {
    return (
      <div className="task-detail-actions">
        <button
          className="notif-gate-btn notif-gate-deny"
          data-testid="blocking-alert-dismiss"
          onClick={() => setOpen(true)}
        >
          Dismiss…
        </button>
      </div>
    );
  }
  return (
    <div className="blocking-alert-dismiss" data-testid="blocking-alert-dismiss-form">
      <div>
        {`Dismiss alert #${number} (${rule}${where ? ` at ${where}` : ""}) on GitHub, reply to its thread and resolve it? The merge is then retried.`}
      </div>
      <select
        aria-label="Dismissal reason"
        value={reason}
        disabled={submitting}
        onChange={(e) => setReason(e.target.value as BlockingAlertDismissReason)}
      >
        {REASONS.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <textarea
        aria-label="Dismissal comment"
        value={comment}
        disabled={submitting}
        rows={3}
        onChange={(e) => setComment(e.target.value)}
      />
      <div
        className="blocking-alert-note"
        data-testid="blocking-alert-counter"
      >{`${trimmed.length}/${COMMENT_MAX}`}</div>
      <div className="task-detail-actions">
        <button
          className="notif-gate-btn"
          disabled={submitting}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </button>
        <button
          className="notif-gate-btn notif-gate-deny-confirm"
          data-testid="blocking-alert-dismiss-confirm"
          disabled={!valid || submitting}
          onClick={async () => {
            setSubmitting(true);
            setError(null);
            try {
              const r = await api.dismissBlockingAlert(taskId, number, {
                reason,
                comment: trimmed,
              });
              onDismissed(r.dismissal);
              if (r.warning) setError(r.warning);
              setOpen(false);
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "Failed to dismiss the alert");
            }
            setSubmitting(false);
          }}
        >
          Confirm dismiss
        </button>
      </div>
      {error && <div className="task-detail-error">{error}</div>}
    </div>
  );
}

function auditText(d: BlockingAlertDismissal): string {
  const by = d.dismissedBy ? ` by ${d.dismissedBy}` : "";
  const when = new Date(d.createdAt).toLocaleString();
  const thread = d.threadResolved ? "" : " (thread left open)";
  return `Dismissed #${d.alertNumber} as ${d.reason}${by}, ${when}${thread}`;
}

function Entry({
  taskId,
  entry,
  dismissed,
  onDismissed,
}: {
  taskId: number;
  entry: BlockingAlertEntry;
  dismissed: boolean;
  onDismissed: (d: BlockingAlertDismissal) => void;
}) {
  if ("error" in entry) {
    return (
      <div className="blocking-alert" data-testid="blocking-alert">
        <div>{`Alert #${entry.number}: details unavailable (${entry.error})`}</div>
        {!entry.canDismiss.ok && (
          <div className="blocking-alert-note" data-testid="blocking-alert-note">
            {entry.canDismiss.reason}
          </div>
        )}
      </div>
    );
  }
  const { alert, snippet, priorDismissals, canDismiss } = entry;
  const alertUrl = safeGithubUrl(alert.htmlUrl);
  const where = alert.location ? `${alert.location.path}:${alert.location.startLine}` : null;
  const severity = alert.rule.securitySeverity ?? alert.rule.severity;
  return (
    <div className="blocking-alert" data-testid="blocking-alert">
      <div>
        <strong>{alert.rule.id}</strong>
        {severity ? ` (${severity})` : ""}
        {alertUrl && (
          <>
            {" · "}
            <a href={alertUrl} target="_blank" rel="noreferrer">{`alert #${entry.number}`}</a>
          </>
        )}
      </div>
      {alert.rule.description && <div>{alert.rule.description}</div>}
      {where && <div>{where}</div>}
      {alert.message && <div>{alert.message}</div>}
      {snippet && snippet.length > 0 && (
        <pre className="blocking-alert-snippet" data-testid="blocking-alert-snippet">
          {snippet.map((l) => (
            <code
              key={l.number}
              className={`blocking-alert-line${l.flagged ? " blocking-alert-line-flagged" : ""}`}
              data-flagged={l.flagged ? "true" : undefined}
            >
              {`${String(l.number).padStart(4)}  ${l.text}`}
            </code>
          ))}
        </pre>
      )}
      {priorDismissals && priorDismissals.dismissals.length > 0 && (
        <ul data-testid="blocking-alert-priors">
          {priorDismissals.dismissals.map((d) => {
            const url = safeGithubUrl(d.url);
            return (
              <li key={d.number}>
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer">
                    {priorText(d)}
                  </a>
                ) : (
                  priorText(d)
                )}
              </li>
            );
          })}
          {priorDismissals.otherPathCount > 0 && (
            <li>{`and ${priorDismissals.otherPathCount} more dismissed with this rule`}</li>
          )}
        </ul>
      )}
      {!canDismiss.ok && (
        <div className="blocking-alert-note" data-testid="blocking-alert-note">
          {canDismiss.reason}
        </div>
      )}
      {canDismiss.ok !== false && !dismissed && (
        <DismissAction
          taskId={taskId}
          number={entry.number}
          rule={alert.rule.id}
          where={where}
          onDismissed={onDismissed}
        />
      )}
    </div>
  );
}

/** Rule, code and past dismissals for the code-scanning alert(s) blocking a
 * task's merge. Fetched only when the stored thread detail names an alert, so
 * the task card (which renders only the #2989 line) makes no extra request. */
export function BlockingAlertDetail({
  taskId,
  raw,
}: {
  taskId: number;
  raw: string | null | undefined;
}) {
  const hasAlert =
    parseMergeBlockedThreads(raw)?.threads.some((t) => typeof t.alert?.number === "number") ??
    false;
  const [data, setData] = useState<BlockingAlertsResponse | null>(null);
  useEffect(() => {
    if (!hasAlert) return;
    let cancelled = false;
    api
      .getBlockingAlerts(taskId)
      .then((r) => !cancelled && setData(r))
      .catch(() => !cancelled && setData(null));
    return () => {
      cancelled = true;
    };
  }, [taskId, raw, hasAlert]);
  // After a dismissal the task's stored threads clear (`hasAlert` flips), so
  // the audit line stays on screen from the fetched data, not from `raw`.
  const dismissals = data?.dismissals ?? [];
  if (!data || (!hasAlert && dismissals.length === 0)) return null;
  const onDismissed = (d: BlockingAlertDismissal) =>
    setData((cur) => (cur ? { ...cur, dismissals: [...cur.dismissals, d] } : cur));
  return (
    <div data-testid="blocking-alerts">
      {hasAlert &&
        data.alerts.map((e) => (
          <Entry
            key={e.number}
            taskId={taskId}
            entry={e}
            dismissed={dismissals.some((d) => d.alertNumber === e.number)}
            onDismissed={onDismissed}
          />
        ))}
      {dismissals.map((d, i) => (
        <div key={`${d.alertNumber}-${i}`} data-testid="blocking-alert-audit">
          {auditText(d)}
        </div>
      ))}
    </div>
  );
}
