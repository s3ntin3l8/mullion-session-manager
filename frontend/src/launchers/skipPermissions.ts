import { normalizeAgentId } from "../api/index.js";
import type { Launcher } from "../api/index.js";

/**
 * Whether a launch of `launcher` should skip permission prompts. Precedence:
 * explicit `override`, then the launcher's own `skipPermissions` (true/false,
 * e.g. from `.crs/actions.json`), then membership of the normalized agent id in
 * `settings.launchers.skipPermissionsAgents`. `undefined` for non-agent
 * launchers, which have no permission mode.
 */
export function resolveSkipPermissions(
  launcher: Pick<Launcher, "id" | "kind" | "skipPermissions">,
  settings: { launchers: { skipPermissionsAgents?: string[] } },
  override?: boolean | null,
): boolean | undefined {
  if (launcher.kind !== "agent") return undefined;
  if (override !== null && override !== undefined) return override;
  if (launcher.skipPermissions === true) return true;
  if (launcher.skipPermissions === false) return false;
  return settings.launchers.skipPermissionsAgents?.includes(normalizeAgentId(launcher.id)) ?? false;
}
