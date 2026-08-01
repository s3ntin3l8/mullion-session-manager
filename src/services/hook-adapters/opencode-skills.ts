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
import { assertSafeSkillName, isDangerousSkillName, InvalidSkillNameError } from "./skill-name.js";

export class OpenCodeConfigParseError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(`cannot parse existing ${filePath}, leaving it untouched`, { cause });
    this.name = "OpenCodeConfigParseError";
  }
}

/** `name` already has a `permission.skill` entry set to something other than
 * `"deny"` — refuse to overwrite it rather than silently destroying a
 * user-authored value (e.g. `"ask"`). Same "refuse rather than clobber
 * user-authored state" posture as codex-skills.ts's
 * CodexSkillUserAuthoredError. Hermes review, PR #469, round 3: the disable
 * path used to write `"deny"` unconditionally, an asymmetry with the enable
 * path's already-guarded delete (only deletes when the current value is
 * exactly "deny") — a user with `foo: "ask"` saw "Enabled" (the read map
 * treats any non-"deny" as enabled), clicked disable, and their "ask" was
 * gone; re-enabling then deleted the key outright, since by then it read
 * "deny" — unrecoverable through the UI. */
export class OpenCodeSkillUserAuthoredError extends Error {
  constructor(name: string) {
    super(`permission.skill already has a user-authored entry for "${name}"`);
    this.name = "OpenCodeSkillUserAuthoredError";
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

// Hermes review, PR #469 — was hardcoded to `~/.config/opencode`, but
// opencode resolves its global config via `xdg-basedir`'s `xdgConfig`:
// `$XDG_CONFIG_HOME/opencode` when that's set (verified directly: with
// XDG_CONFIG_HOME pointing elsewhere, `opencode debug config` resolves from
// there, not `~/.config`), else `~/.config/opencode`. On any host with
// XDG_CONFIG_HOME set (NixOS and similar), the old hardcoded path silently
// wrote a file opencode never loads while the reader silently reported
// stale state from the same wrong file — unlike the loud JSONC-parse-
// failure degradation, this failure mode was completely silent. Also used
// by skills.ts's own `globalSkillDirs()` for `.../opencode/skills`
// discovery, so a skill under a real XDG_CONFIG_HOME install is now
// actually discovered, not just correctly toggled.
//
// Deliberately does NOT follow `OPENCODE_CONFIG_DIR` — verified separately
// that it also overrides opencode's resolved config, but it's an env var
// Mullion itself sets ONLY for the duration of a single hook-forwarding
// session (opencode.ts's own ephemeral adapter). This toggle targets the
// user's PERSISTENT global config regardless of what session happens to be
// running when it's written — following OPENCODE_CONFIG_DIR here would
// mean writing into a throwaway per-session directory instead.
export function resolveOpenCodeConfigHome(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  return xdgConfigHome
    ? path.join(xdgConfigHome, "opencode")
    : path.join(os.homedir(), ".config", "opencode");
}

export function resolveOpenCodeConfigPath(): string {
  return path.join(resolveOpenCodeConfigHome(), "opencode.json");
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
 * skill), reads as enabled — callers default missing entries to `true`.
 *
 * Hermes review, PR #469 — known, accepted gap from the exact-key-only
 * posture: a user-authored WILDCARD rule (e.g. `"some-prefix-*": "deny"`)
 * that happens to match a skill's name is invisible here, so the UI can
 * show "Enabled" for a skill opencode is still actually denying via that
 * rule. Full pattern evaluation would mean reimplementing opencode's own
 * permission-matching engine; deferred rather than guessed at. */
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
 * would look user-authored on a later read) unless the current value isn't
 * this writer's own `"deny"`, in which case it's left untouched. `enabled:
 * false` sets `"deny"` unless a user-authored non-`"deny"` value is already
 * there, in which case it refuses (OpenCodeSkillUserAuthoredError) rather
 * than clobbering it — symmetric with the enable path's own guard. */
export function writeOpenCodeSkillEnabled(name: string, enabled: boolean): void {
  assertSafeSkillName(name);
  const filePath = resolveOpenCodeConfigPath();
  const config = readConfigFile(filePath);

  const existingPermission =
    config.permission && typeof config.permission === "object" ? config.permission : {};
  const existingSkill =
    existingPermission.skill && typeof existingPermission.skill === "object"
      ? (existingPermission.skill as Record<string, unknown>)
      : {};

  // CodeQL (js/remote-property-injection) — a call to assertSafeSkillName
  // above alone was not recognized as a barrier guarding the dynamic
  // property accesses below, so the same check is repeated here, inline,
  // immediately dominating both. `Object.create(null)` is additional,
  // structural defense in depth: a null-prototype object has no `__proto__`
  // accessor to invoke at all, so even an unvalidated `name` could only
  // ever create/delete an ordinary own data property, never touch a real
  // prototype — JSON.stringify serializes it identically to a plain `{}`.
  if (isDangerousSkillName(name)) throw new InvalidSkillNameError(name);
  const skill: Record<string, unknown> = Object.assign(Object.create(null), existingSkill);
  if (enabled) {
    // Hermes review, PR #469 — only delete when the current value is
    // EXACTLY "deny", the one value this writer itself ever produces. A
    // blind delete used to discard any OTHER value a user had set for
    // their own reasons (e.g. "ask") the moment they ran a disable→enable
    // cycle through the UI — same "refuse rather than clobber
    // user-authored state" posture writeCodexSkillEnabled already has via
    // CodexSkillUserAuthoredError. Nothing to do if the current value
    // isn't "deny": readOpenCodeSkillEnabledMap already reports anything
    // other than "deny" as enabled, so there's no state left to fix.
    if (skill[name] === "deny") delete skill[name];
  } else {
    // Hermes review, PR #469, round 3 — the symmetric case: refuse rather
    // than clobber an existing user-authored non-"deny" value (e.g. "ask")
    // with "deny". A value that's already absent or already "deny" is safe
    // to (re)write — that's this writer's own idempotent state, not a
    // user's choice being overwritten.
    if (name in skill && skill[name] !== "deny") {
      throw new OpenCodeSkillUserAuthoredError(name);
    }
    skill[name] = "deny";
  }

  const permission: OpenCodePermissionValue = { ...existingPermission, skill };
  const merged: OpenCodeConfigFile = { ...config, permission };

  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`);
}
