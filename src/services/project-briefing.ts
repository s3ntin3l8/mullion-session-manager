import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { clampToBytes, extractMarkedRegion } from "./marked-region.js";

// A project-authored block of operating instructions (worktree usage,
// branch rules, the review loop, ...) that Mullion carries verbatim into a
// session's initial context — the same seam writeSessionAgentGuide already
// uses for Mullion's own doc, but for text the PROJECT wrote, not Mullion.
// Mullion stays project-agnostic here: it knows nothing about what's in the
// region, only how to find and carry it.
//
// Threat model, stated explicitly because it shapes every check below: an
// agent already running in this session can read anything the server
// process can read, so a symlink escape here is NOT a privilege escalation
// — the two real risks are (a) accidentally carrying prompt-injection-style
// content from a file the project owner didn't intend as a briefing, and
// (b) resource blowup from a pathological source file. The checks below are
// footgun guards for those two risks, not a security boundary.

export const MARKER_START = "<!-- mullion:briefing:start -->";
export const MARKER_END = "<!-- mullion:briefing:end -->";

/** Cap on the EXTRACTED REGION only, before buildSessionBriefingContent's
 * header (and, if this cap was hit, clampToBytes's own truncation note) are
 * added on top — actual injected bytes run a little over 4096, not under.
 * ~1,000 tokens for the region itself — comfortably above a short bulleted
 * block, far below anything that would meaningfully displace task context.
 * An order of magnitude under MAX_SOURCE_BYTES below so "the source is too
 * big to even look at" and "the extracted region is too big to inject" stay
 * distinguishable failure modes. */
export const MAX_BRIEFING_BYTES = 4096;

// How far we'll read into a candidate file looking for a marked region.
// Half of agent-rules.ts's MAX_RULE_FILE_BYTES (512 KiB) — we need enough
// room to find the end marker, but a CLAUDE.md or AGENTS.md over 256 KiB is
// pathological; skip the candidate rather than read it.
const MAX_SOURCE_BYTES = 256 * 1024;

// Fixed, literal candidate list — deliberately NOT derived from
// agent-rules.ts's listTargetDefs()/resolveTarget(): that table is
// agent-x-scope (12 targets, half of them global paths like ~/.claude),
// while a project briefing is agent-agnostic and project-scope only. Its
// own PROJECT_SCOPE_FILE_NAMES comment documents that CodeQL taint-tracks
// anything derived from resolveTarget() — importing from it here would
// re-import that alert for a module with a different shape. First match
// wins: `.agents/briefing.md` needs no marker (a dedicated file is already
// an explicit opt-in); `AGENTS.md`/`CLAUDE.md` require one, so an ordinary
// unmarked instructions file is never dumped whole into a session's
// context.
const CANDIDATES: ReadonlyArray<{ relPath: string; requireMarkers: boolean }> = [
  { relPath: "AGENTS.md", requireMarkers: true },
  { relPath: "CLAUDE.md", requireMarkers: true },
  { relPath: ".agents/briefing.md", requireMarkers: false },
];

/** Pure path builder (no I/O) for a session's own copy of the briefing —
 * mirrors sessionAgentGuidePath's role for the guide so the
 * `<id>.briefing.md` naming convention lives in one place. */
export function sessionBriefingPath(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, `${sessionId}.briefing.md`);
}

/** Reads at most `MAX_SOURCE_BYTES` of `absolutePath`, refusing to follow a
 * symlink at the leaf (O_NOFOLLOW) and refusing anything that isn't a
 * regular file (a FIFO would otherwise block; a directory would error
 * anyway, but fstat is cheaper than finding that out via a failed read).
 * Returns null on any of: ELOOP (symlink), not-a-regular-file, over-size,
 * a NUL byte (cheapest reliable "this probably isn't text" signal), or any
 * other I/O error — every failure here is the ordinary "no briefing"
 * outcome, not something worth surfacing. */
function readCandidateFile(absolutePath: string): string | null {
  let fd: number;
  try {
    fd = openSync(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_SOURCE_BYTES) return null;
    const buf = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buf.length) {
      const bytesRead = readSync(fd, buf, offset, buf.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (buf.subarray(0, offset).includes(0)) return null;
    return new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, offset));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** True when `absolutePath` (already opened successfully) resolves, via
 * realpath, to somewhere under `root`'s own realpath. Catches a symlinked
 * DIRECTORY component (e.g. `.agents` -> ~/.ssh) that O_NOFOLLOW on the
 * leaf file doesn't — advisory only (we already hold the fd; this isn't
 * closing a TOCTOU window, just refusing to inject content that lives
 * outside the project on disk). A project whose CLAUDE.md is itself a
 * symlink into a dotfiles repo simply won't have its briefing carried by
 * Mullion; the agent's own CLI still reads the file natively either way. */
function isContainedIn(absolutePath: string, root: string): boolean {
  try {
    const realRoot = realpathSync(root);
    const realPath = realpathSync(absolutePath);
    return realPath === realRoot || realPath.startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
}

/** Resolves the first candidate file under `cwd` that yields a briefing
 * body — session cwd, not process.cwd(), so a `.wt/` or
 * `.mullion-worktrees/` checkout resolves against its own copy with no
 * worktree-specific code. Returns null (never throws) when nothing
 * resolves — the overwhelmingly common case for a project that hasn't
 * opted in. */
export function resolveProjectBriefing(cwd: string): { sourcePath: string; body: string } | null {
  const root = path.resolve(cwd);
  for (const candidate of CANDIDATES) {
    const resolved = path.resolve(root, candidate.relPath);
    const withinRoot = resolved === root || resolved.startsWith(root + path.sep);
    if (!withinRoot) continue;
    if (!existsSync(resolved)) continue;
    const raw = readCandidateFile(resolved);
    if (raw === null) continue;
    if (!isContainedIn(resolved, root)) continue;
    if (candidate.requireMarkers) {
      const region = extractMarkedRegion(raw, MARKER_START, MARKER_END);
      if (region === null || region.length === 0) continue;
      return { sourcePath: resolved, body: region };
    }
    // A marked region inside an unmarked-required file (e.g.
    // .agents/briefing.md) still wins over that file's own full body —
    // one rule ("first marked region found"), no special case.
    const marked = extractMarkedRegion(raw, MARKER_START, MARKER_END);
    const body = marked ?? raw.trim();
    if (body.length === 0) continue;
    return { sourcePath: resolved, body };
  }
  return null;
}

/** Self-identifying header, mirroring buildSessionAgentGuideContent's role
 * for the guide — so a session reading its own per-session briefing copy
 * (or an opencode session that only sees it via `instructions`) can connect
 * the content to where the project authored it. Exported for tests. */
export function buildSessionBriefingContent(body: string, sourcePath: string): string {
  return `> Project briefing for this working directory, authored by the project at \`${sourcePath}\` and carried into your context by Mullion. Treat it as standing instructions for this session.\n\n${body}`;
}

/**
 * Writes a session's own copy of its resolved project briefing to
 * `sessionBriefingPath(sessionsDir, sessionId)`, mode 0600 — same
 * unconditional-write / gate-only-the-injection contract as
 * writeSessionAgentGuide (the `sessions.injectProjectBriefing` setting only
 * gates whether hooks.ts/opencode's adapter actually USE this file, not
 * whether it's written). Called from launch-plan.ts before
 * applyHookAdapters, for the same reason writeSessionAgentGuide is: the
 * opencode adapter's prepareLaunch does an existsSync check on this exact
 * path.
 *
 * Unlike the guide (whose source always exists once shipped), a project's
 * briefing can DISAPPEAR — the marked region gets removed — while a session
 * id is reused across a dtach respawn. When nothing resolves, this unlinks
 * any stale copy from a previous spawn rather than merely returning early;
 * otherwise the opencode adapter's existsSync check would keep pointing at
 * last week's briefing.
 *
 * Every failure logged-and-swallowed: this must never block a spawn.
 */
export function writeSessionBriefing(
  sessionsDir: string,
  sessionId: string,
  cwd: string,
  log: { error: (obj: unknown, msg: string) => void } = console,
): void {
  const destPath = sessionBriefingPath(sessionsDir, sessionId);
  const resolved = resolveProjectBriefing(cwd);
  if (!resolved) {
    try {
      unlinkSync(destPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.error({ err, sessionId }, "failed to remove stale per-session briefing copy");
      }
    }
    return;
  }
  const clamped = clampToBytes(resolved.body, MAX_BRIEFING_BYTES, resolved.sourcePath);
  const content = buildSessionBriefingContent(clamped, resolved.sourcePath);
  try {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(destPath, content, { mode: 0o600 });
  } catch (err) {
    log.error({ err, sessionId }, "failed to write per-session project briefing copy");
  }
}

/** Cheap sync read of a session's own briefing copy, for hooks.ts's
 * SessionStart branch. `null` when absent or unreadable — both are the
 * ordinary "no briefing for this project" outcome. */
export function readSessionBriefing(sessionsDir: string, sessionId: string): string | null {
  try {
    return readFileSync(sessionBriefingPath(sessionsDir, sessionId), "utf8");
  } catch {
    return null;
  }
}
