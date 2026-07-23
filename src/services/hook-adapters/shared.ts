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
export function resolveForwarderPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "..", "hooks", "forwarder.mjs");
}
