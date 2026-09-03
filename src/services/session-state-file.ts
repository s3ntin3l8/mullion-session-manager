// Extracted from pty-manager.ts (state-file persistence only, issue #323 —
// see that file's own header comment on why it's flagged as this repo's
// highest-risk file, and docs/architecture.md's "non-obvious session
// model" note before touching it or the terminal WS protocol).
//
// This module owns the generic, Session-state-agnostic mechanics of a
// per-session `<sessionsDir>/<id>.state.json` file: its path, its on-disk
// schema envelope, debounced + ceiling-timed write scheduling, and atomic
// (tmp file + rename) writes. It deliberately does NOT own WHAT state
// means — permissionState, planState, subagents, backgroundTasks, etc. are
// all still Session's own fields, applied/collected by Session itself.
// Session hands this class a `buildPayload` callback (assembled from its
// own `collectState()`) rather than this class reaching into Session's
// ~20-field shape, and a pair of side-effect callbacks for the two failure
// paths (corrupt file on read, write failure on flush) so Session can keep
// logging with its own session id without this generic module needing to
// know it. Session.spawn()'s "restore across a respawn" logic (which also
// calls collectState(), for an unrelated reason — see that method's own
// comment in pty-manager.ts) stays there entirely; it's Session-state
// reset/reapply, not file I/O, and has nothing to do with this class.
//
// Mirrors ScrollbackBuffer's shape (scrollback-buffer.ts): one instance per
// Session, mutated only from that Session's own single-threaded call
// sites — no concurrent access to guard against.

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";

// Issue #323: maximum-write ceiling. Named (unlike the 5s trailing debounce
// below, which is a plain inline literal) because it's also referenced from
// pty-manager.ts's title-change-event coalescing comment, which mirrors this
// shape for an unrelated debounce.
const MAX_WRITE_DELAY_MS = 30_000;

export function stateFilePath(sessionsDir: string, id: string): string {
  return path.join(sessionsDir, `${id}.state.json`);
}

export interface StoredSessionState<TState> {
  v: 1;
  launchedAtVersion: string;
  state: TState;
}

/**
 * Debounced, atomic persistence for a single session's
 * `<sessionsDir>/<id>.state.json` file. Generic over `TState` (Session's own
 * `StoredStateFields`) so this class stays ignorant of Session's field
 * shape — see this file's header comment for why.
 */
export class SessionStateFile<TState> {
  // Issue #323: debounced state-file write bookkeeping.
  private dirty = false;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  // Issue #323: maximum-write ceiling — tracks when the state file first
  // became dirty so the ceiling timer can force a flush after at most
  // MAX_WRITE_DELAY_MS, even if events continuously reset the 5s
  // trailing-edge debounce.
  private firstDirtyAt: number | null = null;
  private ceilingTimeout: ReturnType<typeof setTimeout> | null = null;
  // A8: set at the very top of Session.kill(), before anything that could
  // dirty state again. See schedule()'s own comment below and kill()'s own
  // comment in pty-manager.ts — this is what stops the state file from
  // being resurrected after terminate() deletes it.
  private writesDisabled = false;

  constructor(
    private readonly filePath: string,
    private readonly buildPayload: () => StoredSessionState<TState>,
    private readonly onCorrupt?: () => void,
    private readonly onWriteError?: (err: unknown) => void,
  ) {}

  /** Read and parse the persisted file. Returns null for a missing file
   * (ENOENT — no prior state), corrupt JSON (onCorrupt fires first, so the
   * caller can log with its own session id before defaults are used), or a
   * schema-version mismatch — callers treat all three identically: keep
   * defaults. */
  read(): StoredSessionState<TState> | null {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      // ENOENT — no prior state, this is a fresh session or the file was
      // cleaned up on terminate. Leave all defaults in place.
      return null;
    }
    let parsed: StoredSessionState<TState>;
    try {
      parsed = JSON.parse(raw) as StoredSessionState<TState>;
    } catch {
      this.onCorrupt?.();
      return null;
    }
    // Defensive: only accept the current schema version.
    if (parsed.v !== 1 || typeof parsed.state !== "object" || parsed.state === null) return null;
    return parsed;
  }

  /** Mark the state file as dirty and schedule a write in 5s. The timer is
   * reset on every call, so rapid state changes (burst of emitEvent calls)
   * produce at most one write. */
  schedule(): void {
    // A8: once Session.kill() has run, this instance is permanently done
    // with the state file — see kill()'s own comment in pty-manager.ts for
    // the full race this guards against. Without this, ptyProcess.kill() a
    // few lines into kill() triggers node-pty's onExit ->
    // emitEvent("status_change") -> this very method, re-arming a fresh 5s
    // timer *after* kill()'s own flush already ran. That timer would then
    // fire after terminate()'s unlinkSync(stateFilePath(...)) in
    // pty-manager.ts, resurrecting a file for a session that no longer
    // exists. kill() is only ever reached via PtyManager.kill(id), which
    // always removes the owning Session from the `sessions` map in the same
    // call — so a subsequent reattach always constructs a brand-new Session
    // (see getOrCreate), with a brand-new SessionStateFile whose
    // `writesDisabled` starts false again, meaning permanently disabling
    // writes here can never suppress a legitimate future write for this
    // session id, only for this now-abandoned instance.
    if (this.writesDisabled) return;
    const wasAlreadyDirty = this.dirty;
    this.dirty = true;
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.timeout = setTimeout(() => {
      this.flush();
    }, 5_000);
    this.timeout.unref();

    // Set the ceiling timer only on the first dirty transition, so the
    // state file is forced to disk at most MAX_WRITE_DELAY_MS after the
    // first change, even if events never stop arriving.
    if (!wasAlreadyDirty) {
      this.firstDirtyAt = Date.now();
      if (this.ceilingTimeout !== null) clearTimeout(this.ceilingTimeout);
      this.ceilingTimeout = setTimeout(() => {
        this.flush();
      }, MAX_WRITE_DELAY_MS);
      this.ceilingTimeout.unref();
    }
  }

  /** If dirty, atomically write current state to disk (write to temp file,
   * rename) and clear the dirty flag. Safe to call directly for tests —
   * and for Session.kill()'s own synchronous A8 flush, which deliberately
   * does NOT wait for either timer above. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.firstDirtyAt = null;
    if (this.timeout !== null) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    if (this.ceilingTimeout !== null) {
      clearTimeout(this.ceilingTimeout);
      this.ceilingTimeout = null;
    }
    const tmpPath = this.filePath + ".tmp";
    try {
      writeFileSync(tmpPath, JSON.stringify(this.buildPayload()), { mode: 0o600 });
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      this.onWriteError?.(err);
    }
  }

  /** Permanently stop scheduling/flushing writes for this instance — see
   * schedule()'s own A8 comment above for the exact race this exists to
   * prevent (kill()'s own comment in pty-manager.ts has the full picture,
   * including why kill() calls this BEFORE its own synchronous flush()). */
  disable(): void {
    this.writesDisabled = true;
  }
}
