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

import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHome } from "./project-config.js";
import { resolveCodexHome } from "./hook-adapters/codex.js";

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

function withReadDeadline<T>(fn: () => T, filePath: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AgentRulesTimeoutError(filePath)),
      FS_READ_DEADLINE_MS,
    );
    try {
      const result = fn();
      clearTimeout(timer);
      resolve(result);
    } catch (err) {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
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
   * same agent's own precedence rules — currently only Codex's
   * AGENTS.override.md over AGENTS.md. Cross-agent sharing of the same
   * underlying file (opencode and Codex both read a project's plain
   * AGENTS.md) is not modeled as shadowing: opencode has no override
   * concept of its own, so the same file is simply "active" from
   * opencode's perspective and independently "active"/"shadowed" from
   * Codex's — two separate targets, occasionally the same absolutePath. */
  shadowedBy?: string;
}

/** Global targets are a function of environment (CODEX_HOME, HOME), not a
 * static path — resolved lazily, once per listing, rather than baked into
 * TARGET_DEFS. */
function globalDir(agent: AgentRuleAgent): string {
  switch (agent) {
    case "claude-code":
      return path.join(os.homedir(), ".claude");
    case "codex":
      return resolveCodexHome();
    case "opencode":
      return path.join(expandHome("~/.config/opencode"));
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
const TARGET_DEFS: TargetDef[] = [
  {
    id: "claude-code:project",
    agent: "claude-code",
    agentLabel: AGENT_LABEL["claude-code"],
    scope: "project",
    fileName: "CLAUDE.md",
  },
  {
    id: "claude-code:global",
    agent: "claude-code",
    agentLabel: AGENT_LABEL["claude-code"],
    scope: "global",
    fileName: "CLAUDE.md",
  },
  {
    id: "codex:project:override",
    agent: "codex",
    agentLabel: AGENT_LABEL.codex,
    scope: "project",
    fileName: "AGENTS.override.md",
  },
  {
    id: "codex:project",
    agent: "codex",
    agentLabel: AGENT_LABEL.codex,
    scope: "project",
    fileName: "AGENTS.md",
    shadowedBy: "codex:project:override",
  },
  {
    id: "codex:global:override",
    agent: "codex",
    agentLabel: AGENT_LABEL.codex,
    scope: "global",
    fileName: "AGENTS.override.md",
  },
  {
    id: "codex:global",
    agent: "codex",
    agentLabel: AGENT_LABEL.codex,
    scope: "global",
    fileName: "AGENTS.md",
    shadowedBy: "codex:global:override",
  },
  {
    id: "opencode:project",
    agent: "opencode",
    agentLabel: AGENT_LABEL.opencode,
    scope: "project",
    fileName: "AGENTS.md",
  },
  {
    id: "opencode:project:claude",
    agent: "opencode",
    agentLabel: AGENT_LABEL.opencode,
    scope: "project",
    fileName: "CLAUDE.md",
  },
  {
    id: "opencode:global",
    agent: "opencode",
    agentLabel: AGENT_LABEL.opencode,
    scope: "global",
    fileName: "AGENTS.md",
  },
  {
    id: "opencode:global:claude",
    agent: "opencode",
    agentLabel: AGENT_LABEL.opencode,
    scope: "global",
    fileName: "CLAUDE.md",
  },
  {
    id: "agy:project",
    agent: "agy",
    agentLabel: AGENT_LABEL.agy,
    scope: "project",
    fileName: "GEMINI.md",
  },
  {
    id: "agy:global",
    agent: "agy",
    agentLabel: AGENT_LABEL.agy,
    scope: "global",
    fileName: "GEMINI.md",
  },
];

const TARGET_BY_ID = new Map(TARGET_DEFS.map((t) => [t.id, t]));

function resolveTargetDir(def: TargetDef, projectCwd: string): string {
  return def.scope === "project" ? projectCwd : globalDir(def.agent);
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
 * picking project cwd via an already-trusted project id). */
export function resolveTarget(id: string): TargetDef | null {
  return TARGET_BY_ID.get(id) ?? null;
}

export function listTargetDefs(): ReadonlyArray<{
  id: string;
  agent: AgentRuleAgent;
  agentLabel: string;
  scope: AgentRuleScope;
  fileName: string;
}> {
  return TARGET_DEFS;
}

async function statTarget(
  def: TargetDef,
  projectCwd: string,
): Promise<{ absolutePath: string; exists: boolean; size: number | null; mtimeMs: number | null }> {
  const absolutePath = path.join(resolveTargetDir(def, projectCwd), def.fileName);
  return withReadDeadline(() => {
    if (!existsSync(absolutePath)) {
      return { absolutePath, exists: false, size: null, mtimeMs: null };
    }
    const stat = statSync(absolutePath);
    return { absolutePath, exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
  }, absolutePath);
}

/** Lists every allow-listed target for `projectCwd`, with content inlined
 * for whatever exists and fits under MAX_RULE_FILE_BYTES. Read failures
 * (permission denied, a timeout) reject with the underlying error — unlike
 * project-config.ts's own "never throw" contract, a caller here (the route
 * layer) needs to distinguish "no rule files configured" (durable, all
 * targets simply don't exist) from "couldn't read right now" (transient,
 * 503) rather than have both collapse into the same empty-looking result. */
// `projectCwd` is ignored for a `scope: "global"` def (resolveTargetDir
// only consults it for `scope: "project"`) — callers resolving a single
// global target (the standalone /api/agent-rules/global/:target routes,
// which have no project context at all) may pass any string here; the
// route layer never forwards an unvalidated one regardless, since it never
// reads this parameter for those targets.
async function resolveOneTarget(def: TargetDef, projectCwd: string): Promise<AgentRuleTarget> {
  const resolved = path.resolve(projectCwd || "/");
  const stat = await statTarget(def, resolved);
  let content: string | null = null;
  let truncated = false;
  if (stat.exists && stat.size !== null) {
    if (stat.size > MAX_RULE_FILE_BYTES) {
      truncated = true;
    } else {
      content = await withReadDeadline(
        () => readFileSync(stat.absolutePath, "utf8"),
        stat.absolutePath,
      );
    }
  }
  const shadowingDef = def.shadowedBy ? TARGET_BY_ID.get(def.shadowedBy) : undefined;
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
  };
}

/** A single target's info+content — used by the standalone global routes
 * (`/api/agent-rules/global/:target`), which have no project context. */
export function getAgentRule(def: TargetDef, projectCwd: string = "/"): Promise<AgentRuleTarget> {
  return resolveOneTarget(def, projectCwd);
}

export async function listAgentRules(projectCwd: string): Promise<AgentRuleTarget[]> {
  const results: AgentRuleTarget[] = [];
  for (const def of TARGET_DEFS) {
    results.push(await resolveOneTarget(def, projectCwd));
  }
  return results;
}

export class AgentRuleTooLargeError extends Error {
  constructor(byteLength: number) {
    super(`Content is ${byteLength} bytes, exceeds the ${MAX_RULE_FILE_BYTES}-byte limit`);
    this.name = "AgentRuleTooLargeError";
  }
}

/** Writes `content` to `target`'s resolved path under `projectCwd`,
 * creating parent directories as needed (mirrors writeSessionAgentGuide's
 * own mkdirSync({recursive:true}) precedent for a per-target directory that
 * may not exist yet, e.g. a project with no `~/.config/opencode/` at all).
 * Throws on any failure — never logged-and-swallowed, unlike
 * project-config.ts's reads: a user actively editing a file needs to know
 * their save didn't take. */
export function writeAgentRule(target: TargetDef, projectCwd: string, content: string): void {
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > MAX_RULE_FILE_BYTES) throw new AgentRuleTooLargeError(byteLength);
  const dir = resolveTargetDir(target, path.resolve(projectCwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, target.fileName), content, "utf8");
}

/** Removes target's file under `projectCwd` if present; a no-op (not an
 * error) if it was already gone — the caller's intent ("this file should
 * not exist") is already satisfied. */
export function deleteAgentRule(target: TargetDef, projectCwd: string): void {
  const absolutePath = path.join(
    resolveTargetDir(target, path.resolve(projectCwd)),
    target.fileName,
  );
  if (existsSync(absolutePath)) unlinkSync(absolutePath);
}

// The distinct project-scope filenames across every target — deliberately
// deduped (AGENTS.md is a separate target for both codex and opencode, but
// the same underlying file), since this is a presence check, not a per-agent
// listing. Global scope is intentionally excluded: a sidebar row is for one
// specific project, and a global file's presence says nothing about that
// project.
const PROJECT_SCOPE_FILE_NAMES = [
  ...new Set(TARGET_DEFS.filter((t) => t.scope === "project").map((t) => t.fileName)),
];

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
