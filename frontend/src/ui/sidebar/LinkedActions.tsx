import { useState } from "react";
import { api } from "../../api/index.js";
import type { MullionLinkEntry } from "../../hooks/useMullionLinks.js";
import { useDashboardStore } from "../../store/index.js";
import { decideSessionAction } from "./linkDecisions.js";
import { Button } from "./Button.js";

export interface LinkedActionsProps {
  entry: MullionLinkEntry | undefined;
  /** Start a fresh session (Hand off / Open session on branch). */
  onStartSession?: () => void;
  onPreview?: () => void;
}

export function LinkedActions({ entry, onStartSession, onPreview }: LinkedActionsProps) {
  const requestOpenSession = useDashboardStore((s) => s.requestOpenSession);
  const pushToast = useDashboardStore((s) => s.pushToast);
  const [stopping, setStopping] = useState(false);
  const action = decideSessionAction(entry);
  const run = entry?.reviewRun;
  const inFlight = run?.state === "requested" && !run.unverified;

  const stop = async () => {
    if (!run) return;
    setStopping(true);
    try {
      await api.stopReview(run.runId);
    } catch (err) {
      pushToast({
        message: `Couldn't stop the review: ${err instanceof Error ? err.message : String(err)}`,
        kind: "error",
      });
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="sb-linked-actions">
      {action.kind === "open-existing" ? (
        <Button size="sm" onClick={() => requestOpenSession(action.sessionId)}>
          Open existing session
        </Button>
      ) : (
        onStartSession && (
          <Button size="sm" onClick={onStartSession}>
            Open session
          </Button>
        )
      )}
      {onPreview && (
        <Button size="sm" variant="ghost" onClick={onPreview}>
          {entry?.preview ? "Open preview" : "Preview"}
        </Button>
      )}
      {inFlight && (
        <Button size="sm" variant="danger" onClick={stop} disabled={stopping}>
          Stop review
        </Button>
      )}
    </div>
  );
}
