import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clampToBytes } from "./marked-region.js";

// A short, operator-authored note (project-tooling.ts's `briefing` column,
// authored from the UI) that Mullion carries verbatim into a session's
// initial context. Issue #942 redesigned this from a full, precedence-based
// alternate/override of a project's committed AGENTS.md briefing region
// into a short, live, ALWAYS-ADDITIVE pinned note: no precedence, no file
// scanning, no fallback. AGENTS.md is read natively by every CLI and is
// never re-injected or competed with here — when this DB value is set, it
// is pushed on top of whatever AGENTS.md already said; when unset, nothing
// extra is pushed. See project-tooling.ts's own doc comment for the
// producer side.

// Kept for the scaffold's write-side upsert boundary only (mullion-
// scaffold.ts's computeScaffold) — there is no read-side consumer of these
// markers anymore; a project's committed AGENTS.md region is read natively
// by each CLI, never extracted or re-injected by Mullion.
export const MARKER_START = "<!-- mullion:briefing:start -->";
export const MARKER_END = "<!-- mullion:briefing:end -->";

/** Cap on the pinned note's body, before buildSessionBriefingContent's
 * header is added on top — actual injected bytes run a little over this.
 * Deliberately small: this is a short, live "pay attention to this" note,
 * not a document — matches (and is enforced again by, defense in depth)
 * project-tooling.ts's own MAX_PROJECT_BRIEFING_FIELD_BYTES save-time
 * cap, so this clamp should never actually have to truncate anything in
 * practice. */
export const MAX_BRIEFING_BYTES = 512;

/** Pure path builder (no I/O) for a session's own copy of the pinned note —
 * mirrors sessionAgentGuidePath's role for the guide so the
 * `<id>.briefing.md` naming convention lives in one place. Name unchanged
 * from before issue #942's redesign — hook-adapters/opencode.ts's
 * prepareLaunch does an existsSync check on this exact path. */
export function sessionBriefingPath(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, `${sessionId}.briefing.md`);
}

/** Self-identifying header for a session's own per-session pinned-note
 * copy, mirroring buildSessionAgentGuideContent's role for the guide — so a
 * session reading this file (or an opencode session that only sees it via
 * `instructions`) knows where the note came from and that it's additive,
 * not a replacement for AGENTS.md. Exported for tests. */
export function buildSessionBriefingContent(body: string): string {
  return `> A pinned note for this project, set in Mullion's per-project settings. Always added on top of whatever \`AGENTS.md\` already told you — it isn't a substitute for it.\n\n${body}`;
}

/**
 * Writes a session's own copy of its pinned note to
 * `sessionBriefingPath(sessionsDir, sessionId)`, mode 0600 — same
 * unconditional-write / gate-only-the-injection contract as
 * writeSessionAgentGuide (the `sessions.injectProjectBriefing` setting only
 * gates whether hooks.ts/opencode's adapter actually USE this file, not
 * whether it's written). Called from launch-plan.ts before
 * applyHookAdapters, for the same reason writeSessionAgentGuide is: the
 * opencode adapter's prepareLaunch does an existsSync check on this exact
 * path.
 *
 * `note` is the project's DB-authored pinned note (project-tooling.ts's
 * `briefing` column, resolved on the primary and threaded through the spawn
 * body — see CreateSessionOptions.briefingOverride's own doc comment,
 * pty-manager.ts). `undefined` means "no note set for this project" and
 * unlinks any stale per-session copy from a previous spawn (a note can be
 * deleted between spawns while a session id is reused across a dtach
 * respawn). An empty string is a real, distinct, reachable state (select-
 * all-delete in the UI, then Save) — NOT the same as `undefined` — and is
 * still written, producing a per-session file with just the header and no
 * body; only `deleteProjectBriefing` (project-tooling.ts), a genuinely
 * different action from saving an empty string, clears the column back to
 * `null`.
 *
 * Every failure logged-and-swallowed: this must never block a spawn.
 */
export function writeSessionBriefing(
  sessionsDir: string,
  sessionId: string,
  log: { error: (obj: unknown, msg: string) => void } = console,
  note?: string,
): void {
  const destPath = sessionBriefingPath(sessionsDir, sessionId);
  if (note === undefined) {
    try {
      unlinkSync(destPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.error({ err, sessionId }, "failed to remove stale per-session briefing copy");
      }
    }
    return;
  }
  const clamped = clampToBytes(note, MAX_BRIEFING_BYTES, "this project's Mullion settings");
  const content = buildSessionBriefingContent(clamped);
  try {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(destPath, content, { mode: 0o600 });
  } catch (err) {
    log.error({ err, sessionId }, "failed to write per-session project briefing copy");
  }
}

/** Cheap sync read of a session's own pinned-note copy, for hooks.ts's
 * SessionStart branch. `null` when absent or unreadable — both are the
 * ordinary "no note for this project" outcome. */
export function readSessionBriefing(sessionsDir: string, sessionId: string): string | null {
  try {
    return readFileSync(sessionBriefingPath(sessionsDir, sessionId), "utf8");
  } catch {
    return null;
  }
}
