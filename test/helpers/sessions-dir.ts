import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

// A per-APP SESSIONS_DIR, for a test file that builds a SECOND app (the
// agent-role one) alongside its primary app.
//
// The reason it exists: `test/setup.ts` gives every test FILE its own
// SESSIONS_DIR, and both apps in a file would otherwise inherit it — so their
// `hooksPlugin` listeners would collide on the same `hooks.sock` path and the
// second build would fail with `SocketAlreadyListeningError`. This helper is
// the per-app one: a fresh directory per app, under the OS temp dir.
//
// `prefix` is the caller-supplied name fragment, so each file keeps the
// directory name it has always used (e.g. "projects" ->
// `projects-agent-sessions-<pid>-<random>`). The prefix is part of the path,
// so two callers in the same process MUST pass different ones.
export function uniqueSessionsDir(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}-agent-sessions-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
}
