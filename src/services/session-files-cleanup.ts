import { rm as rmAsync, unlink as unlinkAsync } from "node:fs/promises";
import { stateFilePath } from "./session-state-file.js";
import { hookTokenPath } from "./hook-token.js";
import { sessionAgentGuidePath } from "./agent-guide.js";
import { sessionBriefingPath } from "./project-briefing.js";
import { sessionWorkflowConventionsPath } from "./workflow-conventions.js";
import {
  opencodeTier0Path,
  opencodeSeedPath,
  opencodeConfigDir,
} from "./hook-adapters/opencode.js";

/**
 * Removes every per-session file a Session writes under `sessionsDir` — the
 * terminal step of PtyManager.terminate(). Extracted from pty-manager.ts
 * (issue #1522), behaviour unchanged (issue #1523's concurrent form).
 *
 * Every removal is best-effort: ENOENT is the expected common case (the file
 * was never written — hooks never fired, the session predates the feature,
 * this isn't an opencode session, the project opted out of a briefing or
 * conventions text, ...). They are independent, so they run concurrently and
 * one failure never skips the others. Never throws.
 *  - agent-guide/briefing (#405) and workflow-conventions (#937) are written
 *    unconditionally at spawn time but nothing else removed them;
 *  - the opencode tier-0/seed files and config dir (#949) share the lifecycle.
 */
export async function cleanupSessionFiles(sessionsDir: string, id: string): Promise<void> {
  await Promise.allSettled([
    unlinkAsync(hookTokenPath(sessionsDir, id)),
    unlinkAsync(stateFilePath(sessionsDir, id)),
    unlinkAsync(sessionAgentGuidePath(sessionsDir, id)),
    unlinkAsync(sessionWorkflowConventionsPath(sessionsDir, id)),
    unlinkAsync(sessionBriefingPath(sessionsDir, id)),
    unlinkAsync(opencodeTier0Path(sessionsDir, id)),
    unlinkAsync(opencodeSeedPath(sessionsDir, id)),
    rmAsync(opencodeConfigDir(sessionsDir, id), { recursive: true, force: true }),
  ]);
}
