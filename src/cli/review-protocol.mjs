// The review protocol's one source of truth for the CLIENT side.
//
// The policy about asking for a review lives here, and both clients (the CLI
// `mullion review` and the MCP `request_review` / `review_status` tools)
// import it, so the two surfaces cannot drift into contradicting each other.
// The server-side half (the relay itself, the guard that refuses a second
// review while one is in flight) is in src/services/hermes-review.ts.
//
// This file is plain ESM on purpose: src/mcp and src/cli are copied into
// dist/ verbatim by the build (see package.json's "build" script), so they
// cannot import a compiled TypeScript module.

/**
 * `reviews.request` resolves the PR, reads the head commit, fetches the
 * prompt, checks Hermes' health and dispatches — several sequential network
 * calls server-side, so it outlasts the control socket's 30s default.
 */
export const REVIEW_REQUEST_TIMEOUT_MS = 60_000;

/**
 * The normative sentence about asking for a review. It is read by an agent
 * at the moment it is about to ask, which is the only moment the rule can
 * still change what it does.
 *
 * The rule exists because the alternative was measured: an agent that asked
 * again because the first request "took too long" got a SECOND review queued
 * behind the first, and every extra round made the next one slower (each
 * round inherits the previous rounds' transcript) until the queue tripped
 * Hermes' concurrent-run cap.
 */
export const REVIEW_PROTOCOL_NOTE =
  "One review per pull request at a time: a review that is already running " +
  "is not re-requested — the request is refused with its run id, and that " +
  "refusal is the answer, not an error to retry: wait for it, or stop it with " +
  "stop_review. A review takes 10-30 minutes; check review_status once " +
  "instead of asking again. After pushing fixes, ask again only when no " +
  "review is in flight. Never re-trigger a review by commenting " +
  "'@s3ntin3l8-hermes Review': that path is for humans and queues another " +
  "round behind the running one.";
