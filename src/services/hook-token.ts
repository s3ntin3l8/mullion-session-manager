import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// A well-formed hook token is exactly what crypto.randomBytes(24).toString("hex")
// produces — 48 lowercase hex characters. Anything else in the token file
// (truncated write, corruption, a stray newline) is treated as absent
// rather than adopted, so a bad file can never downgrade this session's
// token to something weaker or malformed.
const HOOK_TOKEN_RE = /^[0-9a-f]{48}$/;

export function hookTokenPath(sessionsDir: string, id: string): string {
  return path.join(sessionsDir, `${id}.token`);
}

// Issue: worktree/branch detection — a session's hookToken used to be
// minted fresh on every `Session` construction and never persisted, which
// is fine for a brand-new session but wrong for the getOrCreate() reattach
// path: a dtach master survives a Mullion process restart (that's the
// whole point of dtach + systemd --user scopes), but the *env* baked into
// it at spawn time does not change. A freshly restarted server minting a
// new in-memory token for the same session id left the still-running
// agent holding a token the new process would never accept again —
// silently killing every hook (branch, file-change, attention/status,
// promote) for that session's remaining lifetime. See this session's own
// plan doc for the live evidence (142 "unknown or invalid token" warnings
// after one restart).
//
// The fix: persist the token next to this session's other per-spawn files
// (`<id>.sock`, `<id>.hooks.json`, `<id>.mcp.json` — all already written
// under `sessionsDir` at 0o600) and always adopt whatever is on disk,
// unconditionally — including on a genuine respawn (stale socket, dead
// dtach master). Reusing an old token there is harmless: nothing else
// still holds it, and the alternative (trying to detect "was that token
// ever live") is a liveness check that can itself be wrong, for no
// benefit. Never throws: any read/write failure falls back to today's
// in-memory-only token, the same fail-safe posture as the rest of the
// hook path.
export function loadOrCreateHookToken(sessionsDir: string, id: string): string {
  const tokenPath = hookTokenPath(sessionsDir, id);
  let fileExists = true;
  try {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (HOOK_TOKEN_RE.test(existing)) return existing;
    // The file is there but malformed (truncated write, corruption) — fall
    // through to minting and OVERWRITE it below; a plain (non-exclusive)
    // write is correct here since we've already established there's
    // nothing valid on disk worth racing to preserve.
  } catch {
    // ENOENT (first spawn) or a read error — fall through to minting.
    fileExists = false;
  }
  const token = crypto.randomBytes(24).toString("hex");
  try {
    // Exclusive create only when nothing was there at all, so two
    // concurrent first-spawns for the same id can't silently clobber each
    // other's token; a known-malformed file is overwritten outright.
    writeFileSync(tokenPath, token, { mode: 0o600, flag: fileExists ? "w" : "wx" });
  } catch {
    // The exclusive create lost a race — another concurrent spawn for this
    // same id won and created the file first. Its token is just as valid
    // as the one just minted, so prefer reading it over silently diverging
    // from what's now on disk.
    try {
      const raced = readFileSync(tokenPath, "utf8").trim();
      if (HOOK_TOKEN_RE.test(raced)) return raced;
    } catch {
      // Fall through to the in-memory-only token below.
    }
  }
  return token;
}
