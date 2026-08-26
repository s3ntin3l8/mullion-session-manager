// U4 (.claude/plans/can-we-do-a-moonlit-treasure.md, Part 2) — the write
// half of a project's dock config. docs/dock.md documents `.crs/dock.json`
// as a hand-editable, git-tracked file; today the only way to add or change
// a monitor is to SSH to the host and edit it directly (project-config.ts's
// resolveProjectDock only ever reads it). This module is this file's write
// counterpart, in exactly the relationship agent-rules.ts already has to
// project-config.ts's OTHER read-only consumer (resolveProjectActions):
// project-config.ts's whole contract is "never throw, degrade to empty"
// (its own header comment) because every consumer there is a read-only
// launcher/dock resolution for the live app; a user actively editing THIS
// file needs to know when a write didn't happen, and needs to be told (not
// silently shown an empty list) when the file they're about to overwrite is
// already broken.
//
// Deliberately narrower than agent-rules.ts: there is exactly ONE target
// here — a project's own `.crs/dock.json` — no per-agent enum, no
// project/global scope choice, no shadowing. The global
// `<configDir>/dock.json` default layer (resolveProjectDock's OTHER input,
// merged UNDER the per-project file) is intentionally not editable from
// here: the plan singles out the per-project gap as the more clearly
// documented one, and editing the global default is a reasonable follow-up,
// not part of this PR (see the PR description).
//
// No read-deadline race (contrast agent-rules.ts's withReadDeadline):
// project-config.ts's own resolveProjectDock reads this exact file with a
// plain synchronous readFileSync and no such guard, so adding one here
// would protect a write path project-config.ts's read path already accepts
// the risk on — inconsistent for no real gain. Synchronous fs calls are
// also cheap here: a `.crs/dock.json` write is a small, local, user-waited
// operation, not a background sweep.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  constants as fsConstants,
} from "node:fs";
import path from "node:path";
import type { DockControl } from "./project-config.js";
import { isReservedSessionEnvKey } from "./session-env-keys.js";

// Re-exported so route layers only need to import from this module for the
// dock-config triple, the same "one import surface per feature" shape
// agent-rules.ts itself provides. The check (EACCES/EPERM) is generic, not
// specific to agent-rules' own file set, so sharing it here rather than
// duplicating it is the "reuse an existing helper" the plan calls for.
export { isTransientReadError } from "./agent-rules.js";

// Same size class as agent-rules.ts's MAX_RULE_FILE_BYTES — a hand-authored
// or generator-produced dock.json is always small in practice; this is a
// cheap defense against a pathological file (or a project cwd that's a
// symlink/mount pointing somewhere unexpectedly large), not a real expected
// ceiling.
export const MAX_DOCK_CONFIG_BYTES = 512 * 1024;

export class DockConfigTooLargeError extends Error {
  constructor(byteLength: number) {
    super(
      `dock.json would be ${byteLength} bytes, exceeds the ${MAX_DOCK_CONFIG_BYTES}-byte limit`,
    );
    this.name = "DockConfigTooLargeError";
  }
}

// writeFileSync's default flags follow a symlink at the destination and
// overwrite whatever it points to. `.crs/dock.json` lives inside a cloned
// repo a user doesn't fully control the contents of; saving through this
// editor shouldn't silently write through a symlink planted there. Mirrors
// agent-rules.ts's own AgentRuleSymlinkError / O_NOFOLLOW posture exactly.
export class DockConfigSymlinkError extends Error {
  constructor(filePath: string) {
    super(`Refusing to write through a symlink: ${filePath}`);
    this.name = "DockConfigSymlinkError";
  }
}

// Thrown for both "the request body doesn't look like a dock.json" (write
// path, surfaced as a 400) and internally reused to detect an
// already-on-disk file that doesn't parse/validate (read path — see
// readDockConfig's own doc comment for why that case is NOT thrown to the
// caller).
export class DockConfigValidationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DockConfigValidationError";
  }
}

function isSafeAbsolutePath(p: string): boolean {
  return path.isAbsolute(p) && !path.normalize(p).split(path.sep).includes("..");
}

/** The single choke point every filesystem sink in this module goes
 * through — mirrors agent-rules.ts's resolveTargetPath idiom ("compute the
 * exact value once, validate THAT value, return THAT SAME value
 * unchanged"), even though the suffix here is a single hardcoded literal
 * (".crs/dock.json", never caller-influenced): a project's `cwd` still
 * flows in from a route layer that, on the remote-host/internal path, only
 * validated it with resolveWithinRoots — not a guarantee that it's a clean
 * absolute path with no `..` segments. Re-checking that here, rather than
 * trusting every call site got it right, is the same defense-in-depth
 * posture git-ignore.ts/git-worktree.ts's own isSafeAbsolutePath guards
 * already use for a project cwd.
 *
 * In practice this throw is unreachable through either current call site
 * as of this writing: routes/projects.ts's POST/PATCH handlers always
 * store a LOCAL_HOST_ID project's `cwd` as `path.resolve(expandHome(...))`
 * (already absolute, `..`-free by construction), and
 * routes/internal.ts's own resolveWithinRoots does the same `path.resolve`
 * before this module ever sees a remote-hosted project's `cwd`. Left in
 * anyway as a guard against a FUTURE call site (or a stored value from
 * before that guarantee existed) skipping that normalization — the same
 * "verify, don't just trust an upstream promise" posture this module's own
 * plan review asked for, not a currently-live gap. */
function resolveDockConfigPath(cwd: string): string {
  const dir = path.resolve(cwd);
  if (!isSafeAbsolutePath(dir)) {
    throw new DockConfigValidationError(`Refusing to resolve dock.json for an unsafe cwd`);
  }
  const target = path.join(dir, ".crs", "dock.json");
  const withinDir = target === dir || target.startsWith(dir + path.sep);
  if (!withinDir) {
    throw new DockConfigValidationError(
      "Refusing to build a dock.json path outside its project cwd",
    );
  }
  return target;
}

// The exhaustive set of fields a DockControl can carry over the wire —
// mirrors project-config.ts's normalizeRawControl, which deliberately never
// reads `source`/`docker` (fields only docker-service-detect.ts is allowed
// to synthesize) so a project's own dock.json "literally cannot set them".
// Rejecting any OTHER unknown key here (rather than silently dropping it,
// as normalizeRawControl's read-side merge does) is the write path's
// stricter posture: a user actively saving a file should be told about a
// typo'd field name, not have it silently vanish.
const ALLOWED_CONTROL_KEYS = new Set([
  "id",
  "title",
  "command",
  "cwd",
  "height",
  "env",
  "worktreeRefresh",
]);

function validateOneControl(raw: unknown, index: number): DockControl {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DockConfigValidationError(`controls[${index}] must be an object`);
  }
  const c = raw as Record<string, unknown>;
  for (const key of Object.keys(c)) {
    if (!ALLOWED_CONTROL_KEYS.has(key)) {
      throw new DockConfigValidationError(`controls[${index}] has an unknown field "${key}"`);
    }
  }
  if (typeof c.id !== "string" || c.id.length === 0) {
    throw new DockConfigValidationError(`controls[${index}].id must be a non-empty string`);
  }
  if (typeof c.title !== "string" || c.title.length === 0) {
    throw new DockConfigValidationError(`controls[${index}].title must be a non-empty string`);
  }
  if (typeof c.command !== "string" || c.command.length === 0) {
    throw new DockConfigValidationError(`controls[${index}].command must be a non-empty string`);
  }
  if (c.cwd !== undefined && typeof c.cwd !== "string") {
    throw new DockConfigValidationError(`controls[${index}].cwd must be a string`);
  }
  if (c.height !== undefined) {
    if (typeof c.height !== "number" || !Number.isInteger(c.height) || c.height <= 0) {
      throw new DockConfigValidationError(`controls[${index}].height must be a positive integer`);
    }
  }
  if (c.worktreeRefresh !== undefined && typeof c.worktreeRefresh !== "boolean") {
    throw new DockConfigValidationError(`controls[${index}].worktreeRefresh must be a boolean`);
  }
  let env: Record<string, string> | undefined;
  if (c.env !== undefined) {
    if (!c.env || typeof c.env !== "object" || Array.isArray(c.env)) {
      throw new DockConfigValidationError(`controls[${index}].env must be an object`);
    }
    for (const [k, v] of Object.entries(c.env as Record<string, unknown>)) {
      if (typeof v !== "string") {
        throw new DockConfigValidationError(`controls[${index}].env.${k} must be a string`);
      }
      // Issue #822 — a dock control's env is applied before every
      // Mullion-owned env write (launch-plan.ts's buildLaunchPlan), so it
      // can never actually override MULLION_*/SSH_AUTH_SOCK — but silently
      // doing nothing is exactly the bug class this feature exists to
      // kill. Reject it here, where the user editing this file can see it.
      if (isReservedSessionEnvKey(k)) {
        throw new DockConfigValidationError(
          `controls[${index}].env has a reserved key "${k}" (MULLION_* and SSH_AUTH_SOCK are set by Mullion itself and cannot be overridden)`,
        );
      }
    }
    env = c.env as Record<string, string>;
  }
  return {
    id: c.id,
    title: c.title,
    command: c.command,
    ...(c.cwd !== undefined ? { cwd: c.cwd as string } : {}),
    ...(c.height !== undefined ? { height: c.height as number } : {}),
    ...(c.worktreeRefresh !== undefined ? { worktreeRefresh: c.worktreeRefresh as boolean } : {}),
    ...(env !== undefined ? { env } : {}),
  };
}

/** Validates a full `{ controls: [...] }` payload — used for BOTH the
 * write path (the request body, before it's ever written to disk) and the
 * read path (an already-on-disk file, to detect a hand-edit gone bad). One
 * shared validator means "what does Save consider valid" and "what does
 * this editor consider broken" can never drift apart. Throws
 * DockConfigValidationError with a specific, field-level reason on any
 * problem — including duplicate `id`s, which a JSON Schema alone can't
 * express (Fastify's schema layer, applied first at the route, already
 * covers per-field types/required-ness; this is the second, semantic
 * pass). */
export function validateDockConfig(raw: unknown): DockControl[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DockConfigValidationError('dock.json must be an object with a "controls" array');
  }
  const controlsRaw = (raw as Record<string, unknown>).controls;
  if (!Array.isArray(controlsRaw)) {
    throw new DockConfigValidationError('"controls" must be an array');
  }
  const controls = controlsRaw.map((entry, index) => validateOneControl(entry, index));
  const seenIds = new Set<string>();
  for (const control of controls) {
    if (seenIds.has(control.id)) {
      throw new DockConfigValidationError(`duplicate control id "${control.id}"`);
    }
    seenIds.add(control.id);
  }
  return controls;
}

export interface DockConfigReadResult {
  controls: DockControl[];
  /** True when a `.crs/dock.json` exists but doesn't parse as JSON or
   * doesn't validate against validateDockConfig — deliberately NOT
   * collapsed into an empty-looking `controls: []` the way
   * project-config.ts's own read side treats a malformed file (that
   * "silently treated as empty" contract is right for the live Dock,
   * which just wants a best-effort list; it's actively misleading for an
   * editor, which would otherwise show a confident-looking empty form for
   * a file that actually has content). `controls` is still `[]` in this
   * case — there is nothing safe to prefill the editor with — but the
   * caller can tell "genuinely no config yet" apart from "config is
   * broken, here's why" and choose to warn before an overwriting Save. */
  invalid: boolean;
  reason: string | null;
  /** True when the resolved `.crs/dock.json` path is itself a symlink
   * (dangling or not) — mirrors agent-rules.ts's own AgentRuleTarget's
   * `isSymlink` field (Hermes review precedent on PR #458) exactly:
   * `controls`/`invalid`/`reason` above are still populated from following
   * the symlink where that's possible (informational — same as
   * AgentRulesPanel's own "show real content, read-only" posture), but
   * writeDockConfig refuses to save through one (DockConfigSymlinkError,
   * O_NOFOLLOW), so a caller should treat this target as read-only rather
   * than offer an edit whose Save is guaranteed to fail with a 400. */
  isSymlink: boolean;
}

// lstat (unlike stat/existsSync/readFileSync) does NOT follow a symlink —
// it reports on the link itself, so this is the only way to detect one at
// all, including a DANGLING symlink that existsSync would otherwise report
// as "doesn't exist" (mirrors agent-rules.ts's statTarget, which hits the
// identical ENOENT-vs-dangling-symlink distinction for the same reason).
// Never throws: a genuine lstat failure (permission denied, a real TOCTOU
// unlink) just means "can't tell, so no" — the same "unknown collapses to
// the less alarming case" posture project-config.ts's own read side uses
// throughout.
//
// Two different roles depending on the caller (narrowed per issue #605 —
// this used to claim it was purely informational everywhere, which stopped
// being true the moment writeDockConfig started gating `.crs/` with it):
// purely informational for readDockConfig's own `isSymlink` field below (the
// real gate on THAT path is writeDockConfig's O_NOFOLLOW open, which this
// function can't weaken by ever getting the flag wrong), but a real security
// gate when writeDockConfig calls this on the `.crs/` directory itself
// before mkdirSync — O_NOFOLLOW only protects dock.json's own leaf
// component, nothing checks `.crs/` otherwise, so a wrong `false` here would
// let a write walk straight through a symlinked `.crs/`.
function isSymlinkPath(filePath: string): boolean {
  try {
    // Dismissed in GHAS as alert #188 (js/path-injection, won't-fix) — see
    // resolveDockConfigPath's own doc comment for the containment argument.
    // A `codeql[js/path-injection]` line comment above this call IS a real
    // CodeQL suppression annotation (recognized since CodeQL 2.12, marks the
    // matching SARIF result as suppressed) — but this repo's codeql.yml
    // workflow runs plain codeql-action/analyze with no follow-up step (e.g.
    // advanced-security/dismiss-alerts) that reads that SARIF suppression
    // data and calls the code-scanning API to actually dismiss the alert.
    // So the annotation alone never flips the Security tab's alert state —
    // dismissal there only ever happens via the API/UI, which is what
    // produced the "won't-fix" dismissal above.
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Reads and validates `cwd`'s own `.crs/dock.json` — the raw, per-project
 * source file, NOT project-config.ts's resolveProjectDock merge (which
 * layers in the global `<configDir>/dock.json` default and
 * docker-service-detect.ts's synthesized entries). Editing the MERGED view
 * would risk persisting global-layer or synthesized `docker`-sourced
 * controls into a project's own tracked file — exactly the kind of
 * cross-layer leak this function exists to avoid. A missing file is the
 * normal case (most projects have no `.crs/` dir yet) and returns an empty,
 * valid result — never `invalid`. Never throws for a malformed file (see
 * `invalid` above); DOES throw for a genuine I/O failure (permission
 * denied, etc.) — the route layer maps that via `isTransientReadError`. */
export function readDockConfig(cwd: string): DockConfigReadResult {
  const filePath = resolveDockConfigPath(cwd);
  const isSymlink = isSymlinkPath(filePath);
  // GitHub Advanced Security (CodeQL) flags every fs call below as
  // js/path-injection — the same "real mitigation, not a recognized
  // sanitizer shape" situation git-worktree.ts's/git-branch-delete.ts's own
  // isSafeAbsolutePath-gated calls already document for this identical
  // query (see resolveDockConfigPath's own comment, and routes/projects.ts's
  // near-identical dismissal for this exact value — a LOCAL_HOST_ID
  // project's own `cwd`, at its POST/PATCH handlers' mkdir call). `cwd`
  // here is either that same already-trusted project.cwd (an authenticated
  // caller who can set it can already spawn a session against it — full
  // code execution, strictly more powerful than a scoped file read/write),
  // or, on the remote-host path, a value routes/internal.ts's own
  // resolveWithinRoots already confined to this agent's PROJECTS_ROOTS
  // before ever calling in here — verified directly by
  // test/services/dock-config.test.ts's own resolveDockConfigPath suite and
  // test/routes/internal.test.ts's "/internal/dock-config" describe block.
  // Dismissed in GHAS as alerts #189 (below) and #183 (readFileSync below)
  // rather than reshaping already-verified-safe code to chase a query that
  // doesn't model manual containment checks as sanitizers — see
  // isSymlinkPath's own doc comment above for why a `codeql[...]` line
  // comment here wouldn't have flipped the Security tab's alert state on
  // its own anyway.
  if (!existsSync(filePath)) {
    return { controls: [], invalid: false, reason: null, isSymlink };
  }
  const raw = readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      controls: [],
      invalid: true,
      reason: `Not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      isSymlink,
    };
  }
  try {
    return { controls: validateDockConfig(parsed), invalid: false, reason: null, isSymlink };
  } catch (err) {
    if (err instanceof DockConfigValidationError) {
      return { controls: [], invalid: true, reason: err.message, isSymlink };
    }
    throw err;
  }
}

/** Writes `controls` to `cwd`'s `.crs/dock.json`, creating the `.crs`
 * directory if needed (mirrors agent-rules.ts's writeAgentRule and
 * writeSessionAgentGuide's own mkdirSync({recursive:true}) precedent for a
 * per-target directory that may not exist yet). Throws on any failure —
 * never logged-and-swallowed, unlike project-config.ts's reads: a user
 * actively saving a file needs to know their save didn't take.
 *
 * `controls` is assumed already validated by validateDockConfig (the route
 * layer does this before calling in, same as agent-rules.ts's route calling
 * writeAgentRule only after its own schema check) — this function's own job
 * is purely the filesystem side: size cap, symlink refusal, atomic-enough
 * write. Formatted with 2-space indentation and a trailing newline to match
 * docs/dock.md's own Quick Start example — this file is meant to be
 * hand-read and git-diffed, not minified. */
export function writeDockConfig(cwd: string, controls: DockControl[]): void {
  const content = JSON.stringify({ controls }, null, 2) + "\n";
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > MAX_DOCK_CONFIG_BYTES) throw new DockConfigTooLargeError(byteLength);
  const filePath = resolveDockConfigPath(cwd);
  const dockDir = path.dirname(filePath);
  // The O_NOFOLLOW open below only protects filePath's own leaf component
  // (dock.json) — it says nothing about `.crs/`, the one intermediate
  // directory mkdirSync can create or walk into (issue #605). A symlink
  // planted at `.crs` (e.g. `.crs -> /etc`) would make mkdirSync's
  // recursive:true a silent no-op (the target already "exists" as a
  // directory, symlink-followed) and then the O_NOFOLLOW open below would
  // happily write dock.json into wherever `.crs` actually points, since
  // O_NOFOLLOW never inspects any ancestor of the path it's opening. Same
  // authenticated-access-plus-pre-planted-symlink threat model as
  // resolveDockConfigPath's own containment check — refusing here closes it
  // for the one directory this module ever creates.
  if (isSymlinkPath(dockDir)) {
    throw new DockConfigSymlinkError(dockDir);
  }
  // Same dismissal, same reasoning, as readDockConfig's own two flagged
  // calls above — see that comment for the full trust-boundary argument.
  // Dismissed in GHAS as alert #187.
  mkdirSync(dockDir, { recursive: true });
  // Re-check after mkdirSync (Hermes review, PR #612): the lstat above and
  // this mkdirSync are two separate syscalls with a window between them —
  // `.crs` swapped from a real directory to a symlink in that window would
  // make mkdirSync's recursive:true a silent no-op (the symlink's target
  // already "exists" as a directory) and this second check catches that
  // before the O_NOFOLLOW open below ever runs. This narrows the race, it
  // doesn't eliminate it: `.crs` could still be swapped between THIS check
  // and the open, and O_NOFOLLOW only guards dock.json's own leaf, not the
  // `.crs` component it's nested under — a fully race-free fix would need
  // an `openat`-style "open relative to an already-open directory fd" API,
  // which Node's fs module doesn't expose. Same authenticated-access-plus-
  // pre-planted-symlink threat model as everywhere else in this file; a
  // narrow, race-perfect timing on top of that is out of scope here.
  if (isSymlinkPath(dockDir)) {
    throw new DockConfigSymlinkError(dockDir);
  }
  let fd: number;
  try {
    // Dismissed in GHAS as alert #185.
    fd = openSync(
      filePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") {
      throw new DockConfigSymlinkError(filePath);
    }
    throw err;
  }
  try {
    writeFileSync(fd, content, "utf8");
  } finally {
    closeSync(fd);
  }
}

// Exposes resolveDockConfigPath directly so a test can prove its own
// containment guard actually rejects an unsafe `cwd` (GitHub Advanced
// Security flagged every fs sink in this file as
// js/path-injection — "this path depends on a user-provided value" — on
// the PR that introduced it; this function is the real mitigation, and
// this hook lets a test exercise it in isolation rather than only through
// the two route layers that already call it with a pre-sanitized `cwd`).
// Same `__testing` escape hatch pattern agent-rules.ts and
// hook-adapters/agy.ts already use for their own otherwise-private
// functions.
export const __testing = { resolveDockConfigPath };
