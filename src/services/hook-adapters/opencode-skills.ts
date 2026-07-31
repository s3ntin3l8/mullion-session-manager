// Issue #463 — Skills Manager, opencode enable/disable half. Writes the
// user's real global `~/.config/opencode/opencode.json` — the first time
// this repo writes any part of opencode's real config (opencode.ts's own
// adapter is deliberately fully ephemeral; see that file's header). Only the
// GLOBAL config is read/written — a project-scope `opencode.json`/
// `.opencode/opencode.json` deep-merges over it and could show a different
// effective state (documented simplification, not fixed in this slice).
//
// Verified empirically against opencode 1.18.10 before writing any of this
// (see the plan doc's verification section): `permission.skill.<name> =
// "deny"` resolves, via `opencode debug agent <name>`'s ACTUAL resolved
// permission list (not just the SDK's generated types, which omit
// `permission.skill` entirely in this version), to a real
// `{permission: "skill", pattern: "<name>", action: "deny"}` rule. Same
// name-not-path selector as Codex (opencode's own bundled `customize-opencode`
// skill: "`name` is required... and matches the folder name" — a per-skill
// constraint, not a global-uniqueness one), so the identical ambiguous-name
// collision this module's caller (skills.ts's attachEnabledByAgent) guards
// against for Codex applies here too.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export class OpenCodeConfigParseError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(`cannot parse existing ${filePath}, leaving it untouched`, { cause });
    this.name = "OpenCodeConfigParseError";
  }
}

interface OpenCodePermissionValue {
  skill?: unknown;
  [key: string]: unknown;
}

interface OpenCodeConfigFile {
  permission?: OpenCodePermissionValue;
  [key: string]: unknown;
}

export function resolveOpenCodeConfigPath(): string {
  return path.join(os.homedir(), ".config", "opencode", "opencode.json");
}

function readConfigFile(filePath: string): OpenCodeConfigFile {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw new OpenCodeConfigParseError(filePath, err);
  }
  try {
    return JSON.parse(text) as OpenCodeConfigFile;
  } catch (err) {
    // Deliberately not JSONC-tolerant (a plain JSON.parse) — opencode's own
    // docs mention `.jsonc` as a valid project-config filename, so a global
    // config with comments would hit this and the toggle becomes
    // unavailable with a clear error. Acceptable degradation for this
    // slice, not a blocker (this host's real config has no comments).
    throw new OpenCodeConfigParseError(filePath, err);
  }
}

/** `name` -> effective enabled state, read directly from `permission.skill`
 * (an exact-key lookup only — no glob/pattern matching against `*` or other
 * entries, a deliberate simplification given opencode's own "last matching
 * rule wins" pattern semantics aren't needed for the exact-name keys this
 * module ever writes). A name absent from the map, or present with a value
 * other than `"deny"` (e.g. `"ask"`, which doesn't outright block the
 * skill), reads as enabled — callers default missing entries to `true`. */
export function readOpenCodeSkillEnabledMap(): Map<string, boolean> {
  const filePath = resolveOpenCodeConfigPath();
  const config = readConfigFile(filePath);
  const skillPermissions = config.permission?.skill;
  const result = new Map<string, boolean>();
  if (skillPermissions && typeof skillPermissions === "object") {
    for (const [name, action] of Object.entries(skillPermissions as Record<string, unknown>)) {
      result.set(name, action !== "deny");
    }
  }
  return result;
}

/** Read-modify-write, mirroring codex.ts's `mergeCodexHooks` posture: parse,
 * refuse on parse failure, preserve every unrelated top-level key (this
 * host's real file has `$schema`, `plugin`, `mcp`) and every unrelated
 * `permission.*` sibling. `enabled: true` deletes the key entirely (reverts
 * to opencode's own default rather than writing an explicit `"allow"` that
 * would look user-authored on a later read); `enabled: false` sets `"deny"`. */
export function writeOpenCodeSkillEnabled(name: string, enabled: boolean): void {
  const filePath = resolveOpenCodeConfigPath();
  const config = readConfigFile(filePath);

  const existingPermission =
    config.permission && typeof config.permission === "object" ? config.permission : {};
  const existingSkill =
    existingPermission.skill && typeof existingPermission.skill === "object"
      ? (existingPermission.skill as Record<string, unknown>)
      : {};

  const skill = { ...existingSkill };
  if (enabled) {
    delete skill[name];
  } else {
    skill[name] = "deny";
  }

  const permission: OpenCodePermissionValue = { ...existingPermission, skill };
  const merged: OpenCodeConfigFile = { ...config, permission };

  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`);
}
