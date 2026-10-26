import { useState } from "react";
import { api, ApiError, type Session } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";
import { ErrorText } from "../ui/ErrorText.js";
import { Button, ReviewGateChip } from "../ui/sidebar/index.js";

/**
 * The PR detail's Mullion card, #2019: one line per linked session held at
 * the review gate, with Approve and Deny. It resolves the session's oldest
 * waiting gate (no gateId), the same call the notification bell makes. A 409
 * means nothing is pending any more (answered elsewhere, or lapsed): that is
 * not an error, just a stale view, so it only refreshes the sessions.
 */
export function ReviewGateActions({ sessions }: { sessions: readonly Session[] }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (sessions.length === 0) return null;

  const resolve = async (sessionId: number, decision: "approved" | "denied") => {
    setBusy(sessionId);
    setError(null);
    try {
      await api.resolveReviewGate(sessionId, undefined, decision);
    } catch (err) {
      if (!(err instanceof ApiError && err.statusCode === 409)) {
        setError(err instanceof Error ? err.message : "Could not resolve the review gate");
      }
    } finally {
      setBusy(null);
    }
    // The chip disappears once the session leaves awaiting_review_gate;
    // don't wait for the next poll to show it.
    void useDashboardStore.getState().refreshSessions();
  };

  return (
    <>
      {sessions.map((s) => {
        const name = s.name ?? `Session ${s.id}`;
        return (
          <div key={s.id} className="pr-pin-foot">
            <ReviewGateChip sessions={[s]} />
            <Button
              size="sm"
              disabled={busy !== null}
              title={`Approve ${name}'s review gate`}
              onClick={() => void resolve(s.id, "approved")}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy !== null}
              title={`Deny ${name}'s review gate`}
              onClick={() => void resolve(s.id, "denied")}
            >
              Deny
            </Button>
          </div>
        );
      })}
      {error && <ErrorText>{error}</ErrorText>}
    </>
  );
}
