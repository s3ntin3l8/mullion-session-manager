// The running Mullion's own version — "what version am I", read once from
// package.json.
//
// It lives in a service rather than in src/routes/server-info.ts because two
// SERVICES need it (host-agents.ts and placement.ts, both of which compare a
// host's reported version against the primary's), and a service importing a
// route file inverts the layering (routes -> services -> db): it is what
// made "a helper happens to live in a route file" the normal way to share
// something. See issue #2413.
//
// src/routes/server-info.ts re-exports it, so every existing importer
// (src/routes/updates.ts, src/routes/hosts.ts, src/routes/internal.ts and
// the tests) keeps its import path unchanged.

import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Read once at module load — package.json never changes at runtime, and this
// avoids a filesystem hit on every request. Resolved relative to this file
// (not process.cwd()) so it's correct regardless of where the process is
// launched from, matching the pattern other path-resolution in this repo
// uses (see pty-manager.ts's constructor comment on SESSIONS_DIR).
const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));

// Exported for reuse by src/routes/updates.ts, which needs the same
// "what version am I" value to compare against the latest GitHub release.
export const appVersion =
  (JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: string }).version ??
  "unknown";
