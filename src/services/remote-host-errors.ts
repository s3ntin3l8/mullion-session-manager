import { findSsrfBlock, type SsrfBlockedError } from "./pinned-connect.js";

// The error taxonomy of src/services/remote-host-client.ts, in its own module
// so the outbound-channel transport (agent-channel-tunnel.ts) can throw the
// same errors without importing the client. remote-host-client.ts re-exports
// them, so existing imports are unchanged.

/** Read-only POSTs; every other non-GET request is treated as a mutation. */
const IDEMPOTENT_POST_PATHS =
  /^\/internal\/(sessions\/(live|liveness)|project-files\/(list|read|stat|search)|scaffold-scan)(\?|$)/;

export function isIdempotentRequest(method: string, path: string): boolean {
  return (
    method === "GET" || method === "HEAD" || (method === "POST" && IDEMPOTENT_POST_PATHS.test(path))
  );
}

export class HostUnreachableError extends Error {
  /** Set when this "unreachable" was actually the SSRF guard refusing to
   * connect (issue #250), not a network failure. Without it the two are
   * indistinguishable to every caller — a blocked host would just go red in
   * the hosts panel with nothing to explain why. */
  readonly ssrfBlocked: SsrfBlockedError | null;

  constructor(hostId: string, cause: unknown) {
    // fetch() reports a lookup failure as `TypeError: fetch failed` with the
    // real error on `.cause`, so the useful message is two levels down —
    // hoist it into this message rather than making every log site dig.
    const blocked = findSsrfBlock(cause);
    const detail = blocked
      ? blocked.message
      : cause instanceof Error
        ? cause.message
        : String(cause);
    super(`Host ${hostId} is unreachable: ${detail}`);
    this.name = "HostUnreachableError";
    this.cause = cause;
    this.ssrfBlocked = blocked;
  }
}

/** Issue #2451 — a request over the outbound channel was (or may have been)
 * delivered, and the connection was lost before the response completed, so
 * whether a non-idempotent operation ran is UNKNOWN. A HostUnreachableError so
 * existing "host is down" handling still applies, but never retried by this
 * client or silently repeated on another transport: the caller must check the
 * result (list sessions, git status, ...) before deciding to run it again. */
export class HostOutcomeUnknownError extends HostUnreachableError {
  readonly outcomeUnknown = true as const;

  constructor(hostId: string, cause: unknown) {
    super(hostId, cause);
    this.name = "HostOutcomeUnknownError";
    this.message = `Host ${hostId} lost the outbound connection mid-request; the outcome is unknown and the request was not repeated: ${
      cause instanceof Error ? cause.message : String(cause)
    }`;
  }
}

/**
 * Returns true if the error indicates a mid-request channel disconnect where
 * the operation may or may not have executed on the host. Callers must not retry
 * mutating requests when this returns true without first checking host state.
 */
export function isOutcomeUnknown(err: unknown): err is HostOutcomeUnknownError {
  return (
    err instanceof HostOutcomeUnknownError ||
    (Boolean(err) &&
      typeof err === "object" &&
      "outcomeUnknown" in (err as Record<string, unknown>) &&
      Boolean((err as Record<string, unknown>).outcomeUnknown))
  );
}

/** The agent responded — it IS reachable — but rejected the request (4xx):
 * a real client-side error (a malformed body, an unknown session id), not
 * a connectivity problem. Distinct from HostUnreachableError so a caller
 * that cares can tell "the agent said no" apart from "couldn't reach it"
 * (e.g. never treat a 4xx as grounds to skip reconciling a host — the host
 * is fine). Existing callers that just want "did this succeed" keep
 * working unchanged since this is still a thrown Error either way. */
export class HostRequestError extends Error {
  constructor(
    hostId: string,
    public readonly statusCode: number,
    // Issue #431, Hermes review on PR #458 — retained (not just folded into
    // the message string) so a caller that wants to forward the agent's
    // actual rejection reason (e.g. a JSON {message} body) to its own
    // response doesn't have to re-parse it back out of `.message`.
    public readonly body: string,
  ) {
    super(`Host ${hostId} rejected the request: HTTP ${statusCode}${body ? ` — ${body}` : ""}`);
    this.name = "HostRequestError";
  }
}

/**
 * Thrown when the outbound channel has no free request slot (the mux cap was
 * reached and none opened within the wait budget, or the peer refused the open
 * for being at its own cap). Distinct from HostUnreachableError so a caller can
 * tell "saturated right now" from "down", but every caller that retries or skips
 * on unreachable must do the same for busy: use `isHostTransientError`.
 */
export class HostBusyError extends Error {
  constructor(hostId: string, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause ?? "");
    super(`Host ${hostId} is busy: ${detail || "outbound channel concurrency cap reached"}`);
    this.name = "HostBusyError";
    this.cause = cause;
  }
}

/** True for a host that is saturated right now. An `instanceof` check on
 * purpose: duck-typing on a property would match unrelated errors. */
export function isHostBusyError(err: unknown): err is HostBusyError {
  return err instanceof HostBusyError;
}

/**
 * True for a condition that heals by waiting: the host cannot be reached
 * (HostUnreachableError, including an unknown outcome) or is busy. The one
 * predicate for the sites that retry next tick, skip the host, or log at a
 * lower level; do not test `instanceof HostUnreachableError` there.
 */
export function isHostTransientError(err: unknown): err is HostUnreachableError | HostBusyError {
  return err instanceof HostUnreachableError || err instanceof HostBusyError;
}
