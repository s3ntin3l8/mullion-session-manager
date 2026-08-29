import type { FastifyInstance } from "fastify";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import {
  isDockPreviewWorktree,
  trackPreviewWorktree,
  cleanupPreviewWorktree,
  type CreateWorktreeResult,
} from "./git-worktree.js";
import { getStoredSettings } from "./settings.js";
import { resolveBackend } from "./session-backend.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { HostRequestError } from "./remote-host-client.js";
import { closeSessionBrowserBindings } from "./session-browsers.js";
import { resolveProjectHostId } from "./session-live-info.js";
import { isReservedSessionEnvKey } from "./session-env-keys.js";
import {
  readProjectBriefing,
  readProjectSkill,
  readProjectReviewerAgent,
} from "./project-tooling.js";

// Issue #822 — bounds shared between routes/sessions.ts's `env` schema
// property, routes/internal-schemas.ts's duplicate for the agent-side
// spawn schema, and services/dock-config.ts's own env validation, so "how
// much env is too much" has one answer regardless of which write path a
// caller used. Not a security boundary (a full-scope caller can already
// achieve an arbitrary env var via `command` composition, e.g. `FOO=bar
// claude`) — the real constraint is transport, not intent:
// remote-host-client.ts's openAttach() has nowhere to put `env` but the WS
// upgrade's query string (a GET has no body, and the `ws` package exposes
// no custom-body-on-upgrade option), which shares Node's 16 KB
// --max-http-header-size with the request line, the Bearer token, and the
// three HMAC signature headers. A worst-case env at these bounds
// JSON-stringifies to ~4.2 KB and, after URLSearchParams percent-encoding
// (the dominant multiplier — `{`, `}`, `"`, `:`, `,` all escape to 3 bytes
// each), lands the full request target at ~4.6 KB — comfortably clear of
// the limit even alongside the other query params and auth headers. Do not
// raise these without recomputing that encoded size (see the PR that added
// this comment for the calculation) — the old 64×4096 bound encoded to
// ~263 KB, well past --max-http-header-size, the moment a dock control
// actually used a meaningful chunk of it. (Untested what Node/`ws` actually
// do past the limit — a rejected upgrade or a hang, take your pick — the
// point of this bound is staying clear of it, not characterizing the
// failure.)
export const MAX_SESSION_ENV_ENTRIES = 16;
export const MAX_SESSION_ENV_VALUE_LENGTH = 256;

// Default terminal size for a session that hasn't had a browser attach yet
// to report its real dimensions — the first WS attach immediately resizes
// to whatever the client actually has (see terminal.ts).
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

// Issue #271 — the launcher's opt-in "isolate this session" toggle: when
// present, the session is created inside a fresh worktree instead of
// `cwd ?? project.cwd` directly. `baseRef` is the base-ref picker's chosen
// value (the roadmap's "picker, not one hardcoded rule" for the interactive
// path — see git-worktree.ts). `branchName` is optional; when omitted, a
// branch name is derived from a generated seed.
export interface WorktreeIntent {
  baseRef?: string;
  branchName?: string;
  /** Check out an existing branch via `git worktree add --force`. Mutually
   * exclusive with `baseRef` (which creates a new branch). */
  branch?: string;
}

// Field-for-field mirror of routes/sessions.ts's `createSessionSchema`
// (the Fastify JSON-schema validator for POST /api/sessions' body). The two
// live in different files — this interface here so createSessionRecord and
// its Task Master callers get real typing, the JSON schema there so Fastify
// can validate the wire body before this function ever sees it — and
// nothing enforces they stay in sync: adding a field to one without the
// other either silently drops it (schema only) or lets an unvalidated field
// through (type only). Update both together.
export interface CreateSessionBody {
  projectId: number;
  command: string;
  name?: string;
  // #9 — settable at creation, not just via a later PATCH. Without this, a
  // caller that wants a name to survive a live OSC title update (issue #69)
  // has to create, THEN immediately PATCH — a window in which the agent's
  // own title could already have overwritten it. See `sessions.nameLocked`
  // (schema.ts) for the column's own default-false rationale; this lets a
  // caller opt into the opposite up front.
  nameLocked?: boolean;
  // Overrides the parent project's cwd for this session only — e.g. a
  // launcher/action (src/services/project-config.ts) targeting a monorepo
  // subdirectory. Falls back to the project's own cwd when omitted. Ignored
  // when `worktree` is present — the worktree's own path is the effective
  // cwd in that case.
  cwd?: string;
  // "dock" for a session spawned from a project's dock controls (see
  // GET /api/projects/:id/dock) rather than a normal launcher/manual
  // session — lets the client keep dock terminals out of the regular
  // per-project session list. Defaults to "terminal" (the schema default).
  kind?: "terminal" | "dock";
  worktree?: WorktreeIntent;
  // When true, a preview worktree created for this session is periodically
  // synced to the branch's latest commit via `git reset --hard`. Set by
  // the frontend based on the dock control's worktreeRefresh config.
  worktreeRefresh?: boolean;
  // When true, append the agent's skip-permissions flag (e.g.
  // --dangerously-skip-permissions, --auto) so the CLI skips permission
  // prompts. Default false.
  skipPermissions?: boolean;
  // Phase 5 (Track B, issue #193 5.3b) — set only by the sessions.spawn_child
  // control-socket op (control-socket.ts), which stamps it from the caller's
  // OWN pinned session id, never from a request body it forwards verbatim.
  // A direct full-scope POST /api/sessions caller may also set this
  // explicitly (see createSessionRecord's validation below) — the socket op
  // is the narrow, session-scoped path to the same outcome, not the only one.
  parentSessionId?: number;
  // Issue #822 — extra env vars for this session's launch, on top of
  // whatever a dock control (project-config.ts's normalizeRawControl) or
  // direct caller supplies. Persisted to sessions.env (schema.ts) so a
  // re-bootstrap on reattach after a Mullion restart reproduces the same
  // launch plan — see that column's own doc comment. Applied in
  // launch-plan.ts's buildLaunchPlan BEFORE every Mullion-owned env write
  // (shell integration, the MULLION_* vars, SSH_AUTH_SOCK, hook-adapter
  // envAdditions), so none of those can be overridden by it — enforced by
  // reserved-key rejection at the dock-config write path, not here.
  env?: Record<string, string>;
}

// Issue #271 — resolves a WorktreeIntent into an actual worktree path,
// routed to whichever host owns `baseCwd`'s filesystem (resolveBackend).
// `seed` drives both the branch name and the worktree's own directory name
// (git-worktree.ts) — a typed `branchName` when given, else a generated,
// session-scoped label so two worktrees created in the same second never
// collide.
//
// Returns the resolved branch name alongside the path (Hermes review, PR
// #680) — a caller that needs to clean up this worktree on a LATER failure
// (e.g. sessions.ts's promote route, whose own spawn-failure cleanup runs
// outside createSessionRecord's rollback) needs the actual branch name to
// delete it too, not just the directory: `removeWorktree` only ever clears
// the directory half (git-worktree.ts's own doc comment on why — a
// worktree's branch is deliberately preserved for the "→ done"/"→ failed"
// paths that need it to survive). Without the branch name, a retry with the
// same (explicit or default `mullion/session-<id>`) branch name still fails
// "branch already exists" even after the directory is cleaned up.
// Issue #677 — returns the full CreateWorktreeResult (created/path/branch/
// reason/detail) rather than collapsing every failure into `null`, so a
// caller can surface WHY creation failed instead of one generic message.
// Wrapped in try/catch (Hermes-style gap found during #677's research): the
// sibling `worktree.branch` call a few lines below this function's own call
// site already guards against a remote-host throw
// (HostUnreachableError/HostRequestError — see that call's own comment);
// this path had no equivalent guard, so a remote failure here was a bare
// 500 rather than the same clean `worktree-failed` result every other
// failure in this function produces.
export async function resolveWorktreeCwd(
  app: FastifyInstance,
  hostId: string,
  baseCwd: string,
  intent: WorktreeIntent,
  seedHint: string,
): Promise<CreateWorktreeResult> {
  const seed = intent.branchName && intent.branchName.length > 0 ? intent.branchName : seedHint;
  try {
    // Only called when baseRef is known to be present (guarded by caller)
    return await resolveBackend(app, hostId).createWorktree(
      baseCwd,
      intent.baseRef!,
      seed,
      intent.branchName,
    );
  } catch (err) {
    // Split the same way logPreviewWorktreeHostError (below) and
    // killSession already do: a HostRequestError means the agent is up and
    // REJECTED the request (e.g. requireWithinRoots refusing baseCwd) — a
    // persistent condition that will recur on every retry, not a transient
    // network blip. Conflating the two here previously mislabeled a
    // rejection as "host-unreachable" in the 502 body the user sees (the
    // #484 postmortem's "HostRequestError covers any 4xx, not just 404" is
    // exactly this mistake).
    if (err instanceof HostRequestError) {
      app.log.warn({ hostId, err }, "resolveWorktreeCwd: host rejected the request");
      return { created: false, reason: "host-rejected", detail: err.message };
    }
    app.log.warn({ hostId, err }, "resolveWorktreeCwd: host unreachable");
    return {
      created: false,
      reason: "host-unreachable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// Issue #345 — the catch handler shared by a remote preview worktree's
// remove/sync closures (see trackPreviewWorktree's call site below). Always
// resolves `false`, never rejects — a `pendingRemoval`/sync-tick retry has
// to see a clean `false`, not a thrown error escaping into
// killSession/the reconciler/the tick's own catch. Distinguishes a
// `HostRequestError` (agent reachable but rejecting — e.g. a
// resolveWithinRoots failure) from a bare unreachable-host error, mirroring
// session-reconciler.ts's own split: unlike a transient network blip, a
// rejection is persistent and will keep recurring every retry otherwise
// silently forever.
// `alreadyWarned` (Hermes review, this PR) — the sync tick fires every 5s
// and the pendingRemoval retry does too, so an unmuted warn here would spam
// once per tick for as long as a host stays down or keeps rejecting —
// unlike a local failure, which is silent. Callers (trackPreviewWorktree's
// remove/sync closures below) track a per-operation "already warned since
// the last success" flag and pass it through, so only the FIRST failure in
// a given down-stretch actually logs; a later success resets that flag, so
// a fresh outage warns again.
function logPreviewWorktreeHostError(
  app: FastifyInstance,
  op: "remove" | "sync",
  hostId: string,
  worktreePath: string,
  err: unknown,
  alreadyWarned: boolean,
): false {
  if (!alreadyWarned) {
    if (err instanceof HostRequestError) {
      app.log.warn(
        { hostId, worktreePath, err },
        `preview worktree ${op}: host rejected the request (will keep retrying, further failures suppressed until it succeeds once)`,
      );
    } else {
      app.log.warn(
        { hostId, worktreePath, err },
        `preview worktree ${op}: host unreachable (further failures suppressed until it succeeds once)`,
      );
    }
  }
  return false;
}

export type CreateSessionParams = CreateSessionBody & {
  // Task Master only (task-claim.ts/task-reconciler.ts) — a prompt to start
  // the spawned agent's first turn with, see pty-manager.ts's
  // CreateSessionOptions.initialPrompt for the full delivery chain.
  // Deliberately NOT part of CreateSessionBody above (or routes/sessions.ts's
  // createSessionSchema, which mirrors it field-for-field — see that
  // interface's own doc comment): an ordinary caller of POST /api/sessions
  // never gets to set this, since
  // createSessionRecord's internal Task Master callers invoke it directly as
  // a TS function, bypassing route body validation entirely — the public
  // launcher/promote flows have no equivalent of an unattended "first turn."
  initialPrompt?: string;
  // Issue #678 — the promote flow's seed prompt (POST
  // /api/sessions/:id/promote's `seedPrompt` body field). Also NOT part of
  // CreateSessionBody: only the promote route ever sets this, the same
  // "internal callers pass extra fields the public schema doesn't expose"
  // shape as initialPrompt above. See stashSeed's own doc comment
  // (pty-manager.ts) for why this is stashed BEFORE spawn() is called, not
  // after — that ordering is the actual race fix this issue is about.
  seedPrompt?: string;
  // Issue #271 follow-up — routes/sessions.ts's promote handler, when
  // opencode-session-transfer.ts already imported the source session's full
  // conversation history into this new session's own worktree cwd. Also NOT
  // part of CreateSessionBody, same posture as initialPrompt/seedPrompt
  // above. See SessionBackend.spawn's own doc comment for why this is
  // local-only for now.
  resumeAgentSessionId?: string;
  // Issue: per-project briefing storage (a follow-up PR) — resolved here,
  // on the primary (where the DB lives), and threaded through spawn() below
  // the same way seedPrompt is. Also NOT part of CreateSessionBody: no
  // public route sets this yet. See CreateSessionOptions.briefingOverride's
  // own doc comment (pty-manager.ts) for the full multi-host reasoning.
  briefingOverride?: string;
  // PR-5 — see CreateSessionOptions.projectSkill/projectReviewerAgent's own
  // doc comments (pty-manager.ts). Same "not part of CreateSessionBody, no
  // public route sets these directly" posture as briefingOverride above —
  // the producer below resolves them from project_tooling itself.
  projectSkill?: string;
  projectReviewerAgent?: string;
};

export type CreateSessionResult =
  | {
      ok: true;
      row: typeof sessions.$inferSelect;
      project: typeof projects.$inferSelect;
      // Hermes review, PR #538 — echoes SessionBackend.spawn's own
      // SpawnResult so Task Master callers (task-claim.ts) can tell whether
      // an `initialPrompt` they sent was actually honored, rather than
      // trusting their own request-time guess (which a version-skewed
      // remote agent can silently defeat — see SpawnResult's own doc
      // comment). `undefined` when no `initialPrompt` was requested at all.
      initialPromptApplied?: boolean;
    }
  | { ok: false; reason: "unknown-project" }
  // `detail` (issue #677) — the actual reason a worktree creation call
  // failed (e.g. "branch already exists"), forwarded from
  // CreateWorktreeResult so routes/sessions.ts's error response can surface
  // it instead of one hardcoded generic message. Mirrors task-claim.ts's
  // own ClaimTaskOutcome.detail field, which routes/tasks.ts already reads
  // straight through — that route needs no change for this.
  | { ok: false; reason: "worktree-failed"; detail?: string }
  | { ok: false; reason: "spawn-failed" }
  // Phase 5 (Track B, issue #193 5.3b) — parentSessionId validation
  // failures, all clean 4xx per the roadmap's security guardrails for
  // sessions.spawn_child (never a 500).
  | { ok: false; reason: "unknown-parent" }
  | { ok: false; reason: "parent-wrong-project" }
  | { ok: false; reason: "parent-is-child" }
  | { ok: false; reason: "cwd-outside-project" }
  | { ok: false; reason: "child-cap-exceeded" }
  // Hermes review, this PR — validated here (not just dock-config.ts's write
  // path), so a direct full-scope `POST /api/sessions` caller carrying `env`
  // is bound by the same reserved-key rules as a dock control. See
  // session-env-keys.ts's own comment for why this is the required second
  // enforcement point, not a redundant one.
  | { ok: false; reason: "reserved-env-key"; detail: string };

// Shared by POST /api/sessions (the launcher's worktree toggle, option 1),
// POST /api/sessions/:id/promote (option 2), and POST /api/tasks/:id/claim
// (Phase 2.5's 2.5.2 — issue #216) — all three ultimately need "insert a
// session row and spawn it," optionally inside a freshly created worktree
// first. Rolls the DB row back on a spawn failure, same as the original
// inline POST /api/sessions handler did. Exported for routes/tasks.ts to
// reuse rather than re-implementing worktree-then-spawn-then-rollback.
export async function createSessionRecord(
  app: FastifyInstance,
  params: CreateSessionParams,
): Promise<CreateSessionResult> {
  const {
    projectId,
    command,
    name,
    nameLocked,
    kind,
    worktree,
    worktreeRefresh,
    skipPermissions,
    initialPrompt,
    seedPrompt,
    resumeAgentSessionId,
    env,
    briefingOverride,
    projectSkill,
    projectReviewerAgent,
  } = params;
  let cwd = params.cwd;

  // Hermes review, this PR (issue #822) — dock-config.ts's validateOneControl
  // is not the only producer of a session's `env`; a direct full-scope
  // `POST /api/sessions` call bypasses it entirely. Enforce the same
  // reserved-key rule here so it's bound regardless of caller, matching the
  // parentSessionId validation immediately below (also re-validated here for
  // exactly the same "not just the socket op" reason).
  if (env !== undefined) {
    const reservedKey = Object.keys(env).find(isReservedSessionEnvKey);
    if (reservedKey !== undefined) {
      return { ok: false, reason: "reserved-env-key", detail: reservedKey };
    }
  }

  const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
  if (!project) return { ok: false, reason: "unknown-project" };

  // Phase 5 (Track B, issue #193 5.3b) — validated here, not just in the
  // sessions.spawn_child socket op, so a direct full-scope POST /api/sessions
  // call carrying parentSessionId is bound by the exact same rules (same
  // project, one level of nesting only, a live-child cap). One level of
  // nesting: rejecting a parent that is ITSELF a child means a child can
  // never itself become a parent, so cascade-kill (killSession, below)
  // never needs to recurse past one level.
  let resolvedParentId: number | null = null;
  if (params.parentSessionId !== undefined) {
    const [parentRow] = app.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, params.parentSessionId))
      .all();
    if (!parentRow) return { ok: false, reason: "unknown-parent" };
    if (parentRow.projectId !== projectId) return { ok: false, reason: "parent-wrong-project" };
    if (parentRow.parentSessionId !== null) return { ok: false, reason: "parent-is-child" };

    resolvedParentId = params.parentSessionId;
  }

  if (worktree) {
    if (worktree.branch) {
      // Issue #345 — dock-preview worktrees now work on remote hosts too:
      // checkoutBranchWorktree, the worktreeRefresh sync tick, and cleanup
      // (below) are all routed through resolveBackend. Wrapped in try/catch
      // (unlike the old local-only call, where the underlying runGit never
      // rejects): a remote checkoutBranchWorktree can now genuinely throw
      // (HostUnreachableError/HostRequestError, same as every other
      // resolveBackend() call reachable for a remote host — see
      // killSession's own "must never surface as a 500" comment below) —
      // this was unreachable before #345 removed the local-only guard.
      let result;
      try {
        result = await resolveBackend(app, project.hostId).checkoutBranchWorktree(
          cwd ?? project.cwd,
          worktree.branch,
        );
      } catch (err) {
        app.log.warn(
          { hostId: project.hostId, err },
          "checkoutBranchWorktree: host unreachable or rejected the request",
        );
        return { ok: false, reason: "worktree-failed" };
      }
      if (!result) return { ok: false, reason: "worktree-failed" };
      cwd = result.path;
    } else if (worktree.baseRef) {
      const resolved = await resolveWorktreeCwd(
        app,
        project.hostId,
        cwd ?? project.cwd,
        worktree,
        `session-${Date.now()}`,
      );
      if (!resolved.created || !resolved.path) {
        return { ok: false, reason: "worktree-failed", detail: resolved.detail };
      }
      cwd = resolved.path;
    }
  }

  // Phase 5 (Track B) — cwd containment for a child spawn only. Skipped
  // when `worktree` was requested: that path's cwd comes from
  // checkoutBranchWorktree/resolveWorktreeCwd (a controlled backend call,
  // not a raw caller-supplied path), not the caller's own raw input — the
  // actual threat this guards against is an arbitrary `cwd` override
  // reaching a spawn through the caller's own inherited hook token, which
  // only the no-worktree branch can carry unchecked. (A worktree's own cwd
  // is, in fact, nested under the project root via `.mullion-worktrees/` —
  // it just never needs this check because it was never caller-supplied.)
  if (resolvedParentId !== null && !worktree) {
    const effectiveCwd = path.resolve(cwd ?? project.cwd);
    const projectRoot = path.resolve(project.cwd);
    const withinProject =
      effectiveCwd === projectRoot || effectiveCwd.startsWith(projectRoot + path.sep);
    if (!withinProject) return { ok: false, reason: "cwd-outside-project" };
  }

  // Phase 5 (Track B) — the live-child cap is checked and the row inserted
  // inside the SAME transaction (Hermes review, PR #426), not as two
  // separate statements: any worktree creation above is async and already
  // complete by this point, so this closes the check-then-act race a
  // caller combining `parentSessionId` with `worktree` could otherwise hit
  // (the `sessions.spawn_child` socket op itself never sets `worktree` —
  // see that op's own comment — so it was already effectively atomic here
  // via better-sqlite3's single-threaded, synchronous calls; this closes
  // the gap for the direct-REST/full-scope combination too).
  //
  // Known limitation, accepted (independent review, PR #426): the cap only
  // bounds CONCURRENTLY-live children, not cumulative spawns over time. An
  // agent looping fast-exiting commands can spawn up to the cap, wait for
  // the ~30s exited-session reconciler to flip them to "exited" (no longer
  // counted), then spawn another batch — unbounded over a long enough
  // window, leaving DB rows/dtach sockets/systemd scopes behind each cycle.
  // This still bounds the WORST case (every child staying busy at once,
  // the actual "unbounded fanout" the roadmap's Security & trust note
  // describes), just not a sustained-low-rate abuse pattern — a rate
  // limiter would be the real fix for that, and is a follow-up, not this PR.
  const maxChildren = getStoredSettings(app.db).sessions.maxChildSessionsPerParent;
  const inserted = app.db.transaction((tx) => {
    if (resolvedParentId !== null) {
      const liveChildren = tx
        .select()
        .from(sessions)
        .where(and(eq(sessions.parentSessionId, resolvedParentId), eq(sessions.status, "active")))
        .all();
      if (liveChildren.length >= maxChildren) return null;
    }
    return tx
      .insert(sessions)
      .values({
        projectId,
        command,
        name: name ?? null,
        cwd: cwd ?? null,
        ...(kind !== undefined ? { kind } : {}),
        ...(nameLocked !== undefined ? { nameLocked } : {}),
        ...(skipPermissions !== undefined ? { skipPermissions } : {}),
        ...(resolvedParentId !== null ? { parentSessionId: resolvedParentId } : {}),
        ...(env !== undefined ? { env: JSON.stringify(env) } : {}),
      })
      .returning()
      .all();
  });
  if (!inserted) return { ok: false, reason: "child-cap-exceeded" };
  const [created] = inserted;

  // Issue #678 — stashed BEFORE spawn() is called below, not after: the
  // agent's own process (and therefore its SessionStart hook) can't start
  // until spawn() actually runs, so this ordering guarantees the seed is
  // already present by the time a hook-based agent's SessionStart fires —
  // closing the race the previous call site (routes/sessions.ts's promote
  // handler, AFTER this function returned success) had. Also passed through
  // into spawn()'s own opts below so an adapter with no live hook round
  // trip (opencode) can read it from HookAdapterContext at launch time
  // instead — see hook-adapters/opencode.ts's own comment. Non-fatal on a
  // remote-host throw (log and continue to spawn): a seed that fails to
  // stash is a degraded promote, not a failed one — same posture as every
  // other best-effort remote call in this function.
  if (seedPrompt && seedPrompt.length > 0) {
    try {
      await resolveBackend(app, project.hostId).stashSeed(String(created.id), seedPrompt);
    } catch (err) {
      app.log.warn(
        { hostId: project.hostId, sessionId: created.id, err },
        "stashSeed: host unreachable or rejected the request — proceeding to spawn without it",
      );
    }
  }

  // Issue: per-project Mullion briefing authored from the UI — resolved
  // HERE, on the primary (where the DB lives), not by whichever host
  // actually spawns. `params.briefingOverride` (an explicit caller-supplied
  // value, currently unused by any caller) wins if ever set; otherwise this
  // project's own DB row (project-tooling.ts) wins over its committed
  // AGENTS.md/CLAUDE.md region — see that module's own doc comment for why.
  // `null`/absent DB row falls through to `undefined`, letting
  // writeSessionBriefing's existing resolveProjectBriefing(cwd) fallback
  // apply exactly as it always has.
  const resolvedBriefingOverride =
    briefingOverride ?? readProjectBriefing(app.db, project.id) ?? undefined;
  // PR-5 — same producer posture as resolvedBriefingOverride immediately
  // above: an explicit caller-supplied value (currently unused by any
  // public route, same as briefingOverride) wins, otherwise this project's
  // own DB row wins. `null`/absent falls through to `undefined`, which
  // every adapter's prepareLaunch already treats as "no project content" —
  // see HookAdapterContext.projectSkill/projectReviewerAgent's own doc
  // comments.
  const resolvedProjectSkill = projectSkill ?? readProjectSkill(app.db, project.id) ?? undefined;
  const resolvedProjectReviewerAgent =
    projectReviewerAgent ?? readProjectReviewerAgent(app.db, project.id) ?? undefined;

  let spawnResult: { initialPromptApplied?: boolean };
  try {
    spawnResult = await resolveBackend(app, project.hostId).spawn({
      id: String(created.id),
      cwd: cwd ?? project.cwd,
      command,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      skipPermissions,
      initialPrompt,
      seedPrompt,
      resumeAgentSessionId,
      projectId,
      briefingOverride: resolvedBriefingOverride,
      projectSkill: resolvedProjectSkill,
      projectReviewerAgent: resolvedProjectReviewerAgent,
      env,
    });
  } catch (err) {
    // Spawn rollback (issue #26 for the remote case; B6 for the local one):
    // leaving the row behind would be DB litter for a session that was
    // never actually spawned anywhere. Originally reachable only for a
    // remote host — LocalBackend.spawn() used to swallow every local spawn
    // failure (see Session.spawn()'s doc comment in pty-manager.ts for why
    // that silently returned 201 instead of ever reaching this catch) — but
    // B6 made LocalBackend.spawn() await Session.spawnOutcome() and
    // propagate a genuine first-attempt failure (missing systemd-run/dtach,
    // a vanished cwd, a scope-name collision), so this path is now reachable
    // for BOTH local and remote spawns; this block doesn't need to (and
    // doesn't) distinguish which. Also clean up preview worktree if one was
    // created (Claude review, PR #341): the worktree was created before the
    // spawn attempt, so it must be removed even when the spawn itself fails.
    // Routed through the backend (issue #345) rather than the local-only
    // removeWorktree: this was already reachable for a remote host via the
    // worktree.baseRef path above (never behind the old checkoutBranchWorktree
    // guard), and calling local git against a path that only exists on a
    // remote agent silently leaked it. parentCwd is passed explicitly —
    // removeWorktree's own `path.resolve(worktreePath, "../..")` fallback
    // would otherwise be computed on the wrong host.
    //
    // A real try/catch here, NOT `.catch(() => {})` (independent review,
    // this PR): RemoteBackend.removeWorktree isn't `async`, and its own
    // `client` getter (getRemoteHostClient) can throw SYNCHRONOUSLY — e.g. a
    // hosts row deleted mid-request — before ever returning a promise for
    // `.catch()` to attach to. A synchronous throw here would abort this
    // whole `catch` block, skipping the app.pty.kill()/db.delete()/log/
    // return below it and escaping createSessionRecord as an unhandled
    // rejection (a bare 500, not the worktree-failed/spawn-failed contract
    // every caller of this function expects). See routes/projects.ts's own
    // "Hermes review, PR #458" comment for the same footgun fixed once
    // already elsewhere in this codebase.
    if (worktree && cwd && cwd !== params.cwd) {
      try {
        await resolveBackend(app, project.hostId).removeWorktree(cwd, params.cwd ?? project.cwd);
      } catch {
        // Best-effort: a leaked worktree directory is the cheaper failure —
        // same posture as cleanupPreviewWorktree's pendingRemoval retry.
      }
    }
    // Fresh-review finding (Hermes, this PR): a LOCAL spawn failure means
    // PtyManager.getOrCreate() already inserted a Session into its own
    // `sessions`/`hookTokens` maps before spawn() was awaited — that Session
    // never attached anything (bootstrapMaster/attachClient never
    // succeeded), so app.pty.kill() here is a safe, side-effect-free map
    // eviction, not a real "detach a live client" call. Without this, a
    // failed local spawn permanently leaks that Session object plus its
    // hookToken -> id entry (which resolveToken() could still match against)
    // until the whole process restarts. A no-op for the remote case (no
    // local Session was ever created for a remote host's session id).
    app.pty.kill(String(created.id));
    // B9 — the row itself is deleted right below, so this id is genuinely
    // done: discard any stashed seed too rather than leaking it forever
    // (a realistic promote-flow seed wouldn't normally exist yet for a
    // session that failed its first spawn, but this is cheap defense-in-
    // depth for the same reason kill() itself deliberately does NOT do
    // this — see PtyManager.discardPendingSeed's own doc comment).
    app.pty.discardPendingSeed(String(created.id));
    app.db.delete(sessions).where(eq(sessions.id, created.id)).run();
    app.log.error({ err, hostId: project.hostId }, "session spawn failed, rolled back row");
    return { ok: false, reason: "spawn-failed" };
  }

  // Track preview worktrees for sync and cleanup
  const effectiveCwd = cwd ?? project.cwd;
  if (worktree?.branch && isDockPreviewWorktree(effectiveCwd)) {
    const previewBranch = worktree.branch;
    const previewParentCwd = params.cwd ?? project.cwd;
    trackPreviewWorktree(created.id, {
      worktreePath: effectiveCwd,
      branch: previewBranch,
      worktreeRefresh: worktreeRefresh ?? false,
      parentCwd: previewParentCwd,
      projectId,
      hostId: project.hostId,
      // Issue #345 — host-routed closures, attached only for a remote host
      // (undefined for local, which keeps git-worktree.ts's own local
      // fallback and every existing local-path test unmodified). Never
      // reject — logPreviewWorktreeHostError below always resolves `false`,
      // so an unreachable/erroring remote agent reads as `false` (queues
      // cleanupPreviewWorktree's pendingRemoval retry, or just skips one
      // sync tick), not as a thrown error escaping into
      // killSession/the reconciler/the sync tick's own catch.
      //
      // A real try/catch inside each async arrow, NOT `.catch()` chained
      // off the bare call (independent review, this PR — same footgun as
      // the spawn-rollback fix above): RemoteBackend.removeWorktree/
      // syncWorktree aren't `async`, and their `client` getter
      // (getRemoteHostClient) can throw SYNCHRONOUSLY (e.g. a hosts row
      // deleted mid-lifetime) before ever returning a promise for
      // `.catch()` to attach to. previewRemove/previewSync in
      // git-worktree.ts do still catch that throw (it happens while
      // evaluating `await info.remove()`, inside their own try) and
      // correctly resolve `false` either way — but a `.catch()` that never
      // attaches means logPreviewWorktreeHostError never runs, so a
      // synchronous-throw failure retried every 5s by the sync tick would
      // do so with zero diagnostics, forever, indistinguishable from
      // silence. Marking these `async` makes every throw — sync or async —
      // reach the same catch.
      // removeWarned/syncWarned (Hermes review, this PR) — per-closure state
      // tracking whether the LAST attempt already logged a failure, so a
      // host that stays down or keeps rejecting warns once per outage
      // rather than once per 5s tick forever. Reset to false on a call that
      // doesn't throw, so a later, fresh outage warns again.
      ...(project.hostId !== LOCAL_HOST_ID
        ? (() => {
            let removeWarned = false;
            let syncWarned = false;
            return {
              remove: async () => {
                try {
                  const result = await resolveBackend(app, project.hostId).removeWorktree(
                    effectiveCwd,
                    previewParentCwd,
                  );
                  removeWarned = false;
                  return result;
                } catch (err) {
                  const wasAlreadyWarned = removeWarned;
                  removeWarned = true;
                  return logPreviewWorktreeHostError(
                    app,
                    "remove",
                    project.hostId,
                    effectiveCwd,
                    err,
                    wasAlreadyWarned,
                  );
                }
              },
              sync: async () => {
                try {
                  const result = await resolveBackend(app, project.hostId).syncWorktree(
                    effectiveCwd,
                    previewBranch,
                  );
                  syncWarned = false;
                  return result;
                } catch (err) {
                  const wasAlreadyWarned = syncWarned;
                  syncWarned = true;
                  return logPreviewWorktreeHostError(
                    app,
                    "sync",
                    project.hostId,
                    effectiveCwd,
                    err,
                    wasAlreadyWarned,
                  );
                }
              },
            };
          })()
        : {}),
    });
  }

  return {
    ok: true,
    row: created,
    project,
    initialPromptApplied: spawnResult.initialPromptApplied,
  };
}

// Shared by DELETE /api/sessions/:id and POST /api/sessions/:id/promote (the
// latter kills the source session after the new worktree session is up).
// Returns null when the row doesn't exist; otherwise always flips it to
// "killed" (even if the host-side terminate call itself failed — see the
// inline comment this was factored out of for why that's still correct).
//
// Phase 5 (Track B, issue #193/#196 5.6) — `cascade` governs this session's
// LIVE children (parentSessionId = sessionId, status "active"), if any.
// Default "detach": explicitly clears each live child's parentSessionId to
// null, so it becomes an independent top-level session — silently killing a
// child that may be doing real work is the worse failure than leaving it
// running. NOT the `set null` FK's own ON DELETE behavior: killSession never
// actually deletes a row (see this function's own next paragraph — it only
// ever flips `status`), so that FK action is never triggered by a kill and
// detachment has to be done explicitly here instead. "kill" recurses through
// this SAME function, but always with cascade:"detach" per child, never
// "kill" — that hardcoded argument, not the one-level-nesting rule alone,
// is what actually bounds the recursion to a single level: nesting only
// guarantees a child has no children of ITS OWN at the moment it's killed,
// but a "detach"-ed former child (independent review, PR #426) becomes an
// ordinary top-level session afterward and could itself acquire children
// later — the recursion is safe because this call only ever passes
// "detach" downward, never propagating "kill" past one level, regardless
// of what an already-detached ex-child might do next.
export async function killSession(
  app: FastifyInstance,
  sessionId: number,
  cascade: "detach" | "kill" = "detach",
): Promise<typeof sessions.$inferSelect | null> {
  const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
  if (!row) return null;

  if (cascade === "kill") {
    const liveChildren = app.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.parentSessionId, sessionId), eq(sessions.status, "active")))
      .all();
    for (const child of liveChildren) {
      await killSession(app, child.id, "detach");
    }
  } else {
    // Only LIVE children — an already-`exited`/`killed` child's
    // `parentSessionId` is deliberately left pointing at this now-killed
    // parent (Hermes review, PR #426): it's terminal history at this point,
    // not an active relationship needing detachment, and preserving the
    // link costs nothing since a terminal session isn't part of any
    // cascade/orphan-rule logic going forward.
    app.db
      .update(sessions)
      .set({ parentSessionId: null })
      .where(and(eq(sessions.parentSessionId, sessionId), eq(sessions.status, "active")))
      .run();
  }

  const hostId = resolveProjectHostId(app, row.projectId);

  // A9 — kill/attach TOCTOU: flip the row to "killed" BEFORE awaiting the
  // host-side terminate call below, not after. Previously this update ran
  // only once terminate() had already resolved, leaving a window — for as
  // long as the host call takes — where the row still read "active" while
  // the terminate was in flight. A `/ws/terminal` upgrade landing in that
  // window passes both preValidation and the attach re-check (both just
  // read `active`), reaches getOrCreate() -> spawn() -> bootstrapMaster(),
  // and creates a brand-new systemd-run scope — and then this row flips to
  // "killed" underneath it, so terminal.ts refuses to ever reattach, and the
  // exited-session reconciler only scans `status = "active"` rows, so
  // nothing ever sweeps the orphaned master. Moving the flip first closes
  // that window. This is behavior-preserving for the failure case below:
  // the row already flipped to "killed" even when the host call failed
  // (see the catch's own comment), so flipping it earlier changes nothing
  // about what happens on failure — it only narrows when a concurrent
  // attach can still succeed.
  const [updated] = app.db
    .update(sessions)
    .set({ status: "killed" })
    .where(eq(sessions.id, sessionId))
    .returning()
    .all();

  try {
    await resolveBackend(app, hostId).terminate(String(sessionId));
  } catch (err) {
    // Best-effort: an unreachable host or an agent-side 4xx must never
    // surface as a 500, and the row is already "killed" above regardless —
    // leaving it "active" would mean terminal.ts keeps offering to
    // re-attach to a master this call couldn't actually confirm was
    // stopped. Tradeoff: if the host was genuinely unreachable (not just a
    // 4xx), its dtach master may still be running while this row now reads
    // "killed" — a killed row is never re-offered for reattach and the
    // reconciler doesn't revive one, so that master would be orphaned until
    // an operator notices.
    app.log.warn(
      { hostId, sessionId, err },
      "session terminate: host call failed, marking killed anyway",
    );
  }

  // #182 — "session close kills associated browser instances."
  closeSessionBrowserBindings(app, sessionId);

  // Clean up a preview worktree if this session had one. The row still
  // flips to "killed" above regardless of whether this succeeds — unlike
  // the reconciler (which can safely leave a row "active" for a later pass
  // to retry), killSession has no such fallback: terminate() has already
  // killed the process, so leaving the row un-flipped would show a dead
  // session as running until the 30s reconciler sweep, which would then
  // mark it "exited" and lose the "user explicitly killed this" distinction.
  // A leaked worktree directory is the cheaper failure — and it isn't even
  // permanently leaked: cleanupPreviewWorktree marks it pendingRemoval on
  // failure, and the sync tick actually retries it (git-worktree.ts).
  await cleanupPreviewWorktree(sessionId, app.log);

  return updated ?? null;
}
