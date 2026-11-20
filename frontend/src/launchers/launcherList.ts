import { normalizeAgentId } from "../api/index.js";
import type { Launcher } from "../api/index.js";

// Agents hidden in Settings -> Launchers & agents. The id is normalized
// because the settings store bare names ("claude") while a detected agent's
// launcher id is "agent:claude".
export function isHiddenAgent(launcher: Launcher, hiddenAgents: string[] | undefined): boolean {
  return (
    launcher.kind === "agent" && (hiddenAgents?.includes(normalizeAgentId(launcher.id)) ?? false)
  );
}

// The agents that skip permission prompts by configuration — the settings
// list, then each launcher's own `skipPermissions` (`.crs/actions.json`),
// which wins either way. Drives the "skips prompts" flag both surfaces show.
export function buildSkipPermissionsAgentIds(
  skipPermissionsAgents: string[] | undefined,
  launchers: Launcher[],
): Set<string> {
  const ids = new Set<string>(skipPermissionsAgents ?? []);
  for (const l of launchers) {
    if (l.kind !== "agent") continue;
    const id = normalizeAgentId(l.id);
    if (l.skipPermissions === false) {
      ids.delete(id);
    } else if (l.skipPermissions === true) {
      ids.add(id);
    }
  }
  return ids;
}
