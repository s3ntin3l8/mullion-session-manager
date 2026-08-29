import type { PromoteDecision } from "../plugins/hooks.js";

// The JSON Schema bodies/params for `internalRoutes` (internal.ts) — the
// DB-less agent's own token-gated API. Extracted from internal.ts, which
// used to carry ~450 lines of hand-written schema literals plus a parallel
// `interface XBody` for each one, kept in sync by hand. See
// test/routes/internal-schemas.test.ts for the byte-identical-output
// regression guard this extraction depends on — Fastify's ajv defaults to
// `removeAdditional: true`, which SILENTLY STRIPS an unknown property under
// `additionalProperties: false` instead of rejecting it (see internal.ts's
// own comment on POST /internal/sessions for where that bit in practice), so
// a schema that changes shape during a refactor like this one can fail
// silently rather than loudly.

// A session id is always the primary's stringified integer row id
// (String(sessionId) — see terminal.ts/sessions.ts) by construction, but
// this schema is the agent's only defense against a malformed one: it flows
// straight into pty-manager.ts's scopeUnitName(id) -> `crs-session-<id>`,
// naming a real systemd --user scope and dtach socket file. An id with
// systemd- or filesystem-illegal characters (e.g. "/") wouldn't be an
// injection (spawn/stop always use an argv array, never a shell string),
// but would make bootstrap/terminate silently target the wrong unit/file.
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const SESSION_ID_SCHEMA = {
  type: "string",
  minLength: 1,
  pattern: SESSION_ID_PATTERN.source,
} as const;

// The `{ params: { id } }` shape repeated across ~7 routes in internal.ts
// (terminate, review-gate, scrollback, stash-seed, promote, browser action,
// browser find) — factored out once these were all found byte-identical.
export const SESSION_ID_PARAMS_SCHEMA = {
  type: "object",
  required: ["id"],
  properties: {
    id: SESSION_ID_SCHEMA,
  },
} as const;

// Duplicated from session-lifecycle.ts's own MAX_SESSION_ENV_ENTRIES/
// MAX_SESSION_ENV_VALUE_LENGTH rather than imported — that module pulls in
// the primary's DB schema, which this agent-side (DB-less) schema file has
// no business importing just for two numeric bounds. Keep the two values
// in sync by hand — see the comment on the source constants for why they're
// sized the way they are (openAttach()'s WS-upgrade query string, not just
// "a sane cap"). Exported so internal.ts's `/internal/ws/attach`
// preValidation enforces the identical bound on the query-string `env` it
// parses by hand (that route takes no JSON body, so it can't reuse this
// schema object directly).
export const MAX_SESSION_ENV_ENTRIES = 16;
export const MAX_SESSION_ENV_VALUE_LENGTH = 256;

export interface SpawnSessionBody {
  id: string;
  cwd: string;
  command: string;
  cols: number;
  rows: number;
  skipPermissions?: boolean;
  initialPrompt?: string;
  seedPrompt?: string;
  projectId?: number;
  // Issue #822 — see CreateSessionBody.env's own doc comment
  // (session-lifecycle.ts).
  env?: Record<string, string>;
  // Issue: per-project briefing storage (a follow-up PR) — see
  // CreateSessionOptions.briefingOverride's own doc comment
  // (pty-manager.ts). Bounded (unlike initialPrompt/seedPrompt above,
  // which carry unbounded issue/task text): this is operator-authored
  // configuration, not arbitrary user content, so 2x
  // project-briefing.ts's own MAX_BRIEFING_BYTES (4096) is a real bound,
  // not a token gesture — see the schema's own maxLength below.
  briefingOverride?: string;
}

export const spawnSessionSchema = {
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
      // Issue #678 — the promote flow's seed prompt, carried alongside the
      // spawn request (rather than only via the separate stash-seed route
      // below) so an adapter with no live hook round trip to deliver it
      // through (opencode) can read it from HookAdapterContext at launch
      // time. No maxLength, same posture as initialPrompt above.
      seedPrompt: { type: "string" },
      projectId: { type: "integer" },
      env: {
        type: "object",
        maxProperties: MAX_SESSION_ENV_ENTRIES,
        additionalProperties: { type: "string", maxLength: MAX_SESSION_ENV_VALUE_LENGTH },
      },
      // Issue: per-project briefing storage (a follow-up PR) — unlike
      // initialPrompt/seedPrompt above (arbitrary issue/task text with no
      // sane upper bound), this is operator-authored config resolved on
      // the primary, so a real maxLength is appropriate — 2x
      // project-briefing.ts's own MAX_BRIEFING_BYTES (4096), covering the
      // clamped body plus buildSessionBriefingContent's header with room
      // to spare, without being unbounded.
      briefingOverride: { type: "string", maxLength: 8192 },
    },
  },
};

export interface LiveStatusBody {
  ids: string[];
  idleThresholdMs: number;
  sessionProjectIds?: Record<string, number>;
}

export const liveStatusSchema = {
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

export interface LivenessBody {
  ids: string[];
}

export const livenessSchema = {
  body: {
    type: "object",
    required: ["ids"],
    additionalProperties: false,
    properties: {
      ids: { type: "array", items: SESSION_ID_SCHEMA },
    },
  },
};

export const terminateSchema = {
  params: SESSION_ID_PARAMS_SCHEMA,
};

export interface ReviewGateBody {
  decision: "approved" | "denied";
  reason?: string;
}

// Issue #178 — the agent-side counterpart of POST /api/sessions/:id/review-gate.
export const reviewGateSchema = {
  params: SESSION_ID_PARAMS_SCHEMA,
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

// Shared field fragments for the twelve-ish GitWorktree*/git-*-family body
// schemas below, which differ from each other only in which of this small,
// stable field set is required vs optional. `overrides` lets one call site
// diverge on a single field's constraint — e.g. gitWorktreeCreateSchema's
// OPTIONAL `branchName` deliberately has no `minLength` (an absent value is
// fine; an explicitly-empty one is also left to downstream sanitization),
// unlike every REQUIRED use of the same field name below — without forking
// the field into a second dict entry.
type FieldSchema = Record<string, unknown>;

const GIT_FIELD_DEFS = {
  cwd: { type: "string", minLength: 1 },
  worktreePath: { type: "string", minLength: 1 },
  parentCwd: { type: "string" },
  branch: { type: "string", minLength: 1 },
  branchName: { type: "string", minLength: 1 },
  baseRef: { type: "string", minLength: 1 },
  seed: { type: "string", minLength: 1 },
  name: { type: "string", minLength: 1 },
  token: { type: "string", minLength: 1 },
  force: { type: "boolean" },
  orphanPaths: {
    type: "array",
    items: { type: "string", minLength: 1 },
    // Issue #283 — capped at 200, the same "bound it, don't silently
    // truncate the caller's intent" posture as MAX_READBACK_CHECKS_PER_SWEEP
    // elsewhere in this phase; a project with more orphans than that in one
    // sweep is unusual enough to warrant investigation, not a bigger cap.
    maxItems: 200,
  },
} satisfies Record<string, FieldSchema>;

type GitFieldName = keyof typeof GIT_FIELD_DEFS;

function schemaFor(spec: {
  required: GitFieldName[];
  optional?: GitFieldName[];
  overrides?: Partial<Record<GitFieldName, FieldSchema>>;
}) {
  const properties: Record<string, FieldSchema> = {};
  for (const field of [...spec.required, ...(spec.optional ?? [])]) {
    properties[field] = spec.overrides?.[field] ?? GIT_FIELD_DEFS[field];
  }
  return {
    body: {
      type: "object",
      required: spec.required,
      additionalProperties: false,
      properties,
    },
  };
}

export interface GitWorktreeCreateBody {
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
export const gitWorktreeCreateSchema = schemaFor({
  required: ["cwd", "baseRef", "seed"],
  optional: ["branchName"],
  overrides: { branchName: { type: "string" } },
});

export interface GitWorktreeRemoveBody {
  worktreePath: string;
  parentCwd?: string;
}

// Issue #283 — the agent-side counterpart of removeWorktreeIfClean, for a
// remote-hosted task's cleanup-on-done/failed step.
export const gitWorktreeRemoveSchema = schemaFor({
  required: ["worktreePath"],
  optional: ["parentCwd"],
});

export interface GitWorktreeCheckoutBody {
  cwd: string;
  branch: string;
}

// Issue #345 — the agent-side counterpart of checkoutBranchWorktree, for a
// remote-hosted project's dock-preview flow (an EXISTING branch, detached
// HEAD — distinct from gitWorktreeCreateSchema above, which creates a new
// branch from a baseRef).
export const gitWorktreeCheckoutSchema = schemaFor({
  required: ["cwd", "branch"],
});

export interface GitWorktreeForceRemoveBody {
  worktreePath: string;
  parentCwd?: string;
}

// Issue #345 — the agent-side counterpart of removeWorktree (--force,
// unlike gitWorktreeRemoveSchema above which is the never-force
// removeWorktreeIfClean). A dock-preview worktree running an HMR dev server
// is almost always dirty, so the safe path can't be reused here.
export const gitWorktreeForceRemoveSchema = schemaFor({
  required: ["worktreePath"],
  optional: ["parentCwd"],
});

export interface GitWorktreeSyncBody {
  worktreePath: string;
  branch: string;
}

// Issue #345 — the agent-side counterpart of syncWorktree (the
// worktreeRefresh live-sync tick's `git reset --hard`), for a remote-hosted
// project's dock-preview worktree.
export const gitWorktreeSyncSchema = schemaFor({
  required: ["worktreePath", "branch"],
});

export interface GitWorktreeClearOrphanBody {
  cwd: string;
  worktreePath: string;
  branchName: string;
}

// Issue #283 — the agent-side counterpart of clearOrphanedTaskWorktree,
// task-claim.ts's pre-claim step. `branchName` is required (unlike the
// create route's optional one) — this route always deletes it when a
// removal succeeds, so an absent value would silently no-op the half of
// this route that actually matters for the retry-collision it exists to fix.
export const gitWorktreeClearOrphanSchema = schemaFor({
  required: ["cwd", "worktreePath", "branchName"],
});

export interface GitWorktreePruneBody {
  cwd: string;
  orphanPaths: string[];
}

// Issue #283 — the agent-side counterpart of pruneWorktrees.
export const gitWorktreePruneSchema = schemaFor({
  required: ["cwd", "orphanPaths"],
});

export interface GitBranchDeleteBody {
  cwd: string;
  name: string;
  force?: boolean;
}

// Issue #442 — the agent-side counterpart of deleteBranch, for a
// remote-hosted project's GitPanel manual branch-management UI.
export const gitBranchDeleteSchema = schemaFor({
  required: ["cwd", "name"],
  optional: ["force"],
});

export interface GitWorktreeRemoveListedBody {
  cwd: string;
  worktreePath: string;
  force?: boolean;
}

// Issue #442 — the agent-side counterpart of removeListedWorktree: unlike
// /internal/git-worktree/remove above, not scoped to task worktrees — the
// validity gate is membership in this agent's own `git worktree list`.
export const gitWorktreeRemoveListedSchema = schemaFor({
  required: ["cwd", "worktreePath"],
  optional: ["force"],
});

export interface GitWorktreePruneMetadataBody {
  cwd: string;
}

// Issue #442 — the agent-side counterpart of pruneWorktreeMetadata (`git
// worktree prune`, not pruneWorktrees' task-worktree sweeper above).
export const gitWorktreePruneMetadataSchema = schemaFor({
  required: ["cwd"],
});

export interface GitPullBody {
  cwd: string;
}

// Issue #745 — the agent-side counterpart of runGitPull for a remote-hosted
// project's fast-forward git pull.
export const gitPullSchema = schemaFor({
  required: ["cwd"],
});

export interface GitPushBody {
  cwd: string;
  branch: string;
  token: string;
}

// #484 — the agent-side counterpart of pushBranch, for a remote-hosted
// task's promotion. `token` is never logged (see the route's own comment)
// and is only ever echoed back redacted, via pushBranch's own redact().
export const gitPushSchema = schemaFor({
  required: ["cwd", "branch", "token"],
});

export interface GitWorktreeResumeBody {
  cwd: string;
  branchName: string;
}

// #484 — the agent-side counterpart of resumeTaskWorktree, for Retry
// (#483) on a remote-hosted task.
export const gitWorktreeResumeSchema = schemaFor({
  required: ["cwd", "branchName"],
});

export type PromoteDecisionBody = PromoteDecision;

// Issue #271 — mirrors reviewGateSchema's shape for the accepted/declined
// union (see plugins/hooks.ts's PromoteDecision). Not built via schemaFor
// above (a different field set — decision/worktreePath/newSessionId/reason —
// not the git-path family), and used bare (not `{ body: ... }`) since its
// one call site combines it with SESSION_ID_PARAMS_SCHEMA under a shared
// `schema: { params, body }` object rather than spreading a body-only const.
export const promoteDecisionSchema = {
  type: "object",
  required: ["decision"],
  properties: {
    decision: { type: "string", enum: ["accepted", "declined"] },
    worktreePath: { type: "string" },
    newSessionId: { type: "integer" },
    reason: { type: "string" },
  },
} as const;

// Mirrors routes/dock-config.ts's own writeDockConfigSchema exactly —
// deliberately thin (see that file's own comment on why: Fastify's ajv
// defaults to `removeAdditional: true`, which SILENTLY STRIPS an unknown
// property under `additionalProperties: false` instead of rejecting it, so
// per-control shape validation is left entirely to validateDockConfig
// against the untouched raw array). Kept as a second literal copy rather
// than a shared export for the same reason agentRuleWriteBodySchema just
// below is its own copy rather than imported from routes/agent-rules.ts.
export const writeDockConfigBodySchema = {
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
export const agentRuleWriteBodySchema = {
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
export const toggleSkillBodySchema = {
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
