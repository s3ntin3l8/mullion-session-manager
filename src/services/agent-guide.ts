import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Issue #405 — the agent-facing skill/guide doc (docs/agent-guide.md) is
// written once, checked into the repo, and copied verbatim into a per-session
// file an in-session agent can read off disk
// (`<sessionsDir>/<sessionId>.agent-guide.md`). This module owns that copy so
// the guide's prose lives in exactly one place — never hand-duplicated into
// a second TS string constant that would drift the moment one of them is
// edited.
//
// Resolution is cwd-relative, the same posture env.ts's own
// FRONTEND_DIST=./frontend/dist default and drizzle/'s path.resolve("drizzle")
// already use: process.cwd() is the repo root under `make dev`/`tsx watch
// src/server.ts` (and under `vitest run`, invoked from the repo root too),
// and the release-install directory in production — systemd's
// WorkingDirectory is pinned to the versioned release's `current` symlink
// target (see deploy/mullion.service, deploy/install.sh). Two candidates are
// tried, in order:
//
//   1. `docs/agent-guide.md` — the checked-in doc itself, present in a dev
//      checkout (and under `.wt/`/`.mullion-worktrees/` worktrees, which are
//      full git checkouts). Not part of the release tarball.
//   2. `dist/docs/agent-guide.md` — a build-time copy (package.json's
//      `build` script, mirroring how it already copies src/hooks,
//      src/mcp, src/cli into dist/ verbatim), included in the release
//      tarball via build-tarball's existing `cp -r dist "$staging/dist"`
//      (release-please.yml) with zero CI-workflow changes needed.
//
// Never thrown: a checkout or install missing both (a stripped-down test
// fixture, or a pre-#405 release tarball rebuilt without a fresh `npm run
// build`) is a soft failure — see writeSessionAgentGuide's own doc comment.
function resolveAgentGuideSourcePath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "docs", "agent-guide.md"),
    path.resolve(process.cwd(), "dist", "docs", "agent-guide.md"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Whether the shipped source doc is available on this install at all —
 * exported for hooks.ts's SessionStart pointer to gate on. Deliberately
 * checked against the SOURCE doc, not the per-session copy
 * `writeSessionAgentGuide` produces: the per-session copy is written
 * synchronously during `Session.bootstrapMaster()`, well before the
 * session's own program is ever spawned, so in real operation it's always
 * already there by the time a real SessionStart hook could fire — but nothing
 * enforces that ordering for a caller (e.g. a test) that fires a synthetic
 * `session_start` hook message immediately after creating a session, without
 * waiting on that spawn to actually finish. Checking the source instead
 * makes the pointer's presence a static, install-wide fact with no such
 * race, at the (rare) cost of pointing at a per-session copy that failed to
 * write for some *other* reason (e.g. a full disk) even though the source
 * itself resolved fine.
 */
export function agentGuideSourceExists(): boolean {
  return resolveAgentGuideSourcePath() !== null;
}

/**
 * Pure path builder (no I/O) for a session's own copy of the guide, shared
 * by pty-manager.ts (which writes it, unconditionally, at spawn time) and
 * hooks.ts (which points at it from the SessionStart pointer) so the
 * `<id>.agent-guide.md` naming convention lives in exactly one place.
 */
export function sessionAgentGuidePath(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, `${sessionId}.agent-guide.md`);
}

/**
 * Writes a per-session copy of the shipped agent guide doc — prefixed with a
 * short self-identifying header (buildSessionAgentGuideContent) — to
 * `sessionAgentGuidePath(sessionsDir, sessionId)` (issue #405). Called
 * unconditionally from Session.bootstrapMaster() — the same spawn-time seam
 * that writes Claude Code's ephemeral `<sessionId>.hooks.json`/`.mcp.json`
 * (hook-adapters/index.ts's applyHookAdapters) — but NOT gated on which (if
 * any) hook adapter matched the launch command: every agent (Codex,
 * OpenCode, agy, even a plain shell) benefits from having this on disk to
 * read, even one with no hook integration wired up at all.
 *
 * The `sessions.injectAgentGuide` setting (src/services/settings.ts) does
 * NOT gate this write — only the SessionStart auto-inject *pointer* to this
 * file (src/plugins/hooks.ts) is gated by it. A per-session markdown copy is
 * a cheap, harmless static file write regardless of whether the pointer is
 * ever composed; disabling the setting only stops the proactive nudge, not
 * the file's availability.
 *
 * Defensive like every other spawn-time side effect in this file
 * (applyHookAdapters' own settings-file writes): a missing/unreadable
 * source doc, or a write failure, is logged and swallowed rather than
 * thrown — this must never prevent a session from spawning.
 */
export function writeSessionAgentGuide(
  sessionsDir: string,
  sessionId: string,
  log: { error: (obj: unknown, msg: string) => void } = console,
): void {
  const sourcePath = resolveAgentGuideSourcePath();
  if (!sourcePath) {
    // Not logged as an error — this is the expected, harmless case for any
    // checkout/install that hasn't shipped docs/agent-guide.md yet (e.g. a
    // stripped-down test fixture, or a pre-#405 release). hooks.ts's own
    // session_start branch gates its pointer on agentGuideSourceExists()
    // (the SOURCE doc, checked separately, at hook-fire time) — not an
    // existsSync() on the per-session copy this function would have
    // written, which is what actually keeps that pointer from ever naming
    // a file that isn't there. Issue #437c's opencode adapter is the one
    // consumer that DOES check existsSync() on the per-session copy
    // directly (hook-adapters/opencode.ts's prepareLaunch) — a stricter
    // check than this comment previously (incorrectly) attributed to
    // hooks.ts, because opencode's `instructions` config is a reference
    // its own CLI resolves at startup, not prose an LLM reads and ignores.
    return;
  }
  let shipped: string;
  try {
    shipped = readFileSync(sourcePath, "utf8");
  } catch (err) {
    log.error({ err, sourcePath }, "failed to read shipped docs/agent-guide.md");
    return;
  }
  const destPath = sessionAgentGuidePath(sessionsDir, sessionId);
  const content = buildSessionAgentGuideContent(shipped, destPath);
  try {
    // recursive: true, same defensive posture as hook-adapters/index.ts's
    // own settingsFiles writer — a no-op in the ordinary case (sessionsDir
    // already exists, it's where the hook socket itself lives).
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(destPath, content, { mode: 0o600 });
  } catch (err) {
    log.error({ err, sessionId }, "failed to write per-session agent guide copy");
  }
}

/**
 * Prepends a short, self-identifying header to the shipped guide before it's
 * written to a session's own copy. Claude Code/Codex/agy get an explicit
 * SessionStart pointer sentence naming this file's path (hooks.ts); opencode
 * instead gets the guide's full body loaded as an unlabeled `instructions`
 * blob (hook-adapters/opencode.ts) — nothing in that blob previously said
 * "this is the Mullion agent guide" or named its own on-disk path, so an
 * opencode session asked to "read agent-guide.md" had the content but
 * nothing connecting it to that name (a real production incident, not a
 * hypothetical). Exported (not inlined) so the test suite can assert the
 * header shape independently of file I/O.
 */
export function buildSessionAgentGuideContent(shippedContent: string, destPath: string): string {
  return `> This is the Mullion agent guide — this session's own copy, on disk at \`${destPath}\`.\n\n${shippedContent}`;
}
