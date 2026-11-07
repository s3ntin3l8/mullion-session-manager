// Every RemoteBackend method is mutating or read-only. The lists live here so
// the test that checks the classification is complete (every method named
// exactly once) and the test that checks READ_ONLY really is read-only (each
// method's wire requests are idempotent) read the same names.

/** Mutating, and answers an unknown outcome as a VALUE: a refusal carrying the
 * "MAY HAVE BEEN DELIVERED" error (see session-backend-remote-control.test.ts). */
export const MUTATING_AS_VALUE = ["prompt"];

export const READ_ONLY = [
  "liveStatus",
  "liveness",
  "compareWorktreePaths",
  "getScrollback",
  "getRenderedScrollback",
  "getTranscript",
  "listSessionProcesses",
  "waitOutput",
  "listTaskWorktreeDirs",
  "readTaskReviewFindings",
  "resolveSessionsDir",
  "readTaskCommitTitle",
  "readTaskRereviewRequest",
];
