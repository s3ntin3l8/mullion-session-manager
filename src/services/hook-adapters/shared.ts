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
function resolveHooksDir(): string {
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
