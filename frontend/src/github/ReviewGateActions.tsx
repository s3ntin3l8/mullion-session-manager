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
 * not an error, just a stale view, so it only refreshes the sessions. Deny
 * sends no reason on purpose: this is the one-click path, and the bell's own
 * Deny (NotificationBell.tsx) is where a reason gets typed.
 */
export function ReviewGateActions({ sessions }: { sessions: readonly Session[] }) {
  // Per session, so answering one gate leaves the other rows live.
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  if (sessions.length === 0) return null;

  const resolve = async (sessionId: number, decision: "approved" | "denied") => {
    setBusy((b) => new Set(b).add(sessionId));
    setError(null);
    try {
      await api.resolveReviewGate(sessionId, undefined, decision);
    } catch (err) {
      if (!(err instanceof ApiError && err.statusCode === 409)) {
        setError(err instanceof Error ? err.message : "Could not resolve the review gate");
      }
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(sessionId);
        return next;
      });
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
              disabled={busy.has(s.id)}
              title={`Approve ${name}'s review gate`}
              onClick={() => void resolve(s.id, "approved")}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy.has(s.id)}
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
