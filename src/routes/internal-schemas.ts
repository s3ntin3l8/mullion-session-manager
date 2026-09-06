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
  // Issue: per-project briefing storage / #942 (pinned note) — see
  // CreateSessionOptions.briefingOverride's own doc comment
  // (pty-manager.ts). Bounded (unlike initialPrompt/seedPrompt above,
  // which carry unbounded issue/task text): this is operator-authored
  // configuration — see the schema's own maxLength below for why it's
  // deliberately looser than project-tooling.ts's current save-time cap.
  briefingOverride?: string;
  // Issue #937 — see CreateSessionOptions.workflowConventionsText's own
  // doc comment (pty-manager.ts). Already resolved on the primary
  // (gating both the project's injectWorkflowConventions column and the
  // global text's non-emptiness), same "operator-authored, bounded"
  // posture as briefingOverride above — see the schema's own maxLength
  // below.
  workflowConventionsText?: string;
  // PR-5 — see CreateSessionOptions.projectSkill/projectReviewerAgent's own
  // doc comments (pty-manager.ts). Same "operator-authored, bounded"
  // posture as briefingOverride above — see the schema's own maxLength
  // below for the exact bound and why it differs in derivation from
  // briefingOverride's.
  projectSkill?: string;
  projectReviewerAgent?: string;
  // Issue #884 — see CreateSessionOptions.injectAgentGuide/
  // injectProjectBriefing's own doc comments (pty-manager.ts). Already
  // resolved to a definite boolean on the primary; no maxLength needed,
  // just a boolean type below.
  injectAgentGuide?: boolean;
  injectProjectBriefing?: boolean;
  // Issue #1089 — see CreateSessionOptions.injectMullionBundle's own doc
  // comment (pty-manager.ts). Already resolved to a definite boolean on the
  // primary; no maxLength needed, just a boolean type below, same as
  // injectAgentGuide/injectProjectBriefing above.
  injectMullionBundle?: boolean;
  // Set ONLY by Task Master spawn sites (task-claim.ts /
  // task-reconciler.ts / task-reseed.ts) to flag an unattended worker
  // session, which the opencode adapter uses to deny superpowers skills
  // that gate on a human in the loop (brainstorming / writing-plans /
  // finishing-a-development-branch). See CreateSessionOptions.taskId's own
  // doc comment (pty-manager.ts) for the full rationale — same posture
  // as injectAgentGuide/injectProjectBriefing above: a primary-resolved
  // value forwarded verbatim to a remote agent host. Spawn-time only, no
  // maxLength needed (a positive integer).
  taskId?: number;
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
      // Issue: per-project briefing storage / #942 (pinned note) — unlike
      // initialPrompt/seedPrompt above (arbitrary issue/task text with no
      // sane upper bound), this is operator-authored config resolved on
      // the primary. Deliberately NOT tied to project-tooling.ts's current
      // save-time cap (MAX_PROJECT_BRIEFING_FIELD_BYTES, 512) — #942
      // shrunk that cap from the OLD 8192-byte one with no data migration
      // ("single-user install, just change the behavior" — see the
      // issue's own body), so a row saved before this change can still be
      // up to 8192 bytes. This wire-level bound stays at that old, more
      // permissive size so a stale row doesn't hard-fail spawning on a
      // REMOTE host (this schema gates POST /internal/sessions, the only
      // path that validates this value before writeSessionBriefing's own
      // clamp ever runs) — the local/primary path already degrades
      // gracefully via that clamp regardless of this bound. Every NEW save
      // is already far under this via the write-side cap; this is purely
      // legacy-data headroom, not the current authoring limit.
      briefingOverride: { type: "string", maxLength: 8192 },
      // Issue #937 — mirrors project-tooling.ts's
      // MAX_PROJECT_TOOLING_FIELD_BYTES-style bound (see
      // workflow-conventions.ts's own MAX_WORKFLOW_CONVENTIONS_BYTES,
      // sized for multi-paragraph policy prose rather than a short pinned
      // note).
      workflowConventionsText: { type: "string", maxLength: 8192 },
      // PR-5 — unlike briefingOverride's maxLength above (derived from
      // project-briefing.ts's own post-clamp/header-prepend file-write cap,
      // a different pipeline these two fields never go through), this
      // mirrors project-tooling.ts's MAX_PROJECT_TOOLING_FIELD_BYTES
      // directly — the DB write-side cap this value was read from is
      // already exactly this size, so there's no separate headroom
      // calculation to duplicate here.
      projectSkill: { type: "string", maxLength: 8192 },
      projectReviewerAgent: { type: "string", maxLength: 8192 },
      injectAgentGuide: { type: "boolean" },
      injectProjectBriefing: { type: "boolean" },
      // Issue #1089 — see the interface's own doc comment above.
      injectMullionBundle: { type: "boolean" },
      // Spawn-time-only Task Master marker, forwarded verbatim from
      // SessionTarget (remote-host-client.ts) on the wire. See
      // CreateSessionOptions.taskId's own doc comment (pty-manager.ts) for
      // why the value is just `number` and there's no further min/max
      // bound — it's an opaque positive task id, not a user-controlled
      // field.
      taskId: { type: "integer" },
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
  /** Issue: correlate concurrent permission gates — see sessions.ts's own
   * reviewGateSchema for the full rationale (this mirrors it for the
   * agent-side counterpart route). */
  gateId?: string;
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
      gateId: { type: "string" },
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
  // Issue #895 — repo-relative paths to read scaffold-tracked content from
  // (routes/project-setup.ts's readExistingFiles). Bounded the same way
  // orphanPaths above is: mullion-scaffold.ts's own scaffoldableRelPaths
  // never emits more than a handful of paths per slug, so 200 is generous
  // headroom, not a real limit any caller approaches.
  paths: {
    type: "array",
    items: { type: "string", minLength: 1 },
    maxItems: 200,
  },
  // Issue #895 — the ScaffoldEntry[] shape mullion-scaffold.ts's
  // computeScaffold produces (`{path, kind: "file", contents} | {path,
  // kind: "symlink", target}`), duplicated here rather than imported: this
  // file is the agent's own DB-less schema module (see its header comment)
  // and mullion-scaffold.ts pulls in project-config.ts/skill-name.ts, which
  // this module has no business depending on just to reuse one type. Kept
  // deliberately loose (`contents`/`target` both optional strings, not a
  // schema-level oneOf keyed on `kind`) — the route handler itself validates
  // the kind-specific field is actually present before touching disk, the
  // same "ajv shape is a first filter, not the whole guard" posture this
  // file's other array-of-object fields (orphanPaths) already take.
  entries: {
    type: "array",
    items: {
      type: "object",
      required: ["path", "kind"],
      additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1 },
        kind: { type: "string", enum: ["file", "symlink"] },
        contents: { type: "string" },
        target: { type: "string" },
      },
    },
    // mullion-scaffold.ts's computeScaffold emits at most ~8 entries per
    // slug (AGENTS.md/CLAUDE.md/CONTRIBUTING.md/skill/reviewer/mirror/dock
    // config) — 50 is generous headroom, not a real limit any caller
    // approaches.
    maxItems: 50,
  },
  // Issue #895 — commitWipChanges' own optional commit message override
  // (git-worktree.ts); left unbounded like every other free-text field in
  // this file (briefingOverride is the one exception, bounded because it's
  // OPERATOR-authored persistent config — this is a one-shot commit
  // message, not stored config).
  message: { type: "string" },
  // Issue #895 — writeHostFiles' explicit opt-in to staging every change in
  // `cwd` via `git add -A` after writing (host-files.ts's own doc comment
  // on why this is a named, explicit flag rather than baked in unconditionally).
  stage: { type: "boolean" },
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

export interface ReadFilesBody {
  cwd: string;
  paths: string[];
}

// Issue #895 — the agent-side counterpart of readHostFiles (host-files.ts),
// for a remote-hosted project's scaffold preview/apply (routes/project-
// setup.ts).
export const readFilesSchema = schemaFor({
  required: ["cwd", "paths"],
});

export interface ScaffoldEntryBody {
  path: string;
  kind: "file" | "symlink";
  contents?: string;
  target?: string;
}

export interface WriteFilesBody {
  cwd: string;
  entries: ScaffoldEntryBody[];
  stage?: boolean;
}

// Issue #895 — the agent-side counterpart of writeHostFiles (host-files.ts).
export const writeFilesSchema = schemaFor({
  required: ["cwd", "entries"],
  optional: ["stage"],
});

export interface GitCommitWipBody {
  cwd: string;
  message?: string;
}

// Issue #895 — the agent-side counterpart of commitWipChanges
// (git-worktree.ts), for a remote-hosted project's scaffold apply.
export const gitCommitWipSchema = schemaFor({
  required: ["cwd"],
  optional: ["message"],
});

export interface BundleSyncRemoveBody {
  disabled: boolean;
}

// Issue #1089 — the agent-side counterpart of routes/bundle-sync.ts's own
// POST /api/bundle-sync/remove fan-out (via agent-bundle-state.ts's
// removeHostBundle/RemoteHostClient.removeAgentBundle). Not built via
// schemaFor above (that helper's field family is the cwd/path-shaped git
// primitives; this is a single, unrelated boolean) — a plain literal
// schema instead, same posture as promoteDecisionSchema just below.
export const bundleSyncRemoveSchema = {
  body: {
    type: "object",
    required: ["disabled"],
    additionalProperties: false,
    properties: {
      disabled: { type: "boolean" },
    },
  },
} as const;

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
