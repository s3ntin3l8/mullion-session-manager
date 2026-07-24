import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolves the shared forwarder's absolute path relative to THIS module's
// own location, rather than hardcoding `src/` or `dist/` — so it resolves
// correctly whether the server is running under `tsx` (dev, this file lives
// at src/services/hook-adapters/shared.ts) or compiled (`dist/services/
// hook-adapters/shared.js`, same relative depth — tsc mirrors src/'s
// directory structure, and `make build` copies src/hooks/ into dist/hooks/
// verbatim since forwarder.mjs is plain JS with no compile step of its own —
// see package.json's build script and src/hooks/forwarder.mjs's own header
// comment for why).
//
// On a versioned-release install (MULLION_HOME set — see env.ts's own
// comment and deploy/install.sh), prefer the stable `current` symlink over
// this module's own realpathed, per-release location. Codex's hook adapter
// (codex.ts) embeds this path verbatim in the merged hook's command string,
// and Codex trusts that command by hash (issue #259) — resolving via
// `import.meta.url` alone means every release bump changes the path, changes
// the hash, and silently re-triggers Codex's one-time interactive `/hooks`
// trust prompt. Resolving through `current` instead keeps the command
// identical across upgrades, so a trust grant persists forever, not just
// until the next update. Read directly off process.env (bypassing
// app.config) the same way codex.ts already reads CODEX_HOME: this module is
// a plain function called from the hook-adapters/pty-manager seam, with no
// Fastify app instance in scope. Dev checkouts (`make dev`) and any
// non-versioned install never set MULLION_HOME, so they keep today's
// import.meta.url resolution unchanged.
function resolveHooksDir(): string {
  const mullionHome = process.env.MULLION_HOME?.trim();
  if (mullionHome) {
    return path.join(mullionHome, "current", "dist", "hooks");
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "..", "hooks");
}

export function resolveForwarderPath(): string {
  return path.join(resolveHooksDir(), "forwarder.mjs");
}

/** Same dev/prod resolution as resolveForwarderPath() above, for OpenCode's
 * plugin file (issue #175) — see src/hooks/opencode-plugin.js's own header
 * comment for why it's plain JS too. */
export function resolveOpenCodePluginPath(): string {
  return path.join(resolveHooksDir(), "opencode-plugin.js");
}
