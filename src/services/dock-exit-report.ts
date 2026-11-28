// Issue #3588 — what a dock session left behind when it exited on its own.
//
// A dock session's output lives in its host's in-memory scrollback, and its
// exit code in the host's live session state; both go when the reconciler
// terminates the scope, and a branch preview's worktree is removed with it.
// So, once the reconciler owns the session's terminal transition, it copies
// the last lines of output and the exit code onto the row (`last_output`,
// `last_exit_code`). The preview proxy's "dev server exited" page and the
// Dock read them from there. Kept as a session-log copy rather than by keeping
// the worktree: a branch preview's next start recuts the worktree anyway.

import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { sessions } from "../db/schema.js";
import { resolveBackend } from "./session-backend.js";
import { stripTerminalEscapes } from "./terminal-text.js";

/** A dev server's dock session: one launched from a dock control, or a branch
 * preview's (in a `dock-preview-*` worktree). Docker logs/stack sessions are
 * `kind: "dock"` too and end routinely; their output is not kept. */
export function isDevServerSession(row: {
  kind: string | null;
  dockControlId: string | null;
  cwd: string | null;
}): boolean {
  if (row.kind !== "dock") return false;
  if (row.dockControlId !== null) return true;
  const base = row.cwd?.split(/[\\/]/).pop() ?? "";
  return base.startsWith("dock-preview-");
}

/** At most this many trailing lines are kept… */
export const LAST_OUTPUT_MAX_LINES = 60;
/** …and at most this many characters of them. */
export const LAST_OUTPUT_MAX_CHARS = 8000;

/** The last non-blank lines of `text`, escapes stripped, within both caps. */
export function lastOutputTail(text: string): string {
  const lines = stripTerminalEscapes(text)
    .split(/\r?\n/)
    .map((l) => l.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const tail = lines.slice(-LAST_OUTPUT_MAX_LINES).join("\n");
  return tail.length > LAST_OUTPUT_MAX_CHARS ? tail.slice(-LAST_OUTPUT_MAX_CHARS) : tail;
}

/** Best effort, never throws: copies the session's last output and exit code
 * from its host onto its row. Call before the scope is terminated. */
export async function captureDockExitReport(
  app: FastifyInstance,
  sessionId: number,
  hostId: string,
): Promise<void> {
  const id = String(sessionId);
  let backend;
  try {
    backend = resolveBackend(app, hostId);
  } catch {
    return;
  }
  let text = "";
  try {
    text = await backend.getRenderedScrollback(id);
  } catch {
    // The host no longer answers for it: keep what else we can.
  }
  let exitCode: number | null = null;
  try {
    exitCode = (await backend.liveStatus([id], 0))[id]?.exitCode ?? null;
  } catch {
    // As above.
  }
  const output = lastOutputTail(text);
  if (output === "" && exitCode === null) return;
  try {
    app.db
      .update(sessions)
      .set({ lastOutput: output === "" ? null : output, lastExitCode: exitCode })
      .where(eq(sessions.id, sessionId))
      .run();
  } catch (err) {
    app.log.warn({ err, sessionId }, "dock exit report: could not record the last output");
  }
}
