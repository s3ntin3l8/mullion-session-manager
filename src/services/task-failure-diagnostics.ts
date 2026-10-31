import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { sessionEvents, type tasks } from "../db/schema.js";
import type { SessionBackend } from "./session-backend.js";
import { redactSecrets } from "./scaffold-generate.js";

/**
 * Diagnostic snapshot for a task failed by the "agent ended its turn with no
 * commits" gate (`failReviewingGate`, task-reconciler.ts). By the time a human
 * looks, the worktree is removed and the session killed, so what the worker
 * was doing is otherwise unrecoverable. Every piece is collected best-effort:
 * a failure is logged and noted as unavailable, never thrown.
 */

/** Hard cap on what is stored on the task row. */
export const FAILURE_DIAGNOSTICS_MAX_CHARS = 4000;
/** Cap on the trimmed copy appended to the GitHub issue comment. */
export const FAILURE_DIAGNOSTICS_COMMENT_MAX_CHARS = 1500;
const SCROLLBACK_TAIL_LINES = 40;
/** Only this many trailing bytes of the scrollback are decoded. */
const SCROLLBACK_TAIL_BYTES = 16 * 1024;
const GIT_STATUS_MAX_FILES = 30;
const EVENT_LIMIT = 5;
const EVENT_PAYLOAD_MAX_CHARS = 80;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Tokens the scaffold patterns do not cover (GitHub PATs and app tokens). */
const EXTRA_SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9]{20,}/g,
];

export function sanitizeDiagnosticText(text: string): string {
  let out = redactSecrets(text.replace(ANSI_RE, "").replace(/\r/g, "\n").replace(CONTROL_RE, ""));
  for (const re of EXTRA_SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

/** Caps `text` at `max` chars, keeping the head and marking the cut. */
export function capDiagnostics(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export interface DiagnosticGitStatus {
  files: { path: string; status: string }[];
}

export interface DiagnosticParts {
  scrollback: string | null;
  events: string[] | null;
  gitStatus: DiagnosticGitStatus | null;
  /** What the salvage commit did; null if it was not attempted. */
  salvage: string | null;
}

export async function collectScrollbackTail(
  app: FastifyInstance,
  backend: SessionBackend,
  sessionId: number,
): Promise<string | null> {
  try {
    const buf = await backend.getScrollback(String(sessionId));
    const tail = buf.subarray(Math.max(0, buf.length - SCROLLBACK_TAIL_BYTES)).toString("utf8");
    const lines = sanitizeDiagnosticText(tail)
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
    return lines.slice(-SCROLLBACK_TAIL_LINES).join("\n");
  } catch (err) {
    app.log.warn({ err, sessionId }, "task diagnostics: scrollback unavailable");
    return null;
  }
}

export function collectRecentEvents(app: FastifyInstance, sessionId: number): string[] | null {
  try {
    const rows = app.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId))
      .orderBy(desc(sessionEvents.id))
      .limit(EVENT_LIMIT)
      .all();
    return rows.reverse().map((r) => {
      const payload = r.payload
        ? ` ${capDiagnostics(sanitizeDiagnosticText(r.payload), EVENT_PAYLOAD_MAX_CHARS)}`
        : "";
      return `${new Date(r.ts).toISOString()} ${r.kind}${payload}`;
    });
  } catch (err) {
    app.log.warn({ err, sessionId }, "task diagnostics: session events unavailable");
    return null;
  }
}

function formatRuntime(ms: number): string {
  const mins = Math.round(ms / 60_000);
  return mins < 1 ? "<1 min" : `${mins} min`;
}

/** Renders the stored snapshot. Pieces that could not be collected are named. */
export function formatFailureDiagnostics(
  task: typeof tasks.$inferSelect,
  parts: DiagnosticParts,
  endedAt: Date,
): string {
  const lines: string[] = [];
  const agent = task.agentCommand ?? task.agent ?? "unknown";
  lines.push(`Agent: ${agent}`);
  lines.push(`Model: ${task.model ?? "default"}`);
  if (task.claimedAt) {
    lines.push(`Runtime: ${formatRuntime(endedAt.getTime() - task.claimedAt.getTime())}`);
  } else {
    lines.push("Runtime: unavailable (task has no claim time)");
  }

  if (parts.gitStatus === null) {
    lines.push("Git status: unavailable (worktree or host not reachable)");
  } else if (parts.gitStatus.files.length === 0) {
    lines.push("Git status: clean (no files edited)");
  } else {
    lines.push("Git status:");
    for (const f of parts.gitStatus.files.slice(0, GIT_STATUS_MAX_FILES)) {
      lines.push(`  ${f.status} ${f.path}`);
    }
    const extra = parts.gitStatus.files.length - GIT_STATUS_MAX_FILES;
    if (extra > 0) lines.push(`  … and ${extra} more`);
  }
  lines.push(`Salvage commit: ${parts.salvage ?? "not attempted"}`);

  if (parts.events === null) lines.push("Session events: unavailable");
  else if (parts.events.length === 0) lines.push("Session events: none recorded");
  else lines.push("Session events:", ...parts.events.map((e) => `  ${e}`));

  if (parts.scrollback === null) lines.push("Terminal tail: unavailable (session already gone)");
  else if (parts.scrollback === "") lines.push("Terminal tail: empty");
  else lines.push(`Terminal tail (last ${SCROLLBACK_TAIL_LINES} lines):`, parts.scrollback);

  return capDiagnostics(sanitizeDiagnosticText(lines.join("\n")), FAILURE_DIAGNOSTICS_MAX_CHARS);
}

/**
 * The trimmed copy appended to the issue comment: the head (agent, runtime,
 * git status) is kept in full, then the cap cuts into the terminal tail.
 * Backtick runs are broken so the snapshot cannot close its own code fence.
 */
export function trimDiagnosticsForComment(diagnostics: string): string {
  const safe = capDiagnostics(
    sanitizeDiagnosticText(diagnostics),
    FAILURE_DIAGNOSTICS_COMMENT_MAX_CHARS,
  ).replace(/`/g, "'");
  return `\n\n<details><summary>Failure diagnostics</summary>\n\n\`\`\`\n${safe}\n\`\`\`\n</details>`;
}
