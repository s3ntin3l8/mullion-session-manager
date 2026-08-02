// Issue #431 — Agent Rules Editor. A sibling of project-config.ts, not an
// extension of it: that module's whole contract is "never throw, degrade to
// empty" (see its own header comment) because every consumer there is a
// read-only launcher/dock resolution. This module WRITES real files a user
// asked to edit, where silently swallowing a failure is exactly wrong — a
// caller here needs to know a write didn't happen.
//
// Deliberately a fixed, small allow-list of (agent, scope) targets, never a
// caller-supplied filename — see resolveTarget()'s own doc comment for why.
// tessera's design (see the plan) settled on the same two ideas this module
// implements: a raw-file editor (no attempt to parse `## Rules` sections
// into toggleable fields — a lossy round-trip risk for a hand-authored,
// often git-tracked file) plus PRECEDENCE metadata (which file actually
// wins when an agent has more than one candidate, e.g. Codex's
// AGENTS.override.md over AGENTS.md) rather than a flat, unranked list.

import {
  existsSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  openSync,
  closeSync,
  constants as fsConstants,
} from "node:fs";
import { readFile, stat as statAsync, lstat as lstatAsync } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveCodexHome } from "./hook-adapters/codex.js";
import { resolveClaudeConfigDir } from "./hook-adapters/claude-code.js";
import { resolveOpenCodeConfigHome } from "./hook-adapters/opencode-skills.js";

export type AgentRuleAgent = "claude-code" | "codex" | "opencode" | "agy";
export type AgentRuleScope = "project" | "global";
export type AgentRuleStatus = "active" | "shadowed";

// tessera's `MAX_MEMORY_FILE_BYTES` / `MAX_MEMORY_FILES` guards, ported here
// for the same reason: a hand-authored instruction file is always small in
// practice, so a generous-but-finite cap is a cheap defense against a
// pathological file (or, for a project cwd, a symlink/mount pointing
// somewhere unexpectedly large) blowing up a JSON response.
export const MAX_RULE_FILE_BYTES = 512 * 1024;

// tessera's `withFsDeadline()`, ported for the same reason its own comment
// gives: "fs calls can block indefinitely on hung network, FUSE, or WSL
// mounts" — matters more here than it did for tessera, since a project cwd
// can be a remote-host mount or a slow network filesystem, not just a local
// disk. Read call sites reject into a 503 (transient — see this module's
// route layer); this is not applied to writes, which are expected to be
// fast local operations a user is actively waiting on.
const FS_READ_DEADLINE_MS = 2000;

export class AgentRulesTimeoutError extends Error {
  constructor(filePath: string) {
    super(`Timed out reading ${filePath}`);
    this.name = "AgentRulesTimeoutError";
  }
}

// Hermes review, PR #458 (round 6) — listAgentRules resolves all 12 targets
// via Promise.all, so a single target's EACCES (a genuinely transient
// permission hiccup, not "these files don't exist") used to reject the
// whole call and surface at the route layer as an opaque, uncaught 500.
// listAgentRules' own doc comment is deliberate about NOT collapsing a real
// read failure into an empty-looking result (unlike project-config.ts) —
// this doesn't change that fail-fast contract, it just lets the route give
// it the same clean 503 AgentRulesTimeoutError already gets, instead of a
// raw unstructured 500.
export function isTransientReadError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

// Issue #431, Hermes review on PR #458 — the original version of this
// wrapped a SYNCHRONOUS fs call (readFileSync/statSync) in a setTimeout
// race. That can never work: a hung synchronous call blocks the very event
// loop the timer needs to fire on, so the timeout literally cannot win the
// race — verified empirically (a 2s synchronous busy-wait resolved intact
// instead of rejecting at a 500ms deadline). Worse than a no-op: a
// genuinely hung read blocks the entire server, not just this request.
// Fixed by racing a real `fs/promises` operation (backed by libuv's
// threadpool, so it can actually lose to a timer) against the deadline —
// `Promise.race` is what makes the timeout meaningful here, not the
// wrapper itself.
function withReadDeadline<T>(op: Promise<T>, filePath: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  // Hermes review, PR #458 — the timer used to never be cleared: when `op`
  // won the race it still fired FS_READ_DEADLINE_MS later (rejecting an
  // already-settled promise is a silent no-op), holding the event loop open
  // for up to 2s past every successful read. `finally` clears it on either
  // outcome — `unref()` alone wouldn't help here since a rejection still
  // needs to actually fire if `op` really does hang.
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new AgentRulesTimeoutError(filePath)), FS_READ_DEADLINE_MS);
  });
  return Promise.race([op, timeout]).finally(() => clearTimeout(timer));
}

interface TargetDef {
  /** Stable, URL-safe id — the ONLY thing a route ever accepts from a
   * caller to select a target; never a filename or path (see
   * resolveTarget()). */
  id: string;
  agent: AgentRuleAgent;
  agentLabel: string;
  scope: AgentRuleScope;
  fileName: string;
  /** id of the target this one is shadowed by when BOTH exist, within the
   * same agent's own precedence rules — Codex's AGENTS.override.md over
   * AGENTS.md, and (Hermes review, PR #458) opencode's own AGENTS.md over
   * its CLAUDE.md fallback (opencode's docs: "if you have both AGENTS.md
   * and CLAUDE.md, only AGENTS.md is used"). Cross-agent sharing of the
   * same underlying file (opencode and Codex both read a project's plain
   * AGENTS.md) is not modeled as shadowing: opencode has no *override*
   * concept of its own, so that shared file is simply "active" from
   * opencode's perspective and independently "active"/"shadowed" from
   * Codex's — two separate targets, occasionally the same absolutePath. */
  shadowedBy?: string;
}

/** Global targets are a function of environment, not a static path —
 * resolved lazily, once per listing, rather than baked into resolveTarget's
 * own literal returns. Each agent's own config-root override, not just HOME,
 * matters here: CODEX_HOME for codex, CLAUDE_CONFIG_DIR for claude-code, and
 * XDG_CONFIG_HOME for opencode (via resolveOpenCodeConfigHome, shared with
 * skills.ts's own opencode discovery). Issue #470 — agy has no known
 * override and is left on plain ~/.gemini; the other three used to hardcode
 * their default path, silently reading/writing a file the agent itself never
 * touches on a host that sets the override (verified for opencode against
 * the real opencode binary in #469; for claude-code, statically against the
 * installed 2.1.220 bundle — see resolveClaudeConfigDir's own comment). */
function globalDir(agent: AgentRuleAgent): string {
  switch (agent) {
    case "claude-code":
      return resolveClaudeConfigDir();
    case "codex":
      return resolveCodexHome();
    case "opencode":
      return resolveOpenCodeConfigHome();
    case "agy":
      return path.join(os.homedir(), ".gemini");
  }
}

const AGENT_LABEL: Record<AgentRuleAgent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "opencode",
  agy: "agy",
};

// The fixed allow-list this whole module exists to enforce — see the plan's
// per-agent table. Order here is the order the API/UI presents targets in.
// This is also the literal list of ids resolveTarget()'s switch recognizes
// — kept in sync by construction (every case below has a matching entry
// here, checked by this file's own tests) rather than generated from a
// shared source, precisely so resolveTarget can be a plain switch over
// string literals rather than a runtime Map keyed off caller input (see
// that function's own doc comment for why: CodeQL's path-injection query
// does not treat a `Map.get(taintedId)` lookup as breaking taint on the
// returned value's fields, even though the returned object is always one
// of these 12 known-safe literals — a switch with literal `case`s and
// literal returns is the pattern it does recognize as sanitizing).
const ALL_TARGET_IDS: readonly string[] = [
  "claude-code:project",
  "claude-code:global",
  "codex:project:override",
  "codex:project",
  "codex:global:override",
  "codex:global",
  "opencode:project",
  "opencode:project:claude",
  "opencode:global",
  "opencode:global:claude",
  "agy:project",
  "agy:global",
];

function resolveTargetDir(def: TargetDef, projectCwd: string): string {
  if (def.scope === "project") return projectCwd;
  // opencode's own CLAUDE.md fallback isn't a distinct opencode-owned
  // global file — it's Claude Code's own ~/.claude/CLAUDE.md, read as
  // opencode's secondary candidate when its own AGENTS.md doesn't exist
  // (the plan's global-scope table; Hermes review, PR #458 caught this
  // still pointing at ~/.config/opencode/CLAUDE.md instead — a target that
  // could never exist alongside the shared file it's meant to shadow-check
  // against). The project-scope case needs no such special-casing: both
  // opencode:project:claude and claude-code:project already resolve to the
  // same plain `<cwd>/CLAUDE.md`, since project scope never consults
  // globalDir at all.
  if (def.agent === "opencode" && def.fileName === "CLAUDE.md") {
    return globalDir("claude-code");
  }
  return globalDir(def.agent);
}

// The exhaustive set of filenames any TargetDef can ever carry — every
// value resolveTarget's switch (above) can return, and nothing else.
const SAFE_FILE_NAME_RE = /^(CLAUDE\.md|AGENTS\.md|AGENTS\.override\.md|GEMINI\.md)$/;

/** The single choke point every filesystem sink in this module goes
 * through (stat, read, write, delete) — CodeQL's `js/path-injection` query
 * kept flagging this path as tainted through two earlier attempts (issue
 * #431, PR #458): first a `switch` over literal id cases in resolveTarget
 * (still flagged), then a `RegExp.test()` guard on `def.fileName` ahead of
 * the `path.join` (still flagged, because the checked node — `def.fileName`
 * — wasn't the same node the function returned; it returned a fresh
 * `path.join(...)` expression built FROM it, one property-read removed from
 * what was actually validated).
 *
 * This instead mirrors `resolveWithinRoots` in routes/internal.ts — the one
 * containment shape already proven against a real CodeQL run: those
 * `/internal/*` routes carry zero open path-injection alerts. Its idiom is
 * "compute the exact value once, validate THAT value, return THAT SAME
 * value unchanged" — never re-derive a new expression from a checked
 * sub-part. `resolved` below is the value both validated and returned. */
function resolveTargetPath(def: TargetDef, projectCwd: string): string {
  if (!SAFE_FILE_NAME_RE.test(def.fileName)) {
    throw new Error(
      `Refusing to build a path for unexpected agent-rules filename: ${def.fileName}`,
    );
  }
  const dir = path.resolve(resolveTargetDir(def, projectCwd));
  const resolved = path.join(dir, def.fileName);
  const withinDir = resolved === dir || resolved.startsWith(dir + path.sep);
  if (!withinDir) {
    throw new Error(`Refusing to build a path outside its target directory: ${def.fileName}`);
  }
  return resolved;
}

export interface AgentRuleTarget {
  id: string;
  agent: AgentRuleAgent;
  agentLabel: string;
  scope: AgentRuleScope;
  fileName: string;
  absolutePath: string;
  exists: boolean;
  size: number | null;
  mtimeMs: number | null;
  status: AgentRuleStatus | null;
  content: string | null;
  /** Set when `content` was withheld because the file exceeds
   * MAX_RULE_FILE_BYTES — the target still reports exists/size/mtime, just
   * not the body. */
  truncated: boolean;
  /** Set when the resolved path is itself a symlink (issue #431, Hermes
   * review on PR #458) — `content` is still populated (informational), but
   * writeAgentRule refuses to save through it (AgentRuleSymlinkError), so
   * the UI should treat this target as read-only rather than offer an edit
   * whose Save is guaranteed to fail. */
  isSymlink: boolean;
}

/** Validates a caller-supplied target id against the fixed allow-list and
 * returns its definition, or null. This is the ONLY path from an external
 * request to a filesystem location in this module — never a filename or
 * path taken from a request body/param directly. Confining to a
 * server-defined enum, rather than a path.resolve()-and-confine check on a
 * caller-supplied filename, is deliberately the stricter of the two
 * approaches session-upload.ts's own doc comment describes (that module
 * confines a caller-influenced `cwd` to PROJECTS_ROOTS; this module goes
 * further and doesn't let a caller influence the path at all beyond
 * picking project cwd via an already-trusted project id).
 *
 * Deliberately a `switch` over string literals, each branch returning a
 * literal object, rather than a `Map<string, TargetDef>.get(id)` — a
 * runtime lookup Map keyed on the caller-supplied `id` is exactly the
 * pattern CodeQL's `js/path-injection` query does NOT recognize as
 * sanitizing (it still treats every field of the returned object as
 * tainted by `id`, even though the Map only ever holds these 12 literal
 * values). A `switch` whose cases are literal-equality-checked against
 * `id` and whose branches return literal object expressions is the pattern
 * the query's dataflow analysis does treat as a barrier — confirmed
 * against a real CodeQL run flagging the prior Map-based version at
 * exactly the file-path construction sites below (issue #431, PR #458). */
export function resolveTarget(id: string): TargetDef | null {
  switch (id) {
    case "claude-code:project":
      return {
        id: "claude-code:project",
        agent: "claude-code",
        agentLabel: AGENT_LABEL["claude-code"],
        scope: "project",
        fileName: "CLAUDE.md",
      };
    case "claude-code:global":
      return {
        id: "claude-code:global",
        agent: "claude-code",
        agentLabel: AGENT_LABEL["claude-code"],
        scope: "global",
        fileName: "CLAUDE.md",
      };
    case "codex:project:override":
      return {
        id: "codex:project:override",
        agent: "codex",
        agentLabel: AGENT_LABEL.codex,
        scope: "project",
        fileName: "AGENTS.override.md",
      };
    case "codex:project":
      return {
        id: "codex:project",
        agent: "codex",
        agentLabel: AGENT_LABEL.codex,
        scope: "project",
        fileName: "AGENTS.md",
        shadowedBy: "codex:project:override",
      };
    case "codex:global:override":
      return {
        id: "codex:global:override",
        agent: "codex",
        agentLabel: AGENT_LABEL.codex,
        scope: "global",
        fileName: "AGENTS.override.md",
      };
    case "codex:global":
      return {
        id: "codex:global",
        agent: "codex",
        agentLabel: AGENT_LABEL.codex,
        scope: "global",
        fileName: "AGENTS.md",
        shadowedBy: "codex:global:override",
      };
    case "opencode:project":
      return {
        id: "opencode:project",
        agent: "opencode",
        agentLabel: AGENT_LABEL.opencode,
        scope: "project",
        fileName: "AGENTS.md",
      };
    case "opencode:project:claude":
      return {
        id: "opencode:project:claude",
        agent: "opencode",
        agentLabel: AGENT_LABEL.opencode,
        scope: "project",
        fileName: "CLAUDE.md",
        // Hermes review, PR #458 — opencode's own docs are explicit: "if
        // you have both AGENTS.md and CLAUDE.md, only AGENTS.md is used."
        // This is a within-agent precedence the shadowedBy mechanism
        // already models, distinct from the cross-agent AGENTS.md sharing
        // this file's header comment describes (opencode and Codex each
        // independently deciding active/shadowed for the SAME AGENTS.md).
        shadowedBy: "opencode:project",
      };
    case "opencode:global":
      return {
        id: "opencode:global",
        agent: "opencode",
        agentLabel: AGENT_LABEL.opencode,
        scope: "global",
        fileName: "AGENTS.md",
      };
    case "opencode:global:claude":
      return {
        id: "opencode:global:claude",
        agent: "opencode",
        agentLabel: AGENT_LABEL.opencode,
        scope: "global",
        fileName: "CLAUDE.md",
        shadowedBy: "opencode:global",
      };
    case "agy:project":
      return {
        id: "agy:project",
        agent: "agy",
        agentLabel: AGENT_LABEL.agy,
        scope: "project",
        fileName: "GEMINI.md",
      };
    case "agy:global":
      return {
        id: "agy:global",
        agent: "agy",
        agentLabel: AGENT_LABEL.agy,
        scope: "global",
        fileName: "GEMINI.md",
      };
    default:
      return null;
  }
}

export function listTargetDefs(): ReadonlyArray<{
  id: string;
  agent: AgentRuleAgent;
  agentLabel: string;
  scope: AgentRuleScope;
  fileName: string;
}> {
  // Every id here is a literal from ALL_TARGET_IDS, never caller input —
  // resolveTarget's switch always matches, so the `!` is safe (also
  // enforced by this file's own tests asserting every id resolves).
  return ALL_TARGET_IDS.map((id) => resolveTarget(id)!);
}

async function statTarget(
  def: TargetDef,
  projectCwd: string,
): Promise<{
  absolutePath: string;
  exists: boolean;
  size: number | null;
  mtimeMs: number | null;
  isSymlink: boolean;
}> {
  const absolutePath = resolveTargetPath(def, projectCwd);
  try {
    const info = await withReadDeadline(statAsync(absolutePath), absolutePath);
    // Hermes review, PR #458 — stat() follows symlinks by design (needed for
    // accurate size/mtime), but writeAgentRule refuses to write through one
    // (AgentRuleSymlinkError). lstat here surfaces isSymlink so the UI can
    // mark the target read-only instead of offering an edit whose Save is
    // guaranteed to 400.
    const linkInfo = await withReadDeadline(lstatAsync(absolutePath), absolutePath);
    return {
      absolutePath,
      exists: true,
      size: info.size,
      mtimeMs: info.mtimeMs,
      isSymlink: linkInfo.isSymbolicLink(),
    };
  } catch (err) {
    if (err instanceof AgentRulesTimeoutError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // A DANGLING symlink: stat() follows the link and gets ENOENT for the
      // missing target, but the link itself is still really there — lstat
      // sees it. Hermes review, PR #458 — reporting "not present" here used
      // to be actively misleading: the UI would offer "Create", and
      // attempting to save through it would then confusingly 400 with
      // AgentRuleSymlinkError (O_NOFOLLOW/ELOOP) instead of the write
      // actually creating anything.
      try {
        const linkInfo = await withReadDeadline(lstatAsync(absolutePath), absolutePath);
        if (linkInfo.isSymbolicLink()) {
          return {
            absolutePath,
            exists: true,
            size: null,
            mtimeMs: linkInfo.mtimeMs,
            isSymlink: true,
          };
        }
      } catch {
        // lstat also failed (e.g. also ENOENT, a real TOCTOU unlink
        // in between) — fall through to genuinely-absent below.
      }
      return { absolutePath, exists: false, size: null, mtimeMs: null, isSymlink: false };
    }
    throw err;
  }
}

/** Lists every allow-listed target for `projectCwd`, with content inlined
 * for whatever exists and fits under MAX_RULE_FILE_BYTES. Read failures
 * (permission denied, a timeout) reject with the underlying error — unlike
 * project-config.ts's own "never throw" contract, a caller here (the route
 * layer) needs to distinguish "no rule files configured" (durable, all
 * targets simply don't exist) from "couldn't read right now" (transient,
 * 503) rather than have both collapse into the same empty-looking result. */
// `projectCwd` is ignored for a `scope: "global"` def (resolveTargetDir
// only consults it for `scope: "project"`) — a global target's write/delete
// still arrives through the project-scoped route (see routes/agent-rules.ts's
// file header), so this always has a real project cwd in practice even when
// it goes unused.
async function resolveOneTarget(def: TargetDef, projectCwd: string): Promise<AgentRuleTarget> {
  const resolved = path.resolve(projectCwd || "/");
  const stat = await statTarget(def, resolved);
  let content: string | null = null;
  let truncated = false;
  if (stat.exists && stat.size !== null) {
    if (stat.size > MAX_RULE_FILE_BYTES) {
      truncated = true;
    } else {
      content = await withReadDeadline(readFile(stat.absolutePath, "utf8"), stat.absolutePath);
    }
  }
  // def.shadowedBy is a literal string embedded in a literal TargetDef
  // returned by resolveTarget's own switch above (see e.g. the "codex:
  // project" case) — never caller input — so this resolveTarget call is
  // exactly the same "literal id in, literal def out" shape as every other
  // call site, not a second untrusted lookup.
  const shadowingDef = def.shadowedBy ? resolveTarget(def.shadowedBy) : undefined;
  let status: AgentRuleStatus | null = null;
  if (stat.exists) {
    status = "active";
    if (shadowingDef) {
      const shadowingStat = await statTarget(shadowingDef, resolved);
      if (shadowingStat.exists) status = "shadowed";
    }
  }
  return {
    id: def.id,
    agent: def.agent,
    agentLabel: def.agentLabel,
    scope: def.scope,
    fileName: def.fileName,
    absolutePath: stat.absolutePath,
    exists: stat.exists,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    status,
    content,
    truncated,
    isSymlink: stat.isSymlink,
  };
}

/** A single target's info+content — used for the read-back after a write
 * (both project- and global-scope targets go through the project-scoped
 * routes; see routes/agent-rules.ts's file header for why). */
export function getAgentRule(def: TargetDef, projectCwd: string = "/"): Promise<AgentRuleTarget> {
  return resolveOneTarget(def, projectCwd);
}

// Hermes review, PR #458 — this used to await each of the 12 targets in
// series, each doing up to 4 deadline-raced fs ops (stat/lstat/read/
// shadow-stat) at FS_READ_DEADLINE_MS apiece. On a slow-but-alive mount the
// worst case was the SUM across all targets (tens of seconds), not the max
// of any one — unlike the remote path, which is already capped by
// RemoteHostClient's own REQUEST_TIMEOUT_MS regardless. Resolving targets
// concurrently bounds the worst case to one target's own deadline instead.
export async function listAgentRules(projectCwd: string): Promise<AgentRuleTarget[]> {
  return Promise.all(listTargetDefs().map((def) => resolveOneTarget(def, projectCwd)));
}

export class AgentRuleTooLargeError extends Error {
  constructor(byteLength: number) {
    super(`Content is ${byteLength} bytes, exceeds the ${MAX_RULE_FILE_BYTES}-byte limit`);
    this.name = "AgentRuleTooLargeError";
  }
}

// Hermes review, PR #458 — writeFileSync's default flags follow a symlink at
// the destination path and overwrite whatever it points to. A project's
// CLAUDE.md/AGENTS.md is a hand-authored file inside a cloned repo, which
// could itself ship a symlink pointing outside the repo; saving through this
// editor shouldn't silently write through it.
export class AgentRuleSymlinkError extends Error {
  constructor(filePath: string) {
    super(`Refusing to write through a symlink: ${filePath}`);
    this.name = "AgentRuleSymlinkError";
  }
}

/** Writes `content` to `target`'s resolved path under `projectCwd`,
 * creating parent directories as needed (mirrors writeSessionAgentGuide's
 * own mkdirSync({recursive:true}) precedent for a per-target directory that
 * may not exist yet, e.g. a project with no `~/.config/opencode/` at all).
 * Throws on any failure — never logged-and-swallowed, unlike
 * project-config.ts's reads: a user actively editing a file needs to know
 * their save didn't take.
 *
 * Opens with O_NOFOLLOW rather than calling writeFileSync(path, ...)
 * directly — see AgentRuleSymlinkError's own comment — which turns a
 * would-be silent overwrite-through-a-symlink into a clean, catchable
 * error instead. */
export function writeAgentRule(target: TargetDef, projectCwd: string, content: string): void {
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > MAX_RULE_FILE_BYTES) throw new AgentRuleTooLargeError(byteLength);
  const absolutePath = resolveTargetPath(target, path.resolve(projectCwd));
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  let fd: number;
  try {
    fd = openSync(
      absolutePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") {
      throw new AgentRuleSymlinkError(absolutePath);
    }
    throw err;
  }
  try {
    writeFileSync(fd, content, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** Removes target's file under `projectCwd` if present; a no-op (not an
 * error) if it was already gone — the caller's intent ("this file should
 * not exist") is already satisfied.
 *
 * Hermes review, PR #458 (round 6) — existsSync follows symlinks, so a
 * DANGLING one (which statTarget's own round-5 fix reports as `exists:
 * true`) made this a silent no-op: the check said "doesn't exist" and
 * skipped unlinkSync, so the UI's Delete button appeared to work but never
 * actually removed the stray link. unlinkSync itself doesn't follow
 * symlinks (it always removes the directory entry, whatever it points to),
 * so calling it directly and treating ENOENT as the no-op case — rather
 * than pre-checking with existsSync — handles a dangling symlink
 * correctly. */
export function deleteAgentRule(target: TargetDef, projectCwd: string): void {
  const absolutePath = resolveTargetPath(target, path.resolve(projectCwd));
  try {
    unlinkSync(absolutePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// The distinct project-scope filenames across every target — deliberately
// deduped (AGENTS.md is a separate target for both codex and opencode, but
// the same underlying file), since this is a presence check, not a per-agent
// listing. Global scope is intentionally excluded: a sidebar row is for one
// specific project, and a global file's presence says nothing about that
// project.
//
// Deliberately a hand-written literal array, not derived from
// listTargetDefs()/resolveTarget() the way it originally was — CodeQL's
// js/path-injection flagged the derived version's use below (issue #431,
// PR #458): it treats resolveTarget()'s return as tainted-by-`id` as a
// general function summary, even for these compile-time-only calls with
// literal `ALL_TARGET_IDS` arguments, so anything built from it stays
// "tainted" as far as the query is concerned. A flat literal array has no
// such provenance to trace. This file's own tests assert the two stay in
// sync (`SAFE_FILE_NAME_RE`'s literal set is the same one, checked there).
const PROJECT_SCOPE_FILE_NAMES = ["CLAUDE.md", "AGENTS.md", "AGENTS.override.md", "GEMINI.md"];

/** Cheap, existsSync-only presence check for the sidebar's per-project rule
 * indicator (issue #431) — deliberately NOT listAgentRules(): that reads
 * content, resolves shadowing, and touches global scope too, all more than
 * a sidebar row needs. Rides along on GET /api/projects the same way
 * projects.ts's own currentBranch does — see that route's doc comment for
 * why a synchronous stat is cheap enough to do on every poll. */
export function listExistingProjectRuleFileNames(projectCwd: string): string[] {
  const resolved = path.resolve(projectCwd);
  return PROJECT_SCOPE_FILE_NAMES.filter((fileName) => existsSync(path.join(resolved, fileName)));
}

// Exposes withReadDeadline directly so a test can prove the timeout race
// actually works (with fake timers + a deliberately-never-resolving
// promise) without needing a real hung filesystem or a real multi-second
// wall-clock wait — same `__testing` escape hatch hook-adapters/agy.ts uses
// for its own otherwise-private merge functions.
export const __testing = { withReadDeadline, FS_READ_DEADLINE_MS };
