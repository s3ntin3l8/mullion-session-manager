import type { FastifyInstance, FastifyReply } from "fastify";
import path from "node:path";
import { realpathSync } from "node:fs";
import { Readable } from "node:stream";
import { WebSocket as NodeWebSocket } from "ws";
import { pingDevServer } from "./projects.js";
import {
  listAgentRules,
  getAgentRule,
  writeAgentRule,
  deleteAgentRule,
  resolveTarget,
  listExistingProjectRuleFileNames,
  AgentRuleTooLargeError,
  AgentRuleSymlinkError,
  AgentRulesTimeoutError,
  isTransientReadError,
} from "../services/agent-rules.js";
import {
  listProjectSkills,
  toggleSkillEnabled,
  classifySkillToggleError,
  SkillsTimeoutError,
  isTransientReadError as isTransientSkillsReadError,
  type SkillAgent,
} from "../services/skills.js";
import {
  discoverCandidates,
  expandHome,
  parseProjectsRootsEnv,
  resolveProjectActions,
  resolveProjectDock,
} from "../services/project-config.js";
import {
  readDockConfig,
  writeDockConfig,
  validateDockConfig,
  DockConfigValidationError,
  DockConfigTooLargeError,
  DockConfigSymlinkError,
  isTransientReadError as isTransientDockConfigReadError,
} from "../services/dock-config.js";
import { parseGitRemote } from "../services/git-remote.js";
import { readGitBranch } from "../services/git-branch.js";
import { getGitStatus, isGitRepo } from "../services/git-status.js";
import { getDiffStats, getDefaultBaseRef, getFileDiff } from "../services/git-diff.js";
import {
  listBranches,
  listRemoteBranches,
  listWorktrees,
  resolveDefaultBaseRef,
  resolveCommitSha,
} from "../services/git-refs.js";
import {
  checkoutBranchWorktree,
  clearOrphanedTaskWorktree,
  createWorktree,
  listTaskWorktreeDirs,
  pruneWorktrees,
  pruneWorktreeMetadata,
  removeListedWorktree,
  removeWorktree,
  removeWorktreeIfClean,
  resumeTaskWorktree,
  syncWorktree,
} from "../services/git-worktree.js";
import { deleteBranch } from "../services/git-branch-delete.js";
import { runGitFetch } from "../services/git-fetch.js";
import { pushBranch } from "../services/git-push.js";
import { getCachedAgents } from "../services/agent-detect.js";
import { resolveGlobalPresets } from "./actions.js";
import { attachSocketToSession } from "./terminal.js";
import { attachLocalEventsSocket } from "./events.js";
import type { SessionInfo } from "../services/pty-manager.js";
import {
  MAX_UPLOAD_BYTES,
  extensionForMime,
  matchesMagicBytes,
  saveSessionUpload,
} from "../services/session-upload.js";
import { buildUpstreamRequestHeaders, relayFetchResponse } from "../services/http-proxy.js";
import { pipeWsFrames, toWsUrl } from "../services/ws-pipe.js";
import { timingSafeTokenMatch } from "../services/crypto-utils.js";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  NONCE_HEADER,
  NONCE_TTL_MS,
  buildCanonicalString,
  hashBody,
  isTimestampFresh,
  isUnsignedBodyPath,
  verify,
} from "../services/request-signature.js";
import { appVersion } from "./server-info.js";
import type { AgentConfig } from "../services/remote-host-client.js";
import type { PromoteDecision } from "../plugins/hooks.js";
import type { Page } from "playwright";
import {
  executeBrowserAction,
  executeBrowserFind,
  resolveSearchRoot,
  agentActionSchema,
  findElementsSchema,
} from "./browser-automation.js";
import type { AgentAction, FindElementsBody } from "./browser-automation.js";
import { attachSocketToBrowser } from "./browser.js";
import { adapterHasInitialPromptArgs } from "../services/hook-adapters/index.js";

interface SpawnSessionBody {
  id: string;
  cwd: string;
  command: string;
  cols: number;
  rows: number;
  skipPermissions?: boolean;
  initialPrompt?: string;
  projectId?: number;
}

interface LiveStatusBody {
  ids: string[];
  idleThresholdMs: number;
  sessionProjectIds?: Record<string, number>;
}

interface LivenessBody {
  ids: string[];
}

// A session id is always the primary's stringified integer row id
// (String(sessionId) — see terminal.ts/sessions.ts) by construction, but
// this schema is the agent's only defense against a malformed one: it flows
// straight into pty-manager.ts's scopeUnitName(id) -> `crs-session-<id>`,
// naming a real systemd --user scope and dtach socket file. An id with
// systemd- or filesystem-illegal characters (e.g. "/") wouldn't be an
// injection (spawn/stop always use an argv array, never a shell string),
// but would make bootstrap/terminate silently target the wrong unit/file.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const SESSION_ID_SCHEMA = {
  type: "string",
  minLength: 1,
  pattern: SESSION_ID_PATTERN.source,
} as const;

const spawnSessionSchema = {
  body: {
    type: "object",
    required: ["id", "cwd", "command", "cols", "rows"],
    additionalProperties: false,
    properties: {
      id: SESSION_ID_SCHEMA,
      cwd: { type: "string", minLength: 1 },
      command: { type: "string", minLength: 1 },
      cols: { type: "integer", minimum: 1 },
      rows: { type: "integer", minimum: 1 },
      skipPermissions: { type: "boolean" },
      // Task Master's initial-turn prompt — no maxLength, same posture as
      // the existing `seed` field's own schema comment a few hundred lines
      // down (worktree create's promote flow): an issue body/task spec can
      // legitimately run long.
      initialPrompt: { type: "string" },
      projectId: { type: "integer" },
    },
  },
};

const liveStatusSchema = {
  body: {
    type: "object",
    required: ["ids", "idleThresholdMs"],
    additionalProperties: false,
    properties: {
      ids: { type: "array", items: SESSION_ID_SCHEMA },
      idleThresholdMs: { type: "integer", minimum: 0 },
      sessionProjectIds: {
        type: "object",
        additionalProperties: { type: "integer" },
      },
    },
  },
};

const livenessSchema = {
  body: {
    type: "object",
    required: ["ids"],
    additionalProperties: false,
    properties: {
      ids: { type: "array", items: SESSION_ID_SCHEMA },
    },
  },
};

const terminateSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: {
      id: SESSION_ID_SCHEMA,
    },
  },
};

interface ReviewGateBody {
  decision: "approved" | "denied";
  reason?: string;
}

// Issue #178 — the agent-side counterpart of POST /api/sessions/:id/review-gate.
const reviewGateSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: {
      id: SESSION_ID_SCHEMA,
    },
  },
  body: {
    type: "object",
    required: ["decision"],
    additionalProperties: false,
    properties: {
      decision: { type: "string", enum: ["approved", "denied"] },
      reason: { type: "string" },
    },
  },
};

interface GitWorktreeCreateBody {
  cwd: string;
  baseRef: string;
  seed: string;
  branchName?: string;
}

// Issue #271 — the agent-side counterpart of the primary's worktree-creation
// flows (launcher toggle, promote). No maxLength on seed/branchName: both
// pass through git-worktree.ts's own sanitizeRefComponent, which truncates
// and collapses unsafe characters regardless of input length before either
// ever reaches a `git` argv.
const gitWorktreeCreateSchema = {
  body: {
    type: "object",
    required: ["cwd", "baseRef", "seed"],
    additionalProperties: false,
    properties: {
      cwd: { type: "string", minLength: 1 },
      baseRef: { type: "string", minLength: 1 },
      seed: { type: "string", minLength: 1 },
      branchName: { type: "string" },
    },
  },
};

interface GitWorktreeRemoveBody {
  worktreePath: string;
  parentCwd?: string;
}

// Issue #283 — the agent-side counterpart of removeWorktreeIfClean, for a
// remote-hosted task's cleanup-on-done/failed step.
const gitWorktreeRemoveSchema = {
  body: {
    type: "object",
    required: ["worktreePath"],
    additionalProperties: false,
    properties: {
      worktreePath: { type: "string", minLength: 1 },
      parentCwd: { type: "string" },
    },
  },
};

interface GitWorktreeCheckoutBody {
  cwd: string;
  branch: string;
}

// Issue #345 — the agent-side counterpart of checkoutBranchWorktree, for a
// remote-hosted project's dock-preview flow (an EXISTING branch, detached
// HEAD — distinct from gitWorktreeCreateSchema above, which creates a new
// branch from a baseRef).
const gitWorktreeCheckoutSchema = {
  body: {
    type: "object",
    required: ["cwd", "branch"],
    additionalProperties: false,
    properties: {
      cwd: { type: "string", minLength: 1 },
      branch: { type: "string", minLength: 1 },
    },
  },
};

interface GitWorktreeForceRemoveBody {
  worktreePath: string;
  parentCwd?: string;
}

// Issue #345 — the agent-side counterpart of removeWorktree (--force,
// unlike gitWorktreeRemoveSchema above which is the never-force
// removeWorktreeIfClean). A dock-preview worktree running an HMR dev server
// is almost always dirty, so the safe path can't be reused here.
const gitWorktreeForceRemoveSchema = {
  body: {
    type: "object",
    required: ["worktreePath"],
    additionalProperties: false,
    properties: {
      worktreePath: { type: "string", minLength: 1 },
      parentCwd: { type: "string" },
    },
  },
};

interface GitWorktreeSyncBody {
  worktreePath: string;
  branch: string;
}

// Issue #345 — the agent-side counterpart of syncWorktree (the
// worktreeRefresh live-sync tick's `git reset --hard`), for a remote-hosted
// project's dock-preview worktree.
const gitWorktreeSyncSchema = {
  body: {
    type: "object",
    required: ["worktreePath", "branch"],
    additionalProperties: false,
    properties: {
      worktreePath: { type: "string", minLength: 1 },
      branch: { type: "string", minLength: 1 },
    },
  },
};

interface GitWorktreeClearOrphanBody {
  cwd: string;
  worktreePath: string;
  branchName: string;
}

// Issue #283 — the agent-side counterpart of clearOrphanedTaskWorktree,
// task-claim.ts's pre-claim step. `branchName` is required (unlike the
// create route's optional one) — this route always deletes it when a
// removal succeeds, so an absent value would silently no-op the half of
// this route that actually matters for the retry-collision it exists to fix.
const gitWorktreeClearOrphanSchema = {
  body: {
    type: "object",
    required: ["cwd", "worktreePath", "branchName"],
    additionalProperties: false,
    properties: {
      cwd: { type: "string", minLength: 1 },
      worktreePath: { type: "string", minLength: 1 },
      branchName: { type: "string", minLength: 1 },
    },
  },
};

interface GitWorktreePruneBody {
  cwd: string;
  orphanPaths: string[];
}

// Issue #283 — the agent-side counterpart of pruneWorktrees. `orphanPaths`
// is capped at 200 — the same "bound it, don't silently truncate the
// caller's intent" posture as MAX_READBACK_CHECKS_PER_SWEEP elsewhere in
// this phase; a project with more orphans than that in one sweep is
// unusual enough to warrant investigation, not a bigger cap.
const gitWorktreePruneSchema = {
  body: {
    type: "object",
    required: ["cwd", "orphanPaths"],
    additionalProperties: false,
    properties: {
      cwd: { type: "string", minLength: 1 },
      orphanPaths: {
        type: "array",
        items: { type: "string", minLength: 1 },
        maxItems: 200,
      },
    },
  },
};

interface GitBranchDeleteBody {
  cwd: string;
  name: string;
  force?: boolean;
}

// Issue #442 — the agent-side counterpart of deleteBranch, for a
// remote-hosted project's GitPanel manual branch-management UI.
const gitBranchDeleteSchema = {
  body: {
    type: "object",
    required: ["cwd", "name"],
    additionalProperties: false,
    properties: {
      cwd: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
      force: { type: "boolean" },
    },
  },
};

interface GitWorktreeRemoveListedBody {
  cwd: string;
  worktreePath: string;
  force?: boolean;
}

// Issue #442 — the agent-side counterpart of removeListedWorktree: unlike
// /internal/git-worktree/remove above, not scoped to task worktrees — the
// validity gate is membership in this agent's own `git worktree list`.
const gitWorktreeRemoveListedSchema = {
  body: {
    type: "object",
    required: ["cwd", "worktreePath"],
    additionalProperties: false,
    properties: {
      cwd: { type: "string", minLength: 1 },
      worktreePath: { type: "string", minLength: 1 },
      force: { type: "boolean" },
    },
  },
};

interface GitWorktreePruneMetadataBody {
  cwd: string;
}

// Issue #442 — the agent-side counterpart of pruneWorktreeMetadata (`git
// worktree prune`, not pruneWorktrees' task-worktree sweeper above).
const gitWorktreePruneMetadataSchema = {
  body: {
    type: "object",
    required: ["cwd"],
    additionalProperties: false,
    properties: {
      cwd: { type: "string", minLength: 1 },
    },
  },
};

interface GitPushBody {
  cwd: string;
  branch: string;
  token: string;
}

// #484 — the agent-side counterpart of pushBranch, for a remote-hosted
// task's promotion. `token` is never logged (see the route's own comment)
// and is only ever echoed back redacted, via pushBranch's own redact().
const gitPushSchema = {
  body: {
    type: "object",
    required: ["cwd", "branch", "token"],
    additionalProperties: false,
    properties: {
      cwd: { type: "string", minLength: 1 },
      branch: { type: "string", minLength: 1 },
      token: { type: "string", minLength: 1 },
    },
  },
};

interface GitWorktreeResumeBody {
  cwd: string;
  branchName: string;
}

// #484 — the agent-side counterpart of resumeTaskWorktree, for Retry
// (#483) on a remote-hosted task.
const gitWorktreeResumeSchema = {
  body: {
    type: "object",
    required: ["cwd", "branchName"],
    additionalProperties: false,
    properties: {
      cwd: { type: "string", minLength: 1 },
      branchName: { type: "string", minLength: 1 },
    },
  },
};

type PromoteDecisionBody = PromoteDecision;

// Issue #271 — mirrors reviewGateSchema's shape for the accepted/declined
// union (see plugins/hooks.ts's PromoteDecision).
const promoteDecisionSchema = {
  type: "object",
  required: ["decision"],
  properties: {
    decision: { type: "string", enum: ["accepted", "declined"] },
    worktreePath: { type: "string" },
    newSessionId: { type: "integer" },
    reason: { type: "string" },
  },
} as const;

// Not a public rate limit exemption — a distinct, higher ceiling. A primary
// polling this agent's bulk live-status/liveness endpoints at the reconcile
// cadence (a follow-up PR) is legitimate, frequent traffic from a single
// caller, unlike the public-facing default (security.ts's RATE_LIMIT_MAX,
// tuned for a browser). Still bounded, since the token alone doesn't prove
// the caller is well-behaved.
const INTERNAL_RATE_LIMIT = { config: { rateLimit: { max: 1000, timeWindow: "1 minute" } } };

// Mirrors routes/dock-config.ts's own writeDockConfigSchema exactly —
// deliberately thin (see that file's own comment on why: Fastify's ajv
// defaults to `removeAdditional: true`, which SILENTLY STRIPS an unknown
// property under `additionalProperties: false` instead of rejecting it, so
// per-control shape validation is left entirely to validateDockConfig
// against the untouched raw array). Kept as a second literal copy rather
// than a shared export for the same reason agentRuleWriteBodySchema just
// below is its own copy rather than imported from routes/agent-rules.ts.
const writeDockConfigBodySchema = {
  body: {
    type: "object",
    required: ["controls"],
    additionalProperties: false,
    properties: {
      controls: { type: "array", items: { type: "object" } },
    },
  },
};

// Mirrors routes/agent-rules.ts's own writeRuleSchema — Hermes review, PR
// #458: this route had no body schema at all, so a missing/malformed
// `content` field threw a raw TypeError inside writeAgentRule (undefined
// isn't a string) instead of Fastify's usual 400.
const agentRuleWriteBodySchema = {
  body: {
    type: "object",
    required: ["content"],
    additionalProperties: false,
    properties: {
      content: { type: "string" },
    },
  },
};

// Mirrors routes/skills.ts's own toggleSkillSchema exactly — see that
// file's header for why this is body-only ({agent, name, enabled}), no
// path params.
const toggleSkillBodySchema = {
  body: {
    type: "object",
    required: ["agent", "name", "enabled"],
    additionalProperties: false,
    properties: {
      agent: { type: "string", enum: ["claude-code", "codex", "opencode", "agy"] },
      name: { type: "string", minLength: 1 },
      enabled: { type: "boolean" },
    },
  },
};

/**
 * A symlink-tolerant realpath: resolves every symlink in the deepest
 * EXISTING prefix of `absPath`, then appends whatever tail doesn't exist yet
 * unchanged (a nonexistent path component can't itself be a symlink, so
 * there's nothing left to resolve once the walk hits one). Node's own
 * fs.realpathSync throws ENOENT the instant any component is missing, which
 * doesn't work for resolveWithinRoots below — a project cwd or one of its
 * `.crs/`-relative sinks is frequently a path that doesn't exist yet (a
 * fresh project with no `.crs/dock.json` written, a PROJECTS_ROOTS entry
 * that hasn't been created on this particular agent host). Mirrors the tail
 * behavior of Python's `os.path.realpath(strict=False)`, applied one
 * component at a time so each step's containment check sees the FULLY
 * resolved parent, not a lexical guess (issue #604).
 *
 * Only ENOENT is treated as "doesn't exist yet, fall back to lexical" —
 * every other errno (EACCES, ELOOP on a symlink cycle, ENOTDIR, ...)
 * propagates instead (Hermes review, PR #612). The original catch-all here
 * would have silently reused the lexical fallback for those too, which is
 * wrong in a different way than the ENOENT case: those errors mean "this
 * component's real target is unknown or unreachable," not "there's nothing
 * here yet" — treating them the same could pass containment on a value that
 * was never actually verified, only guessed at. The caller
 * (resolveWithinRoots) turns any such throw into a clean 400 rather than
 * this silently returning something that happens to pass, or an uncaught
 * exception surfacing as a 500 at the sink.
 */
function realpathExistingPrefix(absPath: string): string {
  const root = path.parse(absPath).root;
  const segments = absPath.slice(root.length).split(path.sep).filter(Boolean);
  let real = root;
  for (let i = 0; i < segments.length; i++) {
    const candidate = path.join(real, segments[i]);
    try {
      real = realpathSync(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // candidate doesn't exist — every remaining segment is a path we'd be
      // creating, not one that could already be a pre-planted symlink, so
      // append the rest lexically and stop walking.
      return path.join(real, ...segments.slice(i));
    }
  }
  return real;
}

/**
 * Constrain a request-supplied cwd to this agent's own PROJECTS_ROOTS before
 * it reaches a filesystem read — the sole trust anchor a DB-less agent has,
 * and the same scope /internal/discover already surfaces. Returns the
 * resolved absolute path when `cwd` is one of (or a descendant of) a
 * configured root, else null. Without this, /internal/actions and
 * /internal/dock would read whatever `.crs/actions.json`/`.crs/dock.json`/
 * `package.json`/`.vscode/tasks.json` happens to exist at ANY path the
 * caller names — flagged by CodeQL as uncontrolled data in a path
 * expression (and, downstream, a log-injection sink in project-config.ts's
 * warn() calls) once these routes started passing a raw request query
 * param into project-config.ts's file reads.
 *
 * The containment check below compares REAL (symlink-resolved) paths, not
 * the lexical ones (issue #604) — a symlink planted inside a root (e.g. an
 * authenticated caller who already has filesystem access to a project
 * creating `<root>/escape -> /etc`, then naming `cwd=<root>/escape`) used to
 * pass the old lexical `startsWith` check and hand every downstream sink a
 * path that silently escaped the root the moment it followed that symlink.
 * The function still RETURNS the lexical `resolved` value on success, not
 * the real one — every existing call site expects (and several persist)
 * that exact value, and legitimate uses (a `PROJECTS_ROOTS` entry that's
 * itself a symlink to a bind mount, a project containing an intentional
 * symlink to shared assets) are unaffected either way, since ordinary fs
 * calls follow symlinks transparently regardless of which form of the path
 * they're given. This only closes the CHECK's blind spot, not what gets
 * returned.
 *
 * Deliberately NOT applied to /internal/sessions or /internal/ws/attach
 * (session spawn/attach) below: a session's cwd is the whole point of the
 * feature and, like the primary's own unrestricted POST /api/projects cwd,
 * isn't scoped to PROJECTS_ROOTS today — spawning a program is already
 * fully gated by the shared token, the same trust boundary a roots check
 * here wouldn't add anything to. This is a deliberate, narrower scope than
 * "every cwd-accepting route," not an oversight.
 */
function resolveWithinRoots(app: FastifyInstance, cwd: string): string | null {
  const resolved = path.resolve(expandHome(cwd));
  let realResolved: string;
  let roots: string[];
  try {
    realResolved = realpathExistingPrefix(resolved);
    roots = parseProjectsRootsEnv(app.config.PROJECTS_ROOTS).map((root) =>
      realpathExistingPrefix(path.resolve(root)),
    );
  } catch {
    // A non-ENOENT failure mid-walk (EACCES, ELOOP on a symlink cycle, ...)
    // means realpathExistingPrefix couldn't reliably determine the real
    // location of `cwd` or a configured root — fail closed the same as
    // "outside every root" (every call site already treats null as a clean
    // 400) rather than letting the exception surface as an uncaught 500 at
    // whatever sink calls in here (Hermes review, PR #612).
    return null;
  }
  const withinRoots = roots.some(
    (root) => realResolved === root || realResolved.startsWith(root + path.sep),
  );
  return withinRoots ? resolved : null;
}

/**
 * The call-site half of resolveWithinRoots: resolves `value` and, on
 * failure, sends the standard 400 ("<field> must be within this agent's
 * PROJECTS_ROOTS") and returns null — replacing the identical
 * `const resolvedX = resolveWithinRoots(...); if (!resolvedX) return
 * reply.badRequest(...);` block this file used to repeat at every one of
 * its ~37 call sites. The idiom at each call site becomes:
 * `const resolvedX = requireWithinRoots(app, reply, x, "x"); if (resolvedX
 * === null) return;` — the same early-return-after-sending-a-reply shape
 * already used elsewhere in this file (e.g. the mullionSignatureSecret
 * check above). `field` is required, not defaulted — every one of this
 * file's ~37 call sites passes it explicitly (Hermes review, PR #626), so a
 * default would only ever mask a call site that forgot to name its own
 * field, not save anyone real typing.
 */
function requireWithinRoots(
  app: FastifyInstance,
  reply: FastifyReply,
  value: string,
  field: string,
): string | null {
  const resolved = resolveWithinRoots(app, value);
  if (!resolved) {
    reply.badRequest(`${field} must be within this agent's PROJECTS_ROOTS`);
    return null;
  }
  return resolved;
}

/**
 * requireWithinRoots for an array of paths — used by
 * /internal/git-worktree/prune's orphanPaths loop. Stops at the FIRST
 * entry outside PROJECTS_ROOTS, same as the loop it replaces: the rest of
 * `values` is never resolved once one entry fails.
 */
function requireAllWithinRoots(
  app: FastifyInstance,
  reply: FastifyReply,
  values: string[],
  field: string,
): string[] | null {
  const resolved: string[] = [];
  for (const value of values) {
    const resolvedValue = resolveWithinRoots(app, value);
    if (!resolvedValue) {
      reply.badRequest(`${field} entry must be within this agent's PROJECTS_ROOTS: ${value}`);
      return null;
    }
    resolved.push(resolvedValue);
  }
  return resolved;
}

// Same shape as projects.ts's DEV_SERVER_PORT_ONLY — a bare 1-65535 port,
// nothing else. Used for both /internal/preview/:port/* and
// /internal/ws/preview's ?port= (issue #28 phase 6).
const PORT_PATTERN = /^\d{1,5}$/;

// A generous, explicit cap for a proxied request body — self-documenting
// more than load-bearing: Fastify's own bodyLimit check compares against
// "content-length", and the primary's own hop (preview-proxy.ts) always
// strips that header (see http-proxy.ts's HOP_BY_HOP_REQUEST_HEADERS) before
// forwarding here, so this route always sees chunked framing and Fastify's
// check never actually fires. A true cap would need to count bytes as the
// stream is piped through — left as a known gap, not attempted here.
const MAX_PREVIEW_BODY_BYTES = 50 * 1024 * 1024;

function parsePort(value: string): number | null {
  if (!PORT_PATTERN.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * Resolves a caller-supplied path+query (from the primary, ultimately
 * derived from a browser's preview request) against this agent's own
 * loopback dev server at `port` — and never anything else. This is the
 * whole security promise of this phase (see projects.ts's own
 * isValidDevServerUrl comment: "the preview proxy forces the connection to
 * the owning agent's own loopback"), so it's deliberately not just "parse
 * and trust": naively string-concatenating `pathAndQuery` into
 * `http://127.0.0.1:${port}${pathAndQuery}` (or its ws:// equivalent) is
 * bypassable — a network-path reference ("//evil.com/x") overrides the
 * host entirely, and a leading "@evil.com/" turns "127.0.0.1:<port>" into
 * HTTP userinfo with "evil.com" as the actual host — both confirmed via
 * `new URL()` directly, not just reasoned about. The fix: `pathAndQuery` is
 * first parsed *alone*, against a throwaway placeholder base, so any
 * authority-like syntax it contains resolves into that placeholder's own
 * host/userinfo — which is then thrown away, keeping only `.pathname` and
 * `.search`. Only those two — guaranteed to start with "/" or be empty,
 * never authority syntax — are then combined with the real,
 * literally-constructed loopback base. The `hostname`/`port` assertion
 * below is redundant with that construction by design; it's still worth
 * asserting outright rather than trusting reasoning about which forms of
 * `pathAndQuery` are safe (see internal.test.ts's adversarial cases for
 * both).
 */
function resolveLoopbackPreviewUrl(pathAndQuery: string, port: number): URL | null {
  // Both `new URL()` calls below can throw outright for a sufficiently
  // malformed `pathAndQuery` (confirmed: a bracketed-but-invalid literal
  // like "//[::a.b.c.d]/x" throws TypeError rather than just parsing into
  // something this function would otherwise reject) — every caller already
  // treats a null return as "reject with 400", so folding a parse failure
  // into that same null case (Hermes review, PR #48) keeps this function's
  // contract honest ("tells you whether the input is usable," not "usable
  // unless it happens to throw") without pushing a try/catch onto every
  // call site.
  try {
    const parsed = new URL(pathAndQuery, "http://internal-preview-placeholder/");
    const upstreamUrl = new URL(parsed.pathname + parsed.search, `http://127.0.0.1:${port}`);
    const resolvedPort = upstreamUrl.port === "" ? 80 : Number(upstreamUrl.port);
    if (upstreamUrl.hostname !== "127.0.0.1" || resolvedPort !== port) return null;
    return upstreamUrl;
  } catch {
    return null;
  }
}

/**
 * Issue #247 / roadmap 7.4 — the single source of truth for "this process's
 * own effective config," shared by GET /internal/config below (an agent
 * describing itself) and routes/hosts.ts's `local` special case (the
 * primary describing itself, since it never registers internalRoutes to
 * call on its own process — see src/app.ts's role branch). Independent
 * review, PR #527: without this shared function, the two call sites
 * duplicated the same six-field object literal by hand, with nothing
 * forcing them to stay in sync if a field is ever added.
 */
export function buildAgentConfig(app: FastifyInstance): AgentConfig {
  return {
    role: app.config.MULLION_ROLE,
    version: appVersion,
    projectsRoots: parseProjectsRootsEnv(app.config.PROJECTS_ROOTS),
    sessionsDir: app.config.SESSIONS_DIR,
    crsConfigDir: app.config.CRS_CONFIG_DIR,
    browserEnabled: app.config.BROWSER_ENABLED,
  };
}

declare module "fastify" {
  interface FastifyRequest {
    // Issue #249 / roadmap 7.5 — see internalRoutes' own onRequest hook for
    // why this is frozen there rather than re-derived in preValidation.
    mullionSignatureSecret: string | null;
  }
}

/**
 * The token-gated API a DB-less "agent" role (issue #26) exposes to a
 * primary: project discovery, actions/dock resolution, agent detection, and
 * PTY spawn/attach/terminate/liveness — all scoped to this host's own
 * filesystem and app.pty, with no DB anywhere in this module. Only
 * registered when MULLION_ROLE=agent (see src/app.ts).
 */
export async function internalRoutes(app: FastifyInstance) {
  // Every route below — including the /internal/ws/attach WS upgrade, since
  // onRequest fires before that upgrade completes (the same guarantee
  // terminal.ts's own preValidation relies on for session-status gating) —
  // requires a bearer token. This hook is registered in this plugin's own
  // encapsulated context (not via fastify-plugin), so it stays scoped to
  // /internal/* and never leaks onto /health or anything else registered
  // outside this file.
  //
  // Issue #245 / roadmap 7.1 — additive dual-mode auth, the phase's hard
  // invariant: the original static MULLION_AGENT_TOKEN check (unchanged,
  // works exactly as it always has for a manually-registered host) OR a
  // match against this agent's own current registered session id
  // (app.agentSession, set by agent-enrollment.ts once registration
  // succeeds — undefined for a manual-token-only agent, so this branch is
  // simply never reachable there). Neither check alone becomes weaker; a
  // request just now has two possible ways to pass instead of one.
  // Issue #249 / roadmap 7.5 — per-request state threaded from onRequest to
  // the preValidation hook below. NOT re-derived there from app.agentSession
  // (the obvious-looking alternative): app.agentSession can rotate out from
  // under a single request between these two hooks (a renewal completing in
  // the async gap between them), and re-checking the bearer token against
  // whatever the row now holds could silently reclassify a request that WAS
  // session-matched (and therefore signature-required) in onRequest as
  // "static-Bearer, nothing to verify" in preValidation — skipping the
  // signature check entirely for a request that must have one. Freezing the
  // secret onRequest actually authorized against, once, is what closes that
  // race. null means "no signature required" (static-Bearer match, or no
  // match reached this point at all).
  app.decorateRequest("mullionSignatureSecret", null);

  // Issue #245 / roadmap 7.1 — additive dual-mode auth, the phase's hard
  // invariant: the original static MULLION_AGENT_TOKEN check (unchanged,
  // works exactly as it always has for a manually-registered host) OR a
  // match against this agent's own current registered session id
  // (app.agentSession, set by agent-enrollment.ts once registration
  // succeeds — undefined for a manual-token-only agent, so this branch is
  // simply never reachable there). Neither check alone becomes weaker; a
  // request just now has two possible ways to pass instead of one.
  app.addHook("onRequest", async (request, reply) => {
    const header = request.headers.authorization;
    const provided = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const matchesStaticToken =
      app.config.MULLION_AGENT_TOKEN.trim() !== "" &&
      timingSafeTokenMatch(provided, app.config.MULLION_AGENT_TOKEN);
    // Hermes review, PR #528: the TTL must actually bound a leaked session
    // credential on THIS (accepting) side too, not just on the issuing
    // side (resolveCurrentCredentials/rotateSession already check it). Without
    // this, a primary that's down or unreachable — exactly the scenario
    // agent-enrollment.ts's renewal-retry loop exists for — would leave a
    // stale, past-TTL session id accepted here indefinitely, since nothing
    // clears app.agentSession just because time passed.
    const matchesSession =
      app.agentSession !== undefined &&
      app.agentSession.expiresAt.getTime() > Date.now() &&
      timingSafeTokenMatch(provided, app.agentSession.sessionId);
    if (!matchesStaticToken && !matchesSession) {
      return reply.unauthorized("invalid or missing agent token");
    }

    // Issue #249 / roadmap 7.5 — a session-authenticated request MUST also
    // carry a valid signature; a manually-registered static-Bearer request
    // never needs one — today's flow, byte-for-byte unchanged. Gated on
    // WHICH credential matched, never on whether signature headers merely
    // happen to be present: presence-driven would let a leaked session id,
    // replayed WITHOUT signature headers, silently fall through to the
    // weaker static-token path instead of being rejected outright.
    if (!matchesSession) return;

    const sigHeader = request.headers[SIGNATURE_HEADER];
    const tsHeader = request.headers[TIMESTAMP_HEADER];
    const nonceHeader = request.headers[NONCE_HEADER];
    if (
      typeof sigHeader !== "string" ||
      typeof tsHeader !== "string" ||
      typeof nonceHeader !== "string"
    ) {
      return reply.unauthorized("signed request required");
    }
    if (!isTimestampFresh(tsHeader)) {
      // Logged distinguishably from a rejected/forged signature (see the
      // preValidation hook below) — an agent whose clock simply isn't
      // NTP-synced is the single most likely field failure of this
      // feature, and it must not read identically to an actual attack in
      // the logs.
      app.log.warn(
        { tsHeader, now: Date.now() },
        "[request-signature] rejected: timestamp outside the drift window (clock drift, or a stale/forged request)",
      );
      return reply.unauthorized("stale or invalid timestamp");
    }
    // Recorded here, not deferred to preValidation: a request that fails
    // the signature check below still burns its nonce (nonce-store.ts's
    // own doc comment explains why), and the timestamp/nonce checks don't
    // need the request body, so there's no reason to delay them.
    if (!app.requestNonceStore?.checkAndRecord(nonceHeader, NONCE_TTL_MS)) {
      return reply.unauthorized("replayed request");
    }

    // Freeze the secret this request was actually authorized against — see
    // the decorateRequest comment above.
    request.mullionSignatureSecret = app.agentSession!.sessionSecret;
  });

  // Issue #249 / roadmap 7.5 — the body-hash half of signature
  // verification. Deferred to preValidation because request.body isn't
  // parsed yet at onRequest time (see the phase plan's D3 design notes);
  // registered globally here (not per-route) so it covers every /internal/*
  // route uniformly, the same encapsulation-inheritance reasoning the
  // top-of-file comment gives for the onRequest hook above — including the
  // WS-upgrade routes below, each of which already relies on ITS OWN
  // route-level preValidation running before the upgrade completes.
  // Global hooks registered via app.addHook always run before a route's own
  // preValidation option, so this is guaranteed to reject a bad signature
  // before any of those routes' own checks (or their handlers) ever run.
  //
  // CodeQL (js/missing-rate-limiting) flags this hook itself as "performs
  // authorization but isn't rate-limited" — a false positive from its
  // dataflow analysis not tracing across the hook/route boundary: every
  // route this hook actually protects already carries its own
  // `config: { rateLimit: ... }` (INTERNAL_RATE_LIMIT below, or a tighter
  // one), same as every other authorization check in this file; a Fastify
  // hook registered via app.addHook has no route config of its own to
  // attach one to, and duplicating this check into all ~40 routes instead
  // of one shared hook would be strictly worse. Dismissed as a false
  // positive (not suppressed) — see the PR.
  app.addHook("preValidation", async (request, reply) => {
    // Two DIFFERENT null-ish states here, deliberately not collapsed into
    // one `== null` check (Hermes review, PR #531, and a mistake caught by
    // this file's own test for it): `null` is the documented sentinel for
    // "no session matched, static-Bearer path, no signature needed" — a
    // legitimate skip. `undefined` means a session DID match but its
    // sessionSecret was missing/malformed (AgentSession.sessionSecret is
    // typed string, never optional, but a primary predating #528 could
    // still send a register response with no session_secret field at all)
    // — treating that the same as `null` would SKIP verification entirely
    // for a session-authenticated request, a real bypass; treating it as
    // "verify anyway" would throw inside crypto.createHmac (a 500). Neither
    // is right — this must fail closed with the same clean 401 every other
    // rejection reason in this hook gives.
    if (request.mullionSignatureSecret === null) return; // static-Bearer path.
    if (request.mullionSignatureSecret === undefined) {
      // Hermes review, PR #531: a distinct message from the "signed request
      // required" one below — THIS request was in fact properly signed;
      // the problem is server-side (this agent's own registered session
      // has no usable secret), not a client omission. Conflating the two
      // would mislead debugging on the one side that can't see why.
      return reply.unauthorized("invalid session credential");
    }

    // onRequest already required these to be present for a session-matched
    // request (and rejected otherwise) — re-checked here only to satisfy
    // the type checker on request.headers' loose typing, not because this
    // is expected to actually fail.
    const sigHeader = request.headers[SIGNATURE_HEADER];
    const tsHeader = request.headers[TIMESTAMP_HEADER];
    const nonceHeader = request.headers[NONCE_HEADER];
    if (
      typeof sigHeader !== "string" ||
      typeof tsHeader !== "string" ||
      typeof nonceHeader !== "string"
    ) {
      return reply.unauthorized("signed request required");
    }

    // Same path both sides independently check against the SAME shared
    // allowlist (request-signature.ts) — see that module's own comment on
    // why bodyHashed is never itself transmitted.
    //
    // Hermes review, PR #531 — the invariant this body-hash comparison
    // actually depends on: JSON.stringify(request.body) here must
    // byte-match what the client hashed, which was JSON.stringify() of the
    // SAME plain object it then sent as this request's body
    // (remote-host-client.ts's ~35 request()-based call sites all build
    // their body this way; see also routes/webhooks.ts's own identical
    // re-stringify-to-verify shape for GitHub's webhook signatures). This
    // holds for the flat, string/number-keyed JSON bodies every current
    // /internal/* route actually receives, but isn't guaranteed in
    // general — a raw non-JSON string body, or a body containing an
    // integer key/value at the edge of what JSON round-trips exactly,
    // could byte-diverge on reserialization and fail signature
    // verification even though the client signed the truth. Fails CLOSED
    // (401) if that ever happens, never open — but a future route with a
    // body shape outside "flat object, JSON.stringify both ends" should
    // route through bodyHashed: false (request-signature.ts's allowlist)
    // instead of assuming this holds.
    const bodyHashed = !isUnsignedBodyPath(request.url);
    const bodyString = bodyHashed
      ? request.body === undefined
        ? ""
        : JSON.stringify(request.body)
      : "";
    const canonicalString = buildCanonicalString({
      method: request.method,
      requestTarget: request.url,
      timestamp: tsHeader,
      nonce: nonceHeader,
      bodyHashed,
      bodyHash: bodyHashed ? hashBody(bodyString) : "",
    });
    if (!verify(request.mullionSignatureSecret, canonicalString, sigHeader)) {
      return reply.unauthorized("invalid signature");
    }
  });

  // This agent's own PROJECTS_ROOTS, always read straight from env — unlike
  // the primary's resolveProjectRoots (routes/projects.ts), there's no
  // Settings override to check since an agent has no DB.
  app.get("/internal/discover", INTERNAL_RATE_LIMIT, async () => {
    return discoverCandidates(parseProjectsRootsEnv(app.config.PROJECTS_ROOTS));
  });

  // Issue #247 / roadmap 7.4 — per-agent effective-config visibility, pull-
  // based so it works identically against a manually-registered
  // (static-bearer) host and, once #245 lands, a self-registered one; no
  // new auth surface, just another route behind this file's existing
  // onRequest gate. Reads app.config only, deliberately never app.db — an
  // agent has none (src/app.ts's agent branch never registers dbPlugin),
  // which is exactly why five *other* routes in this file crash today when
  // reached on an agent role (see issue #522, filed separately). Session
  // idle-timeout is intentionally NOT included here: that's a DB-backed
  // Settings value (services/settings.ts's idleThresholdSeconds) with no
  // env-var equivalent, so an agent has no way to know it either.
  app.get("/internal/config", INTERNAL_RATE_LIMIT, async () => buildAgentConfig(app));

  // resolveGlobalPresets (actions.ts) reads app.config.CRS_CONFIG_DIR and
  // calls getCachedAgents() — both already mean "this host's own" on an
  // agent process, exactly the reason this can't be computed on the primary
  // side instead (a remote box can have a different set of installed CLIs
  // than the primary — see the design plan).
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/actions",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      const globalPresets = await resolveGlobalPresets(app);
      return resolveProjectActions(resolvedCwd, globalPresets);
    },
  );

  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/dock",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return resolveProjectDock(resolvedCwd, app.config.CRS_CONFIG_DIR);
    },
  );

  // U4 — the agent-side half of the dock-config write triple
  // (routes/dock-config.ts is the primary side, remote-host-client.ts the
  // client that calls here). Same resolveWithinRoots containment as
  // /internal/dock above — required here too since `cwd` arrives as a
  // caller-supplied query param over the wire, unlike the primary's own
  // routes, which can trust project.cwd straight from the DB (see
  // dock-config.ts's own resolveDockConfigPath comment on why it still
  // re-checks anyway).
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/dock-config",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      try {
        return readDockConfig(resolvedCwd);
      } catch (err) {
        // Same "unreachable via any current call site, kept as a guard
        // against a future one" reasoning as routes/dock-config.ts's own
        // GET — resolvedCwd is already path.resolve()d by
        // resolveWithinRoots above.
        if (err instanceof DockConfigValidationError) return reply.badRequest(err.message);
        if (isTransientDockConfigReadError(err)) {
          return reply.serviceUnavailable("Permission denied reading dock.json");
        }
        throw err;
      }
    },
  );

  app.put<{ Querystring: { cwd?: string }; Body: { controls: unknown[] } }>(
    "/internal/dock-config",
    { ...INTERNAL_RATE_LIMIT, schema: writeDockConfigBodySchema },
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      let controls;
      try {
        controls = validateDockConfig({ controls: request.body.controls });
      } catch (err) {
        if (err instanceof DockConfigValidationError) return reply.badRequest(err.message);
        throw err;
      }
      try {
        writeDockConfig(resolvedCwd, controls);
        return readDockConfig(resolvedCwd);
      } catch (err) {
        if (err instanceof DockConfigTooLargeError) return reply.badRequest(err.message);
        if (err instanceof DockConfigSymlinkError) return reply.badRequest(err.message);
        if (err instanceof DockConfigValidationError) return reply.badRequest(err.message);
        if (isTransientDockConfigReadError(err)) {
          return reply.serviceUnavailable("Permission denied writing dock.json");
        }
        throw err;
      }
    },
  );

  // Issue #431 — the agent-side half of the project-scoped agent-rules
  // triple (routes/agent-rules.ts is the primary side, remote-host-client.ts
  // the client that calls here). `cwd` goes through the exact same
  // resolveWithinRoots containment as /internal/actions and /internal/dock
  // above — required and validated on every request here for consistency
  // with those routes, though it only actually GATES a project-scope
  // target's path (resolveTargetDir uses `projectCwd` for those). A
  // global-scope target resolves off THIS host's own env-derived dir
  // (globalDir(agent) — ~/.claude, $CODEX_HOME, etc.) regardless of `cwd`;
  // its safety comes from `target` never being a caller-supplied path —
  // resolveTarget() confines it to the fixed allow-list (see
  // agent-rules.ts), so there's nothing here for a
  // traversal attempt to reach beyond that enum.
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/agent-rules",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      try {
        return await listAgentRules(resolvedCwd);
      } catch (err) {
        if (err instanceof AgentRulesTimeoutError) {
          return reply.serviceUnavailable("Timed out reading agent rule files");
        }
        if (isTransientReadError(err)) {
          return reply.serviceUnavailable("Permission denied reading agent rule files");
        }
        throw err;
      }
    },
  );

  app.put<{ Params: { target: string }; Querystring: { cwd?: string }; Body: { content: string } }>(
    "/internal/agent-rules/:target",
    { ...INTERNAL_RATE_LIMIT, schema: agentRuleWriteBodySchema },
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      const target = resolveTarget(request.params.target);
      if (!target) return reply.badRequest("Unknown agent-rules target");
      try {
        writeAgentRule(target, resolvedCwd, request.body.content);
        return await getAgentRule(target, resolvedCwd);
      } catch (err) {
        if (err instanceof AgentRuleTooLargeError) return reply.badRequest(err.message);
        if (err instanceof AgentRuleSymlinkError) return reply.badRequest(err.message);
        if (err instanceof AgentRulesTimeoutError) {
          return reply.serviceUnavailable("Timed out reading agent rule file");
        }
        // Independent review, PR #458 — same EACCES-to-503 gap as the
        // primary route's PUT: this had no such mapping at all before.
        if (isTransientReadError(err)) {
          return reply.serviceUnavailable("Permission denied accessing agent rule file");
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { target: string }; Querystring: { cwd?: string } }>(
    "/internal/agent-rules/:target",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      const target = resolveTarget(request.params.target);
      if (!target) return reply.badRequest("Unknown agent-rules target");
      try {
        deleteAgentRule(target, resolvedCwd);
      } catch (err) {
        if (isTransientReadError(err)) {
          return reply.serviceUnavailable("Permission denied accessing agent rule file");
        }
        throw err;
      }
      reply.code(204);
    },
  );

  // Issue #431, Hermes review on PR #458 — a lightweight, names-only
  // counterpart to /internal/agent-rules above, for the sidebar's per-project
  // indicator (projects.ts's ruleFiles field) on a REMOTE-hosted project.
  // The full /internal/agent-rules round trip inlines content for all 12
  // targets (up to 512KB each) — fine for the actual editor panel, wasteful
  // for a presence-only badge that GET /api/projects recomputes on every
  // poll. Mirrors listExistingProjectRuleFileNames's own local-project path.
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/agent-rules/exists",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return listExistingProjectRuleFileNames(resolvedCwd);
    },
  );

  // Issue #432 — the agent-side half of the skills-discovery triple
  // (routes/skills.ts is the primary side, remote-host-client.ts the
  // client). Same resolveWithinRoots containment as /internal/agent-rules
  // above; skills.ts's own listProjectSkills combines this cwd's
  // project-scope dirs with THIS host's own global/builtin dirs.
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/skills",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      try {
        return await listProjectSkills(resolvedCwd);
      } catch (err) {
        if (err instanceof SkillsTimeoutError) {
          return reply.serviceUnavailable("Timed out reading skill directories");
        }
        if (isTransientSkillsReadError(err)) {
          return reply.serviceUnavailable("Permission denied reading skill directories");
        }
        throw err;
      }
    },
  );

  // Issue #463 — the agent-side half of the skills enable/disable triple;
  // see routes/skills.ts's own header for the {agent, name, enabled}
  // body-only contract. classifySkillToggleError (skills.ts) is the SAME
  // function the primary route uses, so a local write and a remote-hosted
  // write that hit the identical underlying failure produce the identical
  // status/message — forwardHostRequestError on the primary forwards this
  // response's body/status verbatim.
  app.put<{
    Querystring: { cwd?: string };
    Body: { agent: SkillAgent; name: string; enabled: boolean };
  }>(
    "/internal/skills",
    { ...INTERNAL_RATE_LIMIT, schema: toggleSkillBodySchema },
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      const { agent, name, enabled } = request.body;
      try {
        return await toggleSkillEnabled(resolvedCwd, agent, name, enabled);
      } catch (err) {
        const classified = classifySkillToggleError(err);
        if (classified)
          return reply.code(classified.statusCode).send({ message: classified.message });
        if (err instanceof SkillsTimeoutError) {
          return reply.serviceUnavailable("Timed out reading skill directories");
        }
        if (isTransientSkillsReadError(err)) {
          // Hermes review, PR #469, round 4 — this wraps toggleSkillEnabled,
          // which can fail on the writer's own openSync/writeFileSync, not
          // just discovery — "reading skill directories" would misdescribe
          // a write-permission failure.
          return reply.serviceUnavailable(
            "Permission denied reading or writing skill configuration",
          );
        }
        throw err;
      }
    },
  );

  app.get("/internal/agents", INTERNAL_RATE_LIMIT, async () => {
    return getCachedAgents();
  });

  // Owner/repo derivation for a remote-host project's GitHub widget (issue
  // #27) — a remote project's cwd is a path on *this* agent's filesystem,
  // so reading its .git/config has to happen here, not on the primary (same
  // reasoning as /internal/actions and /internal/dock above). The actual
  // GitHub API calls still happen on the primary, which is the only side
  // holding the credential (routes/projects.ts).
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/github-repo",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return parseGitRemote(resolvedCwd);
    },
  );

  // Always-on branch label (issue #96) for a remote-hosted project — same
  // "this reads *this* agent's own filesystem" reasoning as /internal/
  // github-repo above, just backed by git-branch.ts's pure HEAD read instead
  // of git-remote.ts's config parse. Unlike every other route in this file,
  // the payload is a bare string (or null), not an object/array — Fastify
  // only auto-JSON-encodes those; a returned string is sent as raw
  // text/plain by default. Explicit content-type + JSON.stringify keeps this
  // a well-formed `RemoteHostClient.request<T>()` response like every other
  // /internal/* route (see remote-host-client.ts's resolveGitBranch, which
  // expects to `res.json()` it straight into a `string | null`).
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/git-branch",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      reply.type("application/json");
      return JSON.stringify(readGitBranch(resolvedCwd));
    },
  );

  // Fuller git status (issue #76) — branch/hash/ahead-behind/file-list — for
  // a remote-hosted project's GitPanel and sidebar badge. Backed by
  // git-status.ts's `git status --porcelain=v2 --branch` shell-out, which
  // has to run on *this* agent's own filesystem for the same reason
  // /internal/github-repo and /internal/git-branch do.
  //
  // Returns `{ isRepo, status }` rather than bare `GitStatus | null` (as this
  // used to) so the primary's /api/projects/:id/git-status route can tell
  // "not a repo" (durable — `isRepo: false`) apart from "repo exists but git
  // status failed transiently" (`isRepo: true, status: null`) for a remote
  // host exactly the same way it already can for a local one via
  // `isGitRepo`/`getGitStatus`. Always 200 with a JSON body — this endpoint's
  // own transient git failures aren't the primary's "host unreachable" 5xx,
  // they're carried in the body instead, so RemoteHostClient's generic 5xx ->
  // HostUnreachableError handling doesn't swallow the distinction.
  // `?fresh=1` (#484) bypasses getGitStatus's own cache — task-promote.ts's
  // dirty-tree gate needs this the same way it already does for a local
  // promotion (see getGitStatus's own `forceFresh` doc comment): a stale
  // "clean" read served from up to CACHE_TTL_MS ago could let a push
  // silently exclude work an agent committed moments before approve ran.
  // Every other caller (the sidebar/GitPanel polls) omits it and keeps the
  // cached read.
  app.get<{ Querystring: { cwd?: string; fresh?: string } }>(
    "/internal/git-status",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd, fresh } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      if (!isGitRepo(resolvedCwd)) {
        return { isRepo: false, status: null };
      }
      const status = await getGitStatus(resolvedCwd, { forceFresh: fresh === "1" });
      return { isRepo: true, status };
    },
  );

  // Diff stats (issue #202) for a remote-hosted session's effective cwd —
  // same reasoning and `{ isRepo, stats }` shape as /internal/git-status
  // just above (git-diff.ts's `git diff [base]...HEAD --numstat` shell-out
  // has to run on *this* agent's own filesystem, and this route's own
  // transient git failures need to stay distinguishable from "host
  // unreachable" the same way).
  app.get<{ Querystring: { cwd?: string; base?: string } }>(
    "/internal/git-diff",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd, base } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      if (!isGitRepo(resolvedCwd)) {
        return { isRepo: false, stats: null };
      }
      const effectiveBase = base === "AUTO" ? (getDefaultBaseRef(resolvedCwd) ?? undefined) : base;
      const stats = await getDiffStats(resolvedCwd, effectiveBase);
      return { isRepo: true, stats };
    },
  );

  // Per-file unified diff (issue #262) for a remote-hosted session — runs
  // `git diff [base]...HEAD -- <path>` on this agent's own filesystem,
  // returning the raw unified diff text or null.
  app.get<{ Querystring: { cwd?: string; path?: string; base?: string } }>(
    "/internal/git-file-diff",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd, path: filePath, base } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      if (!filePath) return reply.badRequest("path query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      if (!isGitRepo(resolvedCwd)) return { patch: null };

      const resolvedPath = path.isAbsolute(filePath)
        ? path.relative(resolvedCwd, filePath)
        : filePath;
      if (resolvedPath.startsWith("..")) return { patch: null };

      const effectiveBase = base === "AUTO" ? (getDefaultBaseRef(resolvedCwd) ?? undefined) : base;
      const patch = await getFileDiff(resolvedCwd, resolvedPath, effectiveBase);
      return { patch };
    },
  );

  // Local branches + worktrees (issue #162) for a remote-hosted project's
  // GitPanel — same reasoning as /internal/git-status: git-refs.ts's
  // `for-each-ref`/`worktree list` shell-outs have to run on *this* agent's
  // own filesystem.
  app.get<{ Querystring: { cwd?: string; detail?: string } }>(
    "/internal/git-branches",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd, detail } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      const [branches, worktrees, remoteBranches] = await Promise.all([
        listBranches(resolvedCwd, { detail: detail === "1" }),
        listWorktrees(resolvedCwd),
        listRemoteBranches(resolvedCwd),
      ]);
      if (!branches || !worktrees || !remoteBranches) return null;
      return { branches, worktrees, remoteBranches };
    },
  );

  // Runs `git fetch origin` on the given cwd — for a remote-hosted project's
  // background auto-fetch (src/plugins/git-fetcher.ts) and manual Fetch
  // button (POST /api/projects/:id/git-fetch). Like every other filesystem-
  // touching route in this file, it goes through resolveWithinRoots. Returns
  // { success, error? } rather than throwing on git-level failures, so the
  // primary can distinguish "fetch ran and succeeded" from "fetch ran but
  // the remote was unreachable" from "host unreachable" (a 5xx from request()).
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/git-fetch",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return await runGitFetch(resolvedCwd);
    },
  );

  // #484 — resolves the repository's default base ref (and pins it to a
  // commit SHA) on THIS agent's own filesystem, for a remote-hosted task
  // claim/promotion. Wraps resolveDefaultBaseRef + resolveCommitSha
  // (git-refs.ts) — note resolveDefaultBaseRef runs `git fetch origin`
  // first, so this is not a free call. Mirrors that function's own
  // never-throws contract: a non-repo cwd resolves `{ baseRef: "HEAD", sha:
  // null }`, exactly the local last-resort fallback, not an error.
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/git-base-ref",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      const baseRef = await resolveDefaultBaseRef(resolvedCwd);
      const sha = await resolveCommitSha(resolvedCwd, baseRef);
      return { baseRef, sha };
    },
  );

  // #484 — pushes a task's branch to `origin` on THIS agent's own
  // filesystem, for a remote-hosted task's promotion. `cwd` is always the
  // task's worktree path (under `<project.cwd>/.mullion-worktrees/`, so
  // within PROJECTS_ROOTS the same way /internal/git-worktree/remove's
  // worktreePath already is), never the bare project root. The token
  // travels once, over this already-signed, IP-pinned internal channel —
  // never logged: git-push.ts's own redact() strips it from every returned
  // `detail` before this responds, and this route does not log its request
  // body. See git-push.ts's own header comment for the https-only
  // http.extraHeader caveat this doesn't change.
  app.post<{ Body: GitPushBody }>(
    "/internal/git-push",
    { ...INTERNAL_RATE_LIMIT, schema: gitPushSchema },
    async (request, reply) => {
      const { cwd, branch, token } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return await pushBranch(resolvedCwd, branch, token);
    },
  );

  // #484 — lists this agent's own on-disk task-worktree directories, for
  // the primary's boot-time orphan sweep (plugins/task-watcher.ts). Mirrors
  // listTaskWorktreeDirs's own pure-filesystem-read contract exactly — see
  // that function's own doc comment for why it returns `[]` rather than
  // throwing for a missing/unreadable `.mullion-worktrees` directory.
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/git-worktree/task-dirs",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return { dirs: listTaskWorktreeDirs(resolvedCwd) };
    },
  );

  // #484 — the agent-side counterpart of resumeTaskWorktree: checks out an
  // EXISTING `mullion/task-<id>` branch into a fresh worktree at its
  // deterministic path, on THIS agent's own filesystem, for Retry (#483) on
  // a remote-hosted task. Returns `null` (200, not an error status) when
  // the resume fails for a git-level reason (branch missing, or checked out
  // elsewhere) — same "not applicable, not unreachable" shape as
  // /internal/git-worktree above.
  app.post<{ Body: GitWorktreeResumeBody }>(
    "/internal/git-worktree/resume",
    { ...INTERNAL_RATE_LIMIT, schema: gitWorktreeResumeSchema },
    async (request, reply) => {
      const { cwd, branchName } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return await resumeTaskWorktree(resolvedCwd, branchName);
    },
  );

  // Issue #271 — creates a worktree on THIS agent's own filesystem, for a
  // remote-hosted project's launcher-toggle/promote flows. Same
  // resolveWithinRoots gate as every other filesystem-touching route in
  // this file; unlike those read-only routes, this one mutates (creates a
  // directory + a branch), so the gate matters even more here. Returns
  // `null` (200, not an error status) when creation fails for a git-level
  // reason (bad baseRef, not a repo) — same "not applicable, not
  // unreachable" shape as /internal/git-branches above, which
  // RemoteHostClient.request()'s HostUnreachableError/HostRequestError
  // handling would otherwise conflate with a genuine connectivity failure.
  app.post<{ Body: GitWorktreeCreateBody }>(
    "/internal/git-worktree",
    { ...INTERNAL_RATE_LIMIT, schema: gitWorktreeCreateSchema },
    async (request, reply) => {
      const { cwd, baseRef, seed, branchName } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return await createWorktree({ cwd: resolvedCwd, baseRef, seed, branchName });
    },
  );

  // Issue #283 — removes a task worktree on THIS agent's own filesystem,
  // only when clean (never `--force`; see removeWorktreeIfClean's own doc
  // comment). Both path fields go through resolveWithinRoots — parentCwd
  // is where `git worktree remove` actually runs, so it needs the same
  // containment as worktreePath itself.
  app.post<{ Body: GitWorktreeRemoveBody }>(
    "/internal/git-worktree/remove",
    { ...INTERNAL_RATE_LIMIT, schema: gitWorktreeRemoveSchema },
    async (request, reply) => {
      const { worktreePath, parentCwd } = request.body;
      const resolvedWorktreePath = requireWithinRoots(app, reply, worktreePath, "worktreePath");
      if (resolvedWorktreePath === null) return;
      let resolvedParentCwd: string | undefined;
      if (parentCwd) {
        const resolved = requireWithinRoots(app, reply, parentCwd, "parentCwd");
        if (resolved === null) return;
        resolvedParentCwd = resolved;
      }
      return await removeWorktreeIfClean(resolvedWorktreePath, resolvedParentCwd);
    },
  );

  // Issue #345 — checks out an EXISTING branch into a fresh detached-HEAD
  // worktree on THIS agent's own filesystem, for a remote-hosted project's
  // dock-preview flow. Distinct from /internal/git-worktree above (which
  // creates a NEW branch from a baseRef). Returns `null` (200) on a
  // git-level failure, same "not applicable, not unreachable" posture as
  // every other route in this file — see /internal/git-worktree's own
  // comment.
  app.post<{ Body: GitWorktreeCheckoutBody }>(
    "/internal/git-worktree/checkout",
    { ...INTERNAL_RATE_LIMIT, schema: gitWorktreeCheckoutSchema },
    async (request, reply) => {
      const { cwd, branch } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return await checkoutBranchWorktree(resolvedCwd, branch);
    },
  );

  // Issue #345 — force-removes a dock-preview worktree on THIS agent's own
  // filesystem (`git worktree remove --force`), for the primary's
  // killSession/reconciler/spawn-rollback cleanup paths. Unlike
  // /internal/git-worktree/remove above (removeWorktreeIfClean, never
  // force), a preview worktree running an HMR dev server is almost always
  // dirty, so the safe path can't be reused here — see removeWorktree's own
  // doc comment. Both path fields go through resolveWithinRoots
  // independently, same as /internal/git-worktree/remove.
  app.post<{ Body: GitWorktreeForceRemoveBody }>(
    "/internal/git-worktree/force-remove",
    { ...INTERNAL_RATE_LIMIT, schema: gitWorktreeForceRemoveSchema },
    async (request, reply) => {
      const { worktreePath, parentCwd } = request.body;
      const resolvedWorktreePath = requireWithinRoots(app, reply, worktreePath, "worktreePath");
      if (resolvedWorktreePath === null) return;
      let resolvedParentCwd: string | undefined;
      if (parentCwd) {
        const resolved = requireWithinRoots(app, reply, parentCwd, "parentCwd");
        if (resolved === null) return;
        resolvedParentCwd = resolved;
      }
      const removed = await removeWorktree(resolvedWorktreePath, resolvedParentCwd);
      return { removed };
    },
  );

  // Issue #345 — resets a dock-preview worktree on THIS agent's own
  // filesystem to the current tip of a LOCAL branch ref
  // (`git reset --hard`), for the primary's worktreeRefresh live-sync tick.
  // See syncWorktree's own doc comment for why this is safe only because
  // the worktree's HEAD is detached (checkoutBranchWorktree above).
  app.post<{ Body: GitWorktreeSyncBody }>(
    "/internal/git-worktree/sync",
    { ...INTERNAL_RATE_LIMIT, schema: gitWorktreeSyncSchema },
    async (request, reply) => {
      const { worktreePath, branch } = request.body;
      const resolvedWorktreePath = requireWithinRoots(app, reply, worktreePath, "worktreePath");
      if (resolvedWorktreePath === null) return;
      const synced = await syncWorktree(resolvedWorktreePath, branch);
      return { synced };
    },
  );

  // Issue #283 — task-claim.ts's pre-claim orphan clearing on THIS agent's
  // own filesystem: clears both the worktree directory and the branch ref
  // at task-claim.ts's deterministic mullion/task-<id> path/name. See
  // clearOrphanedTaskWorktree's own doc comment for why deleting the
  // branch here is safe, unlike /internal/git-worktree/remove above.
  app.post<{ Body: GitWorktreeClearOrphanBody }>(
    "/internal/git-worktree/clear-orphan",
    { ...INTERNAL_RATE_LIMIT, schema: gitWorktreeClearOrphanSchema },
    async (request, reply) => {
      const { cwd, worktreePath, branchName } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      const resolvedWorktreePath = requireWithinRoots(app, reply, worktreePath, "worktreePath");
      if (resolvedWorktreePath === null) return;
      return await clearOrphanedTaskWorktree(resolvedCwd, resolvedWorktreePath, branchName);
    },
  );

  // Issue #283 — removes the explicitly-named orphan task worktrees under
  // `cwd` on THIS agent's own filesystem. Every entry in `orphanPaths` goes
  // through resolveWithinRoots individually, same containment as `cwd`
  // itself — pruneWorktrees itself re-validates containment/naming again on
  // top of this (defense in depth), but a path that fails resolveWithinRoots
  // shouldn't even reach that function.
  app.post<{ Body: GitWorktreePruneBody }>(
    "/internal/git-worktree/prune",
    { ...INTERNAL_RATE_LIMIT, schema: gitWorktreePruneSchema },
    async (request, reply) => {
      const { cwd, orphanPaths } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      const resolvedOrphanPaths = requireAllWithinRoots(app, reply, orphanPaths, "orphanPaths");
      if (resolvedOrphanPaths === null) return;
      return await pruneWorktrees(resolvedCwd, resolvedOrphanPaths);
    },
  );

  // Issue #442 — deletes a local branch on THIS agent's own filesystem, for
  // a remote-hosted project's GitPanel manual branch-management UI. Always
  // 200 with a reason envelope, never a 5xx for a git-level refusal — see
  // deleteBranch's own DeleteBranchResult shape and the module-level
  // reasoning on every other route in this file that returns one.
  app.post<{ Body: GitBranchDeleteBody }>(
    "/internal/git-branch-delete",
    { ...INTERNAL_RATE_LIMIT, schema: gitBranchDeleteSchema },
    async (request, reply) => {
      const { cwd, name, force } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return await deleteBranch(resolvedCwd, name, { force });
    },
  );

  // Issue #442 — removes any worktree `git worktree list` itself reports on
  // THIS agent's own filesystem (not scoped to task worktrees, unlike
  // /internal/git-worktree/remove above) — see removeListedWorktree's own
  // doc comment for the force-path preview-registry fix it performs.
  app.post<{ Body: GitWorktreeRemoveListedBody }>(
    "/internal/git-worktree/remove-listed",
    { ...INTERNAL_RATE_LIMIT, schema: gitWorktreeRemoveListedSchema },
    async (request, reply) => {
      const { cwd, worktreePath, force } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      const resolvedWorktreePath = requireWithinRoots(app, reply, worktreePath, "worktreePath");
      if (resolvedWorktreePath === null) return;
      return await removeListedWorktree(resolvedCwd, resolvedWorktreePath, { force });
    },
  );

  // Issue #442 — clears stale worktree administrative metadata on THIS
  // agent's own filesystem (`git worktree prune`, not pruneWorktrees'
  // task-worktree sweeper above). Never removes a worktree still on disk.
  app.post<{ Body: GitWorktreePruneMetadataBody }>(
    "/internal/git-worktree/prune-metadata",
    { ...INTERNAL_RATE_LIMIT, schema: gitWorktreePruneMetadataSchema },
    async (request, reply) => {
      const { cwd } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return await pruneWorktreeMetadata(resolvedCwd);
    },
  );

  // Mirrors POST /api/sessions' "create the row and spawn immediately" — an
  // agent has no row to create, just the spawn half. Idempotent the same way
  // app.pty.getOrCreate always is: calling this again for an id already
  // tracked in this process's memory is a no-op beyond respawning a dead
  // attach-client, same as a fresh /internal/ws/attach would do.
  app.post<{ Body: SpawnSessionBody }>(
    "/internal/sessions",
    { ...INTERNAL_RATE_LIMIT, schema: spawnSessionSchema },
    async (request, reply) => {
      const { id, cwd, command, cols, rows, skipPermissions, initialPrompt, projectId } =
        request.body;
      app.pty.getOrCreate({
        id,
        cwd: expandHome(cwd),
        command,
        cols,
        rows,
        skipPermissions,
        initialPrompt,
        projectId,
      });
      reply.code(201);
      // Hermes review, PR #538 — an agent build too old to have this route's
      // `initialPrompt`/`skipPermissions` schema properties silently strips
      // them (Fastify's default `removeAdditional` behavior applies even
      // though this schema declares `additionalProperties: false`, verified
      // empirically), so the primary's own local computation of
      // "seedDelivered" can't be trusted for a remote spawn — the request
      // looked identical to the caller either way. `initialPromptApplied`
      // echoes back whether THIS agent build actually understood and used
      // an initial prompt for this exact command, computed fresh from the
      // real request rather than assumed. Its own ABSENCE on an old agent's
      // response (rather than `false`) is itself the version-skew signal:
      // an old build's route handler has no idea this field exists, so it
      // simply never appears — task-claim.ts's callers use that omission to
      // downgrade seedDelivered instead of trusting a local guess.
      return {
        ok: true,
        initialPromptApplied: initialPrompt !== undefined && adapterHasInitialPromptArgs(command),
      };
    },
  );

  // Bulk live status for a batch of ids — a primary polling this per-session
  // would be one HTTP round-trip per session on every list refresh; this is
  // the endpoint that makes a single-request-per-host list refresh possible
  // (see the design plan's "batched per-host live status"). idleThresholdMs
  // comes from the primary's own Settings -> Notifications & status (an
  // agent has no Settings to read it from itself). An id this process has
  // never tracked (never spawned/attached here, or spawned by a since-
  // restarted process) maps to null — same "no live signal yet" semantics
  // as routes/sessions.ts's withLiveStatus falls back to for app.pty.get
  // returning undefined.
  app.post<{ Body: LiveStatusBody }>(
    "/internal/sessions/live",
    { ...INTERNAL_RATE_LIMIT, schema: liveStatusSchema },
    async (request) => {
      const { ids, idleThresholdMs, sessionProjectIds } = request.body;
      // Use Map to store key-value pairs (prototype injection safe), then
      // convert to a null-prototype object using Object.fromEntries(..., null).
      // This satisfies the CodeQL remote property injection scanner while
      // ensuring serialized JSON keys have no inherited setters to hijack.
      const result = new Map<string, SessionInfo | null>();
      for (const id of ids) {
        const info = app.pty.get(id)?.toInfo(idleThresholdMs) ?? null;
        if (info && app.config.BROWSER_ENABLED && sessionProjectIds) {
          const projectId = sessionProjectIds[id];
          if (projectId !== undefined) {
            const managed = app.browser.get(projectId);
            if (managed && managed.browser.isConnected()) {
              try {
                info.browserUrl = managed.page.url();
              } catch {
                // Best-effort
              }
            }
          }
        }
        result.set(id, info);
      }
      const out = Object.create(null);
      for (const [k, v] of result.entries()) {
        out[k] = v;
      }
      return out;
    },
  );

  // Bulk systemd-scope liveness for the reconciler (a follow-up PR) — same
  // batching motivation as /internal/sessions/live above, but backed by
  // app.pty.isMasterAliveBatch's single `systemctl --user list-units` call
  // rather than in-memory state, so it's correct even for a session this
  // process has never tracked (e.g. right after this agent itself
  // restarted). Perf audit finding B8(2) — this used to Promise.all one
  // `systemctl --user is-active` spawn per id; isMasterAliveBatch already
  // returns an Object.create(null) record, same null-prototype treatment
  // /internal/sessions/live above needs (Object.fromEntries would build a
  // plain `{}` internally, equally reachable via a caller-controlled
  // "__proto__" key), so it's returned as-is.
  app.post<{ Body: LivenessBody }>(
    "/internal/sessions/liveness",
    { ...INTERNAL_RATE_LIMIT, schema: livenessSchema },
    async (request) => {
      const { ids } = request.body;
      return app.pty.isMasterAliveBatch(ids);
    },
  );

  // Mirrors DELETE /api/sessions/:id's app.pty.terminate call — fully ends
  // the attach-client, the dtach master, and the program itself. The
  // primary is the one that marks the DB row "killed"; this only ever does
  // the host-side half.
  app.post<{ Params: { id: string } }>(
    "/internal/sessions/:id/terminate",
    { ...INTERNAL_RATE_LIMIT, schema: terminateSchema },
    async (request, reply) => {
      await app.pty.terminate(request.params.id);
      reply.code(204);
    },
  );

  // Phase 4 (#187) — the agent-side counterpart of
  // GET /api/sessions/:id/scrollback: reads THIS agent's own in-memory
  // PtyManager, since that's the only process holding this session's
  // scrollback ring buffer. Returns an empty `b64` rather than 404 when the
  // session isn't currently tracked here (same "not tracked yet" ≠ "error"
  // posture as /internal/sessions/live's per-id null) — the primary's own
  // route (sessions.ts) already treats a thrown/unreachable call as
  // "report empty," so an untracked-but-reachable id must resolve the same
  // way, not as a 404 the primary would have to special-case differently.
  app.get<{ Params: { id: string } }>(
    "/internal/sessions/:id/scrollback",
    {
      ...INTERNAL_RATE_LIMIT,
      schema: {
        params: { type: "object", required: ["id"], properties: { id: SESSION_ID_SCHEMA } },
      },
    },
    async (request) => {
      const session = app.pty.get(request.params.id);
      return { b64: session ? session.getScrollback().toString("base64") : "" };
    },
  );

  // Issue #271 — the agent-side counterpart of
  // POST /api/sessions/:id/promote's seed-stash step: writes into THIS
  // agent's own PtyManager, since that's where the promoted session's own
  // SessionStart hook connection actually lands.
  app.post<{ Params: { id: string }; Body: { seed: string } }>(
    "/internal/sessions/:id/stash-seed",
    {
      ...INTERNAL_RATE_LIMIT,
      schema: {
        params: { type: "object", required: ["id"], properties: { id: SESSION_ID_SCHEMA } },
        body: {
          type: "object",
          required: ["seed"],
          additionalProperties: false,
          properties: { seed: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      app.pty.stashSeed(request.params.id, request.body.seed);
      reply.code(204);
    },
  );

  // Issue #271 — mirrors /internal/sessions/:id/review-gate's shape for a
  // pending promote_request instead of a review gate.
  app.post<{ Params: { id: string }; Body: PromoteDecisionBody }>(
    "/internal/sessions/:id/promote",
    {
      ...INTERNAL_RATE_LIMIT,
      schema: {
        params: { type: "object", required: ["id"], properties: { id: SESSION_ID_SCHEMA } },
        body: promoteDecisionSchema,
      },
    },
    async (request) => {
      const ok = app.resolvePendingPromote(request.params.id, request.body);
      return { ok };
    },
  );

  // Issue #178 — mirrors POST /api/sessions/:id/review-gate's shape but
  // returns `{ok}` rather than 204: unlike terminate (always succeeds for a
  // tracked id), a decision can genuinely arrive with nothing pending to
  // resolve (already resolved, timed out — see hooks.ts's
  // resolvePendingGate), and the primary needs to know that to answer its
  // own caller correctly instead of reporting a false success.
  app.post<{ Params: { id: string }; Body: ReviewGateBody }>(
    "/internal/sessions/:id/review-gate",
    { ...INTERNAL_RATE_LIMIT, schema: reviewGateSchema },
    async (request) => {
      const { decision, reason } = request.body;
      const ok = app.resolveHookGate(request.params.id, decision, reason);
      return { ok };
    },
  );

  // The agent-side counterpart to POST /api/sessions/:id/uploads (issue
  // #68): writes a pasted/attached image under a session's cwd on THIS
  // host's filesystem — where the CLI reading it back by path actually
  // runs, for a remote-hosted project. cwd/mime travel as query params (a
  // raw-body POST has no room for a JSON envelope alongside the image
  // bytes); the request body is the image itself. cwd is confined to this
  // agent's own PROJECTS_ROOTS via resolveWithinRoots — the same barrier
  // /internal/actions, /internal/dock, and /internal/github-repo already
  // apply to a caller-supplied cwd. Unlike those read-only routes (and
  // unlike /internal/sessions/ws/attach's exec-only use of cwd), this route
  // actually creates a directory and writes a file, so an unrestricted cwd
  // here is a real filesystem-write sink, not just a read path — CodeQL
  // flagged exactly that (uncontrolled data in a path expression reaching
  // writeFileSync/mkdirSync in session-upload.ts). Scoped to this plugin's
  // own encapsulated context, so it never affects how any other route file
  // parses its own request bodies.
  app.addContentTypeParser(/^image\//, { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  app.post<{ Querystring: { cwd?: string; mime?: string } }>(
    "/internal/uploads",
    { ...INTERNAL_RATE_LIMIT, bodyLimit: MAX_UPLOAD_BYTES },
    async (request, reply) => {
      const { cwd, mime } = request.query;
      if (!cwd || !mime) return reply.badRequest("cwd and mime query params are required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      if (!extensionForMime(mime)) return reply.badRequest(`Unsupported image type: ${mime}`);
      if (!Buffer.isBuffer(request.body)) return reply.badRequest("expected a raw image body");
      // Content check, not just Content-Type: rejects a body whose actual
      // leading bytes don't match the claimed image format — a client can't
      // smuggle arbitrary content onto disk under an image mime type.
      if (!matchesMagicBytes(request.body, mime)) {
        return reply.badRequest("File content does not match the declared image type");
      }

      const uploadPath = saveSessionUpload(resolvedCwd, request.body, mime);
      return { path: uploadPath };
    },
  );

  // The DB-less counterpart to /ws/terminal (terminal.ts): the primary
  // resolves `cwd`/`command` from its own DB (a session's row, falling back
  // to its project's), then passes them straight through as query params —
  // this agent has nowhere else to get them from. Everything past that is
  // identical: attachSocketToSession's getOrCreate is the same idempotent
  // spawn-or-reattach /ws/terminal itself relies on for the post-restart
  // reattach case, so this endpoint needs no separate "attach only, don't
  // spawn" variant.
  app.get(
    "/internal/ws/attach",
    {
      websocket: true,
      config: INTERNAL_RATE_LIMIT.config,
      preValidation: async (request, reply) => {
        const query = request.query as Record<string, string | undefined>;
        if (!query.id || !query.cwd || !query.command) {
          return reply.badRequest("id, cwd, and command query params are required");
        }
        // Same shape as SESSION_ID_SCHEMA above — this route takes id as a
        // query param, not a JSON body, so it can't use the ajv schema
        // directly, but the id flows into the exact same scopeUnitName(id)
        // sink (pty-manager.ts) either way.
        if (!SESSION_ID_PATTERN.test(query.id)) {
          return reply.badRequest("id must match ^[A-Za-z0-9_-]+$");
        }
      },
    },
    (socket, req) => {
      const query = req.query as Record<string, string | undefined>;
      const cols = Number(query.cols) || 80;
      const rows = Number(query.rows) || 24;

      attachSocketToSession(app, socket, {
        id: query.id as string,
        cwd: expandHome(query.cwd as string),
        command: query.command as string,
        cols,
        rows,
      });
    },
  );

  // The DB-less counterpart to /ws/events (routes/events.ts) — issue #166's
  // multi-host twin. The primary opens one of these per registered remote
  // host and relays its events into its own aggregated /ws/events stream
  // (see events.ts's own comment on that relay). No query params: like the
  // primary's own /ws/events, this is one aggregated stream covering every
  // session THIS agent tracks, not a per-session attach — attachLocalEventsSocket
  // is the exact same shared core the primary's own route uses, just reused
  // against this agent's own app.pty instead.
  app.get(
    "/internal/ws/events",
    { websocket: true, config: INTERNAL_RATE_LIMIT.config },
    (socket) => {
      attachLocalEventsSocket(app, socket);
    },
  );

  // The two-hop preview proxy's agent-side half (issue #28 phase 6): the
  // primary's own preview-proxy.ts forwards a browser's preview request
  // here instead of dialing a remote-hosted project's dev server directly
  // (which it has no network path to) — this agent dials it instead, on
  // its own loopback only (see resolveLoopbackPreviewUrl above). `*` is
  // Fastify's wildcard, always preceded by a literal "/" — safe because
  // the primary's own upstreamUrl.pathname (preview-proxy.ts's
  // buildUpstreamUrl) always starts with "/", so the request path here
  // always has one too, even for the dev server's own root ("/internal/
  // preview/5173/").
  //
  // Registered in its own encapsulated child context, not directly on
  // `app`, specifically so it can install a raw-passthrough content-type
  // parser without disturbing how any *other* /internal/* route (JSON
  // bodies, or the image/* parser above) parses its own body — a Fastify
  // child inherits its parent's hooks/decorators (including the bearer-
  // token onRequest check registered at the top of this function) but its
  // own addContentTypeParser calls stay scoped to itself. Removing every
  // inherited parser first, then adding a single "*" one, matters: adding
  // "*" alone would leave the inherited application/json parser still
  // winning for a JSON-Content-Type body, handing this handler an already-
  // parsed object it would have to lossily re-serialize rather than the
  // exact bytes the dev server needs.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, payload, done) => {
      done(null, payload);
    });

    scope.all<{ Params: { port: string } }>(
      "/internal/preview/:port/*",
      { ...INTERNAL_RATE_LIMIT, bodyLimit: MAX_PREVIEW_BODY_BYTES },
      async (request, reply) => {
        const port = parsePort(request.params.port);
        if (port === null) return reply.badRequest("port must be 1-65535");

        // request.raw.url, not Fastify's own decoded wildcard param: the
        // exact bytes the primary sent (including the query string, which a
        // wildcard route param wouldn't include) are what matter here, not
        // a re-encoded reconstruction of them.
        const prefix = `/internal/preview/${request.params.port}`;
        const rawUrl = request.raw.url ?? "/";
        const rest = rawUrl.startsWith(prefix) ? rawUrl.slice(prefix.length) : "/";

        const upstreamUrl = resolveLoopbackPreviewUrl(rest || "/", port);
        if (!upstreamUrl) return reply.badRequest("invalid preview path");

        // Strips the caller's own "authorization" header — the bearer token
        // this same request just authenticated with — before it reaches
        // arbitrary project dev-server code (see buildUpstreamRequestHeaders'
        // own comment on why this exclusion exists).
        const headers = buildUpstreamRequestHeaders(request, upstreamUrl.host, ["authorization"]);
        const body =
          request.body instanceof Readable
            ? {
                body: Readable.toWeb(request.body) as ReadableStream<Uint8Array>,
                duplex: "half" as const,
              }
            : {};

        let upstreamResponse: Response;
        try {
          upstreamResponse = await fetch(upstreamUrl, {
            method: request.method,
            headers,
            ...body,
            // Never auto-follow — forward the redirect to the primary (and,
            // from there, the browser) as-is, same posture as
            // preview-proxy.ts's own local-case fetch.
            redirect: "manual",
          } as RequestInit & { duplex?: "half" });
        } catch (err) {
          request.raw.resume();
          app.log.warn({ err, port }, "internal preview proxy: upstream unreachable");
          return reply.badGateway(`dev server on port ${port} is unreachable`);
        }
        // Never rewritten here — only the primary (preview-proxy.ts) knows
        // the browser's own URL space (including a devServerUrl's base-path
        // prefix); relativizing at this hop against this agent's loopback
        // origin instead would double up that prefix once the primary later
        // relativizes again. See http-proxy.ts's relativizeUpstreamLocation.
        return relayFetchResponse(reply, request.method, upstreamResponse, null);
      },
    );
  });

  // The WS analog of /internal/preview/:port/* above, for a remote-hosted
  // project's HMR connection (issue #28 phase 6) — port and the dev
  // server's own path+query travel as query params (a WS upgrade request
  // has no body), validated and resolved against this agent's own loopback
  // by the same resolveLoopbackPreviewUrl before the handshake completes.
  app.get(
    "/internal/ws/preview",
    {
      websocket: true,
      config: INTERNAL_RATE_LIMIT.config,
      preValidation: async (request, reply) => {
        const query = request.query as Record<string, string | undefined>;
        const port = query.port !== undefined ? parsePort(query.port) : null;
        if (port === null) return reply.badRequest("port must be 1-65535");
        if (query.path === undefined) return reply.badRequest("path query param is required");
        if (!resolveLoopbackPreviewUrl(query.path, port)) {
          return reply.badRequest("invalid preview path");
        }
      },
    },
    (socket, req) => {
      const query = req.query as Record<string, string | undefined>;
      // Re-derived, not trusted from preValidation's own run: cheap, pure,
      // and already proven to succeed by preValidation passing at all.
      const port = parsePort(query.port as string) as number;
      const upstreamUrl = resolveLoopbackPreviewUrl(query.path as string, port) as URL;

      const upstream = new NodeWebSocket(toWsUrl(upstreamUrl), {
        headers: { host: upstreamUrl.host },
      });
      pipeWsFrames(app, socket, upstream, { port });
    },
  );

  app.post<{ Params: { id: string }; Querystring: { projectId: string }; Body: AgentAction }>(
    "/internal/sessions/:id/browser",
    {
      ...INTERNAL_RATE_LIMIT,
      schema: {
        params: { type: "object", required: ["id"], properties: { id: SESSION_ID_SCHEMA } },
        body: agentActionSchema.body,
      },
    },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      const projectId = Number(request.query.projectId);
      if (!Number.isInteger(sessionId) || !Number.isInteger(projectId)) {
        return reply.badRequest("Invalid session id or project id");
      }

      if (!app.config.BROWSER_ENABLED) {
        return reply.badRequest("Browser feature is disabled");
      }

      let page: Page;
      try {
        const managed = await app.browser.getOrLaunch(projectId);
        page = managed.page;
      } catch (err) {
        return reply.badGateway((err as Error).message);
      }

      try {
        return await executeBrowserAction(app, page, request.body, projectId);
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  app.post<{ Params: { id: string }; Querystring: { projectId: string }; Body: FindElementsBody }>(
    "/internal/sessions/:id/browser/find",
    {
      ...INTERNAL_RATE_LIMIT,
      schema: {
        params: { type: "object", required: ["id"], properties: { id: SESSION_ID_SCHEMA } },
        body: findElementsSchema.body,
      },
    },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      const projectId = Number(request.query.projectId);
      if (!Number.isInteger(sessionId) || !Number.isInteger(projectId)) {
        return reply.badRequest("Invalid session id or project id");
      }

      if (!app.config.BROWSER_ENABLED) {
        return reply.badRequest("Browser feature is disabled");
      }

      let page: Page;
      try {
        const managed = await app.browser.getOrLaunch(projectId);
        page = managed.page;
      } catch (err) {
        return reply.badGateway((err as Error).message);
      }

      try {
        // Mirrors the REST route's own resolve-then-call pattern (see
        // browser-automation.ts's own POST /browser/find handler) —
        // executeBrowserFind expects an already-resolved SearchRoot, unlike
        // executeBrowserAction above, which still resolves `frame`
        // internally. Missing this call would silently search the
        // top-level document instead of a named iframe for every
        // multi-host `find` (RemoteHostClient.browserAutomationFind posts
        // here), with no error — caught by code review, PR #429.
        const root = await resolveSearchRoot(page, request.body.frame);
        return await executeBrowserFind(app, root, request.body);
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/internal/ws/browser/:sessionId",
    {
      websocket: true,
      config: INTERNAL_RATE_LIMIT.config,
      preValidation: async (request, reply) => {
        if (!app.config.BROWSER_ENABLED) {
          return reply.badRequest("Browser feature is disabled");
        }
        const sessionId = Number(request.params.sessionId);
        if (!Number.isInteger(sessionId)) {
          return reply.badRequest("Invalid sessionId");
        }
        const query = request.query as Record<string, string | undefined>;
        const projectId = Number(query.projectId);
        if (!Number.isInteger(projectId)) {
          return reply.badRequest("Invalid projectId");
        }
      },
    },
    (socket, req) => {
      const sessionId = Number(req.params.sessionId);
      const query = req.query as Record<string, string | undefined>;
      const projectId = Number(query.projectId);
      void attachSocketToBrowser(app, socket, { sessionId, projectId });
    },
  );

  // No project lookup here — dev-server-status is a live TCP/HTTP probe of
  // this agent's own loopback, not a DB read (this agent has no DB; see
  // src/app.ts's MULLION_ROLE === "agent" branch). The primary already holds
  // the project row and resolves devServerUrl into a port + scheme itself
  // (src/routes/projects.ts), forwarding only those — never the full URL or
  // host — same trust rule preview-proxy.ts's own remote dispatch follows
  // (src/db/schema.ts's projects table comment: "only the port is forwarded,
  // never the host"). A caller-supplied hostname here would turn this route
  // into a TCP-connect probe of arbitrary hosts reachable from the agent.
  app.get<{ Querystring: { port: string; scheme: string } }>(
    "/internal/dev-server-status",
    { ...INTERNAL_RATE_LIMIT },
    async (request, reply) => {
      const port = parsePort(request.query.port);
      if (port === null) return reply.badRequest("port must be 1-65535");
      const scheme = request.query.scheme;
      if (scheme !== "http" && scheme !== "https") {
        return reply.badRequest("scheme must be 'http' or 'https'");
      }

      const online = await pingDevServer(`${scheme}://127.0.0.1:${port}`);
      return { online };
    },
  );
}
