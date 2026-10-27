import os from "node:os";
import path from "node:path";

// Issue #470 — Claude Code's own bundle (2.1.220, verified statically by
// locating `Akl()`/`fn()` and their callers in the installed binary) resolves
// its ENTIRE user-scope config tree off `CLAUDE_CONFIG_DIR`, falling back to
// `~/.claude` only when that's unset — the exact same bug class #470 fixed
// for opencode's `resolveOpenCodeConfigHome()`. agent-rules.ts, skills.ts, and
// claude-code-skills.ts all read/write paths under this root; every one of
// them must go through this resolver rather than hardcoding `~/.claude`, or a
// `CLAUDE_CONFIG_DIR` host silently reads/writes a file Claude Code never
// touches.
//
// `||`, not Claude Code's own `??`: Claude Code resolves `CLAUDE_CONFIG_DIR=""`
// to the empty string, making every subsequent join cwd-relative — mirroring
// that exactly would have Mullion write into whatever directory the server
// process happens to be running in. Treat empty as unset instead, matching
// `resolveCodexHome()`'s existing `||` in codex.ts.
//
// `.normalize("NFC")` is kept because Claude Code itself applies it — the
// point of this resolver is a byte-identical path to the agent's own, and
// skills.ts merges discovery rows by exact path string.
export function resolveClaudeConfigDir(): string {
  return (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")).normalize("NFC");
}
