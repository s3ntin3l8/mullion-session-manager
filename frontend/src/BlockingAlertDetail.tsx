import { useEffect, useState } from "react";
import { api } from "./api/index.js";
import type {
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

function Entry({ entry }: { entry: BlockingAlertEntry }) {
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
  if (!hasAlert || !data) return null;
  return (
    <div data-testid="blocking-alerts">
      {data.alerts.map((e) => (
        <Entry key={e.number} entry={e} />
      ))}
    </div>
  );
}
