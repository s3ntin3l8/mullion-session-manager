import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Resolves the "launcher" abstraction the plan unifies vision items #5
// (bash/zsh/agent shortcuts), #6 (autodetected AI CLIs — see
// src/routes/agents.ts, which feeds this via the global-preset layer), and
// #7 (per-project actions/dock, cmux's `.cmux/cmux.json` / `.cmux/dock.json`
// equivalent) into one data model instead of three. Everything here is
// read-only: it never spawns anything — launching a Launcher is just a
// normal POST /api/sessions using its `command` (see src/routes/sessions.ts).
//
// Every file read in this module is best-effort: a missing file is the
// normal case (most projects have no .crs/ dir at all), and a malformed one
// must never break the API it feeds — so every read is wrapped and reduced
// to an empty result plus a logged warning, never a thrown error.

export type LauncherKind = "shell" | "agent" | "npm-script" | "task" | "custom";

export interface Launcher {
  id: string;
  title: string;
  command: string;
  cwd?: string;
  icon?: string;
  kind: LauncherKind;
}

export interface DockControl {
  id: string;
  title: string;
  command: string;
  cwd?: string;
  height?: number;
  env?: Record<string, string>;
}

interface RawActionsFile {
  // When true, this file's actions REPLACE the auto-read package.json/
  // tasks.json sources entirely rather than merging over them — satisfies
  // "overwrite if a specific config file is present" for repos that want
  // full control over their launcher list.
  override?: boolean;
  actions?: unknown;
}

interface RawDockFile {
  controls?: unknown;
}

function warn(message: string, err?: unknown): void {
  console.warn(`[project-config] ${message}`, err ?? "");
}

/** Expand a leading "~" to the current user's home dir, same convention for
 * both PROJECTS_ROOTS and CRS_CONFIG_DIR entries. Leaves absolute/relative
 * paths without a leading "~" untouched. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function readJsonFile(filePath: string): unknown | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    warn(`failed to parse ${filePath}, skipping`, err);
    return null;
  }
}

/** package.json `scripts` → one launcher per script, lowest-precedence source. */
function readPackageJsonScripts(cwd: string): Launcher[] {
  const parsed = readJsonFile(path.join(cwd, "package.json"));
  if (!parsed || typeof parsed !== "object") return [];
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object") return [];

  return Object.entries(scripts as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name]) => ({
      id: `npm:${name}`,
      title: name,
      command: `npm run ${name}`,
      kind: "npm-script" as const,
    }));
}

interface VscodeTask {
  label?: string;
  type?: string;
  command?: string;
  args?: unknown;
}

/** .vscode/tasks.json shell/process tasks → one launcher each. Deliberately
 * NOT launch.json — that's debugger configuration (program/args/adapter),
 * it doesn't describe "run a command in a terminal" the way tasks.json does. */
function readTasksJson(cwd: string): Launcher[] {
  const parsed = readJsonFile(path.join(cwd, ".vscode", "tasks.json"));
  if (!parsed || typeof parsed !== "object") return [];
  const tasks = (parsed as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return [];

  const launchers: Launcher[] = [];
  tasks.forEach((raw: unknown, index: number) => {
    if (!raw || typeof raw !== "object") return;
    const task = raw as VscodeTask;
    if (task.type !== "shell" && task.type !== "process") return;
    if (typeof task.command !== "string" || task.command.length === 0) return;

    const args = Array.isArray(task.args)
      ? task.args.filter((a): a is string => typeof a === "string")
      : [];
    const label = typeof task.label === "string" && task.label.length > 0
      ? task.label
      : `task ${index}`;

    launchers.push({
      id: `task:${label}`,
      title: label,
      command: [task.command, ...args].join(" "),
      kind: "task",
    });
  });
  return launchers;
}

function normalizeRawAction(raw: unknown, source: string): Launcher | null {
  if (!raw || typeof raw !== "object") {
    warn(`skipping non-object action entry in ${source}`);
    return null;
  }
  const a = raw as Record<string, unknown>;
  if (typeof a.id !== "string" || typeof a.title !== "string" || typeof a.command !== "string") {
    warn(`skipping action missing id/title/command (string) in ${source}`);
    return null;
  }
  return {
    id: a.id,
    title: a.title,
    command: a.command,
    ...(typeof a.cwd === "string" ? { cwd: a.cwd } : {}),
    ...(typeof a.icon === "string" ? { icon: a.icon } : {}),
    kind: (typeof a.kind === "string" ? (a.kind as LauncherKind) : "custom"),
  };
}

function readActionsFile(filePath: string): { override: boolean; actions: Launcher[] } | null {
  const parsed = readJsonFile(filePath);
  if (!parsed || typeof parsed !== "object") return null;
  const raw = parsed as RawActionsFile;
  const actions = Array.isArray(raw.actions)
    ? raw.actions
        .map((entry) => normalizeRawAction(entry, filePath))
        .filter((l): l is Launcher => l !== null)
    : [];
  return { override: raw.override === true, actions };
}

function mergeById(...lists: Launcher[][]): Launcher[] {
  const merged = new Map<string, Launcher>();
  for (const list of lists) for (const launcher of list) merged.set(launcher.id, launcher);
  return [...merged.values()];
}

/**
 * Resolve a project's full launcher list, layered lowest → highest
 * precedence: package.json scripts, .vscode/tasks.json, then the repo's own
 * `.crs/actions.json` (which can also set `override: true` to replace the
 * auto-read sources entirely instead of merging over them). `globalPresets`
 * (built-in shell/agent launchers from src/routes/agents.ts, plus the
 * global `.crs/actions.json` under CRS_CONFIG_DIR) sit below all of these —
 * a project can always override a global preset by reusing its `id`.
 */
export function resolveProjectActions(cwd: string, globalPresets: Launcher[] = []): Launcher[] {
  const repoConfig = readActionsFile(path.join(cwd, ".crs", "actions.json"));

  if (repoConfig?.override) {
    return mergeById(globalPresets, repoConfig.actions);
  }

  return mergeById(
    globalPresets,
    readPackageJsonScripts(cwd),
    readTasksJson(cwd),
    repoConfig?.actions ?? [],
  );
}

/** Global (non-project-specific) launchers from `<configDir>/actions.json`. */
export function resolveGlobalActions(configDir: string): Launcher[] {
  const resolved = readActionsFile(path.join(expandHome(configDir), "actions.json"));
  return resolved?.actions ?? [];
}

function normalizeRawControl(raw: unknown, source: string): DockControl | null {
  if (!raw || typeof raw !== "object") {
    warn(`skipping non-object dock control entry in ${source}`);
    return null;
  }
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== "string" || typeof c.title !== "string" || typeof c.command !== "string") {
    warn(`skipping dock control missing id/title/command (string) in ${source}`);
    return null;
  }
  return {
    id: c.id,
    title: c.title,
    command: c.command,
    ...(typeof c.cwd === "string" ? { cwd: c.cwd } : {}),
    ...(typeof c.height === "number" ? { height: c.height } : {}),
    ...(c.env && typeof c.env === "object"
      ? {
          env: Object.fromEntries(
            Object.entries(c.env as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === "string",
            ),
          ),
        }
      : {}),
  };
}

function readDockFile(filePath: string): DockControl[] {
  const parsed = readJsonFile(filePath);
  if (!parsed || typeof parsed !== "object") return [];
  const controls = (parsed as RawDockFile).controls;
  if (!Array.isArray(controls)) return [];
  return controls
    .map((entry) => normalizeRawControl(entry, filePath))
    .filter((c): c is DockControl => c !== null);
}

/**
 * Resolve a project's dock controls: the repo's own `.crs/dock.json`,
 * merged over the global `<configDir>/dock.json` default (by `id`, repo
 * wins) — mirrors cmux's Dock precedence (per-repo config over the
 * personal global default), except merged rather than fully replacing,
 * since dock controls (dev server, git status, logs) are commonly additive
 * across a team's shared config and a developer's personal ones.
 */
export function resolveProjectDock(cwd: string, configDir: string): DockControl[] {
  const globalControls = readDockFile(path.join(expandHome(configDir), "dock.json"));
  const repoControls = readDockFile(path.join(cwd, ".crs", "dock.json"));

  const merged = new Map<string, DockControl>();
  for (const control of globalControls) merged.set(control.id, control);
  for (const control of repoControls) merged.set(control.id, control);
  return [...merged.values()];
}
