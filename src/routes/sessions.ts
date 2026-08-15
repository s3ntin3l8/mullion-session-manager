import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import { ensurePreviewSyncTick, stopPreviewSyncTick } from "../services/git-worktree.js";
import { getStoredSettings } from "../services/settings.js";
import { resolveBackend } from "../services/session-backend.js";
import { HostRequestError } from "../services/remote-host-client.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import type { SessionInfo } from "../services/pty-manager.js";
import { isValidDevServerUrl } from "./projects.js";
import { getOrCreateProjectPreview } from "../services/preview-registry.js";
import {
  MAX_UPLOAD_BYTES,
  extensionForMime,
  matchesMagicBytes,
} from "../services/session-upload.js";
import { listSessionBrowserBindings } from "../services/session-browsers.js";
import {
  createSessionRecord,
  killSession,
  resolveWorktreeCwd,
  type CreateSessionBody,
} from "../services/session-lifecycle.js";
import { commandSupportsSeed } from "../services/task-agent-resolve.js";
import {
  withLiveInfo,
  resolveProjectHostId,
  withLiveStatus,
} from "../services/session-live-info.js";

interface RenameSessionBody {
  name: string;
}

interface ReviewGateBody {
  decision: "approved" | "denied";
  reason?: string;
}

const worktreeIntentSchema = {
  type: "object",
  required: [],
  additionalProperties: false,
  properties: {
    baseRef: { type: "string", minLength: 1 },
    branchName: { type: "string" },
    branch: { type: "string", minLength: 1 },
  },
  // Require exactly one of baseRef (new-branch worktree) or branch
  // (existing-branch checkout). An empty `worktree: {}` is now rejected
  // at the schema level rather than silently skipping creation.
  oneOf: [{ required: ["baseRef"] }, { required: ["branch"] }],
} as const;

// Field-for-field mirror of services/session-lifecycle.ts's `CreateSessionBody`
// TS interface — see that interface's own doc comment for why the two live
// in different files and why nothing but code review keeps them in sync.
const createSessionSchema = {
  body: {
    type: "object",
    required: ["projectId", "command"],
    additionalProperties: false,
    properties: {
      projectId: { type: "integer" },
      command: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
      cwd: { type: "string", minLength: 1 },
      kind: { type: "string", enum: ["terminal", "dock"] },
      worktree: worktreeIntentSchema,
      worktreeRefresh: { type: "boolean" },
      skipPermissions: { type: "boolean" },
      parentSessionId: { type: "integer" },
    },
  },
};

// Phase 5 (Track B, issue #196 5.6) — see DELETE /api/sessions/:id's own
// comment for why this is a querystring, not a body.
const deleteSessionSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      cascade: { type: "string", enum: ["detach", "kill"] },
    },
  },
};

const renameSessionSchema = {
  body: {
    type: "object",
    required: ["name"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1 },
    },
  },
};

// Issue #178 — the minimal review gate's one write endpoint: delivers a
// human's Approve/Deny decision (NotificationBell.tsx) to whichever open
// hook connection is currently blocked waiting for one.
const reviewGateSchema = {
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

// Issue #404 — accept/dismiss a plain session's detected dev-server offer.
// `port` is required and validated against the session's own live
// pendingDevServerPort (never trusted as-is) — see PtyManager.
// acceptDevServerPort/dismissDevServerPort's doc comments.
interface DevServerActionBody {
  port: string;
}

const devServerActionSchema = {
  body: {
    type: "object",
    required: ["port"],
    additionalProperties: false,
    properties: {
      // Mirrors dev-server-detect.ts's DEV_SERVER_BANNER_LINE capture group
      // (1-5 digits) — parseDevServerPort never returns anything else, so a
      // value outside this shape could never actually be
      // session.pendingDevServerPort and would just 409 either way; this
      // just rejects it before that round trip.
      port: { type: "string", pattern: "^\\d{1,5}$" },
    },
  },
};

interface PromoteSessionBody {
  baseRef: string;
  branchName?: string;
  seedPrompt?: string;
}

interface DeclinePromoteBody {
  reason?: string;
}

// Issue #271 — option 2's "promote an existing session" action: creates a
// worktree, moves work into a NEW session there (seeded with `seedPrompt`
// if given), and kills the source session. Used both by a human's kebab-menu
// action (no pending agent request) and to resolve an agent-triggered
// `promote_request` (see hooks.ts's pendingPromotes) — the route can't tell
// which case it is until it checks app.pty for a pending request on this id.
const promoteSessionSchema = {
  body: {
    type: "object",
    required: ["baseRef"],
    additionalProperties: false,
    properties: {
      baseRef: { type: "string", minLength: 1 },
      branchName: { type: "string" },
      seedPrompt: { type: "string" },
    },
  },
};

const declinePromoteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      reason: { type: "string" },
    },
  },
};

export async function sessionsRoute(app: FastifyInstance) {
  // Start the preview worktree sync tick on first route registration
  ensurePreviewSyncTick();
  app.addHook("onClose", (_app, done) => {
    stopPreviewSyncTick();
    done();
  });

  app.get<{ Querystring: { projectId?: string; kind?: string; status?: string } }>(
    "/api/sessions",
    async (request, reply) => {
      const { kind, status } = request.query;
      if (kind !== undefined && kind !== "terminal" && kind !== "dock") {
        return reply.badRequest("kind must be 'terminal' or 'dock'");
      }
      // Perf audit finding A6 — prod's own /api/sessions payload was 293
      // rows, 284 of them `killed` tombstones the frontend already filters
      // back out client-side (Sidebar.tsx). Nothing ever purges killed
      // rows, so an unfiltered list grows without bound; this lets a caller
      // (store.ts's poll loop) ask for only the rows it actually renders.
      if (
        status !== undefined &&
        status !== "active" &&
        status !== "killed" &&
        status !== "exited"
      ) {
        return reply.badRequest("status must be 'active', 'killed', or 'exited'");
      }

      const conditions = [
        request.query.projectId !== undefined
          ? eq(sessions.projectId, Number(request.query.projectId))
          : undefined,
        kind !== undefined ? eq(sessions.kind, kind) : undefined,
        status !== undefined ? eq(sessions.status, status) : undefined,
      ].filter((c) => c !== undefined);

      const rows =
        conditions.length > 0
          ? app.db
              .select()
              .from(sessions)
              .where(and(...conditions))
              .all()
          : app.db.select().from(sessions).all();
      // Settings -> Notifications & status' "Idle threshold" (default 30s) —
      // read once per request, not per row.
      const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
      if (rows.length === 0) return [];

      // Batch by host so a remote agent gets exactly one bulkLiveStatus
      // call for this whole list, not one HTTP round trip per session (see
      // remote-host-client.ts's short-TTL cache for the same concern when
      // several requests like this land close together). Only the projects
      // these rows actually reference, not a full table scan.
      const projectIds = [...new Set(rows.map((row) => row.projectId))];
      const projectHostIds = new Map(
        app.db
          .select({ id: projects.id, hostId: projects.hostId })
          .from(projects)
          .where(inArray(projects.id, projectIds))
          .all()
          .map((p) => [p.id, p.hostId] as const),
      );
      const idsByHost = new Map<string, string[]>();
      for (const row of rows) {
        const hostId = projectHostIds.get(row.projectId) ?? LOCAL_HOST_ID;
        const ids = idsByHost.get(hostId) ?? [];
        ids.push(String(row.id));
        idsByHost.set(hostId, ids);
      }

      const liveByHost = new Map<string, Record<string, SessionInfo | null>>();
      await Promise.all(
        [...idsByHost.entries()].map(async ([hostId, ids]) => {
          try {
            liveByHost.set(
              hostId,
              await resolveBackend(app, hostId).liveStatus(ids, idleThresholdMs),
            );
          } catch (err) {
            app.log.warn(
              { hostId, err },
              "host unreachable, reporting default live status for its sessions",
            );
            liveByHost.set(hostId, Object.create(null));
          }
        }),
      );

      return rows.map((row) => {
        const hostId = projectHostIds.get(row.projectId) ?? LOCAL_HOST_ID;
        const info = liveByHost.get(hostId)?.[String(row.id)];
        return withLiveInfo(app, row, info, hostId);
      });
    },
  );

  // Phase 4 (#187) — single-session inspect, the REST endpoint
  // control-socket.ts's `sessions.get` op re-enters via app.inject(). Didn't
  // exist before this: every other reader (GET /api/sessions, PATCH,
  // promote) either lists or already has the row in hand from its own
  // mutation. Reuses withLiveStatus, the exact same row+live-status merge
  // POST/PATCH already return, rather than a bespoke shape.
  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
    const sessionId = Number(request.params.id);
    if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");

    const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
    if (!row) return reply.notFound();

    const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
    const hostId = resolveProjectHostId(app, row.projectId);
    return withLiveStatus(app, row, idleThresholdMs, hostId);
  });

  // Phase 4 (#187) — scrollback replay over REST, the counterpart to
  // /ws/terminal's own first-frame replay (Session.getScrollback(),
  // pty-manager.ts) for a caller that isn't opening a WebSocket at all (the
  // control socket's `sessions.scrollback` op, and the `mullion logs`/`ps`
  // CLI it backs). Deliberately non-spawning, unlike /ws/terminal's
  // getOrCreate: this session's dtach master may not be tracked by this
  // process's in-memory PtyManager yet (e.g. right after a restart, before
  // anything has re-attached) — a bare inspect must not have the side
  // effect of spawning/reattaching a program the caller only wanted to read
  // history from. Returns an empty `b64` in that case rather than 404,
  // matching GET /api/sessions' own "unreachable/untracked host reports
  // safe defaults, never errors" posture for a row that's otherwise
  // perfectly valid.
  //
  // Known, accepted tradeoff (code review, PR #398): this means the caller
  // can't tell "genuinely no scrollback yet" apart from "untracked" or
  // "host unreachable" — all three come back as the same empty `b64`. That
  // ambiguity mirrors GET /api/sessions' own per-row live-status defaults
  // (also indistinguishable from "really idle") rather than introducing a
  // new, scrollback-specific error signal; an operator who needs to tell
  // them apart has `app.log.warn` below and, separately, `alive`/
  // `sessionStatus` from GET /api/sessions/:id.
  app.get<{ Params: { id: string } }>("/api/sessions/:id/scrollback", async (request, reply) => {
    const sessionId = Number(request.params.id);
    if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");

    const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
    if (!row) return reply.notFound();

    const hostId = resolveProjectHostId(app, row.projectId);
    try {
      const buffer = await resolveBackend(app, hostId).getScrollback(String(sessionId));
      return { b64: buffer.toString("base64") };
    } catch (err) {
      app.log.warn({ err, sessionId, hostId }, "host unreachable, reporting empty scrollback");
      return { b64: "" };
    }
  });

  // Icebox item filed during Phase 5 (#230) planning — the genuine OS
  // subprocesses running inside this session's systemd scope/cgroup (MCP
  // servers, `Bash run_in_background` jobs, nested CLIs, dev servers not
  // otherwise detected). NOT subagent detection: Claude Code subagents run
  // in-process with no PID of their own (see agent-detect.ts). Same
  // "unreachable/untracked reports an empty result, never an error" posture
  // as the scrollback route above — a session that isn't currently running
  // just has zero processes, not an error.
  app.get<{ Params: { id: string } }>("/api/sessions/:id/processes", async (request, reply) => {
    const sessionId = Number(request.params.id);
    if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");

    const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
    if (!row) return reply.notFound();

    const hostId = resolveProjectHostId(app, row.projectId);
    try {
      return {
        processes: await resolveBackend(app, hostId).listSessionProcesses(String(sessionId)),
      };
    } catch (err) {
      app.log.warn({ err, sessionId, hostId }, "host unreachable, reporting empty process list");
      return { processes: [] };
    }
  });

  // Creates the DB row and spawns the session immediately (not lazily on
  // first WS attach) — "New Session" should mean "running now," matching
  // what a user watching a project's session list would expect to see.
  app.post<{ Body: CreateSessionBody }>(
    "/api/sessions",
    { schema: createSessionSchema },
    async (request, reply) => {
      const result = await createSessionRecord(app, request.body);
      if (!result.ok) {
        if (result.reason === "unknown-project") return reply.badRequest("Unknown projectId");
        if (result.reason === "worktree-failed") {
          // Issue #677 — surface the actual reason (e.g. "branch already
          // exists") when the backend supplied one, instead of always
          // showing the same generic message regardless of cause.
          return reply.badGateway(result.detail ?? "Failed to create worktree for this session");
        }
        if (result.reason === "unknown-parent") return reply.badRequest("Unknown parentSessionId");
        if (result.reason === "parent-wrong-project") {
          return reply.badRequest("parentSessionId must belong to the same project");
        }
        if (result.reason === "parent-is-child") {
          return reply.badRequest(
            "parentSessionId is itself a child session — only one level of nesting is allowed",
          );
        }
        if (result.reason === "cwd-outside-project") {
          return reply.badRequest("cwd must resolve inside the project directory");
        }
        if (result.reason === "child-cap-exceeded") {
          return reply.tooManyRequests("this session has reached its live child-session cap");
        }
        return reply.badGateway("Failed to spawn session on host");
      }

      reply.code(201);
      const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
      return withLiveStatus(app, result.row, idleThresholdMs, result.project.hostId);
    },
  );

  // Issue #271, option 2 — "promote an existing session": creates a
  // worktree, moves work into a NEW session there (same command as the
  // source, seeded with `seedPrompt` if given), and kills the source
  // session. Also resolves a pending agent-triggered `promote_request`
  // (app.pty.resolvePendingPromote) if one exists for this session — see
  // hooks.ts's pendingPromotes. Works identically for a human-initiated
  // promote (the SessionRow kebab menu), which never has one pending.
  //
  // Follow-up to #678 — `seedPrompt` alone only ever injected CONTEXT (a
  // hook-based agent's SessionStart `additionalContext`, or opencode's
  // static `instructions` file), never actually submitted a turn: the
  // replacement session landed idle with the summary loaded but invisible
  // until a human noticed and typed something. Mirrors the fix already
  // applied to Task Master's own worker/review-agent spawns
  // (task-agent-resolve.ts's commandSupportsSeed) — when the source
  // session's own command has a matched adapter with argv-based
  // `initialPromptArgs` (every registered adapter today: Claude Code,
  // Codex, agy, opencode), the seed is sent as `initialPrompt` instead, so
  // the replacement starts working immediately. Falls back to the old
  // context-only `seedPrompt` path for anything with no adapter at all
  // (`aider`, `gemini`, `pi`, or a plain shell) — never both; see the
  // `createSessionRecord` call below.
  app.post<{ Params: { id: string }; Body: PromoteSessionBody }>(
    "/api/sessions/:id/promote",
    { schema: promoteSessionSchema },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");

      const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
      if (!row) return reply.notFound();
      if (row.status !== "active") return reply.conflict("Session is not active");

      const [project] = app.db.select().from(projects).where(eq(projects.id, row.projectId)).all();
      if (!project) return reply.notFound();

      const { baseRef, branchName, seedPrompt } = request.body;
      const resolvedWorktree = await resolveWorktreeCwd(
        app,
        project.hostId,
        row.cwd ?? project.cwd,
        { baseRef, branchName },
        `promote-${sessionId}-${Date.now()}`,
      );
      if (!resolvedWorktree.created || !resolvedWorktree.path || !resolvedWorktree.branch) {
        // Issue #677 — surface the actual reason (e.g. "branch already
        // exists") when the backend supplied one, instead of always
        // showing the same generic "check that the base ref exists"
        // regardless of cause.
        return reply.badGateway(
          resolvedWorktree.detail ?? "Failed to create worktree for this session",
        );
      }
      const worktreePath = resolvedWorktree.path;

      // Never pass both `initialPrompt` and `seedPrompt`: for an adapter
      // with argv support, `initialPrompt` alone starts a real turn — also
      // setting `seedPrompt` would double-deliver the same text (e.g.
      // opencode would get it once via `--prompt` AND once via its static
      // `instructions` file; Claude Code once as the submitted turn AND
      // once as SessionStart `additionalContext`).
      const hasSeed = seedPrompt !== undefined && seedPrompt.length > 0;
      const deliverAsInitialPrompt = hasSeed && commandSupportsSeed(row.command);

      // Deliberately no `parentSessionId` — promote is a REPLACEMENT (this
      // creates the new session then kills `row` below), not a child. See
      // this file's own test asserting the promoted row's parentSessionId
      // stays null.
      const created = await createSessionRecord(app, {
        projectId: row.projectId,
        command: row.command,
        name: row.name ?? undefined,
        cwd: worktreePath,
        kind: row.kind,
        skipPermissions: row.skipPermissions ?? undefined,
        initialPrompt: deliverAsInitialPrompt ? seedPrompt : undefined,
        // Issue #678 — passed straight through rather than stashed here
        // AFTER createSessionRecord returns (the previous call site, and
        // the actual race this issue is about): createSessionRecord now
        // stashes it BEFORE spawning the new session, so it's guaranteed
        // present by the time a hook-based agent's SessionStart fires, and
        // also reaches opencode's own spawn-time delivery channel. Only
        // used as the context-only fallback now — see this handler's own
        // comment above for when `initialPrompt` is preferred instead.
        seedPrompt: hasSeed && !deliverAsInitialPrompt ? seedPrompt : undefined,
      });
      if (!created.ok) {
        // createSessionRecord's own spawn-failure rollback only fires for a
        // worktree IT created (its `worktree` intent param, unused here —
        // this route pre-resolves worktreePath itself, above, so cwd !==
        // params.cwd but `worktree` is undefined, and that guard never
        // fires). Without this, a failed spawn left the worktree AND its
        // branch on disk; a retry with the same (or default,
        // `mullion/session-<id>`) branch name then failed inside
        // `git worktree add -b` with "branch already exists" — surfacing as
        // the same generic "check that the base ref exists" the dialog
        // shows for a genuinely bad ref, with no way to tell the two apart.
        // Real try/catch (not `.catch(() => {})`, same footgun as
        // session-lifecycle.ts's own createSessionRecord catch block) —
        // RemoteBackend.removeWorktree/deleteBranch can throw synchronously.
        //
        // Hermes review, PR #680: removeWorktree alone only clears the
        // worktree DIRECTORY, never the branch (git-worktree.ts's own doc
        // comment — a worktree's branch is deliberately preserved for the
        // normal "→ done"/"→ failed" cleanup paths, which need it to
        // survive). Left un-deleted, a retry with the same explicit
        // branchName (or the default `mullion/session-<id>`) still failed
        // "branch already exists" even after this cleanup. Safe to force-
        // delete here specifically: `git worktree add -b` creates the
        // worktree and the branch atomically, and this only runs when the
        // very next step (spawn) failed — no agent, no commit, ever
        // touched it.
        const backend = resolveBackend(app, project.hostId);
        try {
          await backend.removeWorktree(worktreePath, row.cwd ?? project.cwd);
        } catch {
          // Best-effort: a leaked worktree directory is the cheaper failure.
        }
        try {
          await backend.deleteBranch(row.cwd ?? project.cwd, resolvedWorktree.branch, {
            force: true,
          });
        } catch {
          // Best-effort, same posture as removeWorktree above.
        }
        return reply.badGateway("Failed to spawn the promoted session");
      }

      // Collected as a non-fatal `warnings` entry on the 201 response (same
      // posture as the resolvePendingPromote block below, and Task Master's
      // own `initialPromptApplied` handling in task-claim.ts): a working
      // replacement session either way, just with a note that one
      // side-effect didn't land.
      const warnings: string[] = [];
      // `initialPromptApplied` can come back `false` for a version-skewed
      // remote agent (an older host build without this fix) — the seed was
      // requested as a first turn but the replacement's own spawn reported
      // it wasn't actually submitted, so it's sitting idle exactly like the
      // symptom this whole change fixes. `undefined` (no `initialPrompt`
      // was requested at all — either no seed, or this adapter has none)
      // and `true` both need no warning.
      if (deliverAsInitialPrompt && created.initialPromptApplied === false) {
        warnings.push(
          "The promoted session is running, but its seed prompt could not be submitted as a first turn — it may be sitting idle until you send it a message.",
        );
      }

      // Issue #679 — the new session already exists and is running by this
      // point; a failure here (a remote host that's unreachable or rejects
      // the request) must not turn a genuinely successful promote into a
      // bare 500, and must not skip killing the source session below either
      // — resolvePendingPromote only clears the agent's own blocked
      // `promote_request` MCP tool call, an entirely separate concern from
      // whether the promote itself succeeded. Same HostRequestError-vs-
      // everything-else log split as session-lifecycle.ts's own
      // logPreviewWorktreeHostError — a rejection means the agent is up and
      // said no (persistent), unlike an unreachable host (possibly
      // transient).
      try {
        await resolveBackend(app, project.hostId).resolvePendingPromote(String(sessionId), {
          decision: "accepted",
          worktreePath,
          newSessionId: created.row.id,
        });
      } catch (err) {
        if (err instanceof HostRequestError) {
          app.log.warn(
            { hostId: project.hostId, sessionId, err },
            "resolvePendingPromote: host rejected the request",
          );
        } else {
          app.log.warn(
            { hostId: project.hostId, sessionId, err },
            "resolvePendingPromote: host unreachable",
          );
        }
        warnings.push(
          "The promoted session is running, but the source session's pending promote request could not be resolved on its host.",
        );
      }

      // Explicit "detach" (the default): this is the replacement's own
      // source session, which never has parentSessionId set (a promoted
      // row keeps no lineage of its own), so cascade has nothing to act on
      // here regardless — spelled out for clarity, not because it changes
      // behavior. Always runs, even when resolvePendingPromote above failed
      // — see this block's own comment for why the two are independent.
      await killSession(app, sessionId, "detach");

      reply.code(201);
      const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
      const liveStatus = await withLiveStatus(app, created.row, idleThresholdMs, project.hostId);
      return warnings.length > 0 ? { ...liveStatus, warnings } : liveStatus;
    },
  );

  // Declines a pending agent-triggered promote request without creating
  // anything — the model's `promote_to_worktree` MCP tool call unblocks with
  // a "declined" result and the agent continues on the main checkout.
  app.post<{ Params: { id: string }; Body: DeclinePromoteBody }>(
    "/api/sessions/:id/promote/decline",
    { schema: declinePromoteSchema },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");

      const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
      if (!row) return reply.notFound();

      const hostId = resolveProjectHostId(app, row.projectId);
      const ok = await resolveBackend(app, hostId).resolvePendingPromote(String(sessionId), {
        decision: "declined",
        reason: request.body.reason,
      });
      if (!ok) return reply.conflict("No promote request is currently pending for this session");
      reply.code(204);
    },
  );

  app.patch<{ Params: { id: string }; Body: RenameSessionBody }>(
    "/api/sessions/:id",
    { schema: renameSessionSchema },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");

      const updated = app.db
        .update(sessions)
        // nameLocked pins this title against live OSC title updates (issue
        // #69) — only an explicit rename through this route sets it; a
        // launch-time name pattern (CommandPalette) never does.
        .set({ name: request.body.name, nameLocked: true })
        .where(eq(sessions.id, sessionId))
        .returning()
        .all();
      if (updated.length === 0) return reply.notFound();
      const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
      const hostId = resolveProjectHostId(app, updated[0].projectId);
      return withLiveStatus(app, updated[0], idleThresholdMs, hostId);
    },
  );

  // Issue #178 — delivers a human decision to a pending review gate, routed
  // (via resolveBackend, same as terminate/uploadImage) to whichever host
  // actually holds the open hook connection. 409, not 404/500, when nothing
  // is pending: the session and its host are both perfectly valid, there's
  // just no gate left to answer (already resolved, timed out, or the
  // connection died — see hooks.ts's resolvePendingGate).
  app.post<{ Params: { id: string }; Body: ReviewGateBody }>(
    "/api/sessions/:id/review-gate",
    { schema: reviewGateSchema },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");

      const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
      if (!row) return reply.notFound();

      const hostId = resolveProjectHostId(app, row.projectId);
      const { decision, reason } = request.body;
      let ok: boolean;
      try {
        ok = await resolveBackend(app, hostId).resolveReviewGate(
          String(sessionId),
          decision,
          reason,
        );
      } catch (err) {
        app.log.error({ err, sessionId, hostId }, "review-gate decision failed to reach host");
        return reply.badGateway("Failed to deliver decision to host");
      }
      if (!ok) return reply.conflict("No review is currently pending for this session");
      reply.code(204);
    },
  );

  // Issue #404 — accepts a plain session's detected dev-server offer: wires
  // the ALREADY-RUNNING server into the project's preview rather than
  // spawning a second copy of it (see the design note in the linked issue —
  // a `kind: "dock"` session running the same dock-control command would
  // collide on the port). Local-only by construction: detection
  // (PtyManager.sweepDevServerDetection) only ever runs for sessions this
  // process's own app.pty tracks, i.e. a local-hosted project's session —
  // app.pty.get() below simply won't find anything for a remote one.
  app.post<{ Params: { id: string }; Body: DevServerActionBody }>(
    "/api/sessions/:id/dev-server/accept",
    { schema: devServerActionSchema },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");

      const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
      if (!row) return reply.notFound();

      const { port } = request.body;
      // Validated BEFORE acceptDevServerPort mutates any state: the schema's
      // `^\d{1,5}$` pattern lets "0" and "99999" through (parseDevServerPort
      // itself can capture "0" from a malformed banner), both of which fail
      // isValidDevServerUrl's 1-65535 range check — catching that here,
      // ahead of the session-state mutation and event emission below, keeps
      // a rejected request from ALSO silently clearing the session's
      // pendingDevServerPort (which would otherwise let a corrupt/edge-case
      // port slip through with no way to retry the accept for a real one).
      if (!isValidDevServerUrl(port)) return reply.badRequest("Invalid port");

      const accepted = app.pty.acceptDevServerPort(String(sessionId), port);
      if (!accepted) {
        return reply.conflict("No pending dev-server offer for this port on this session");
      }

      // The bare port, not a full URL — the canonical minimal form
      // isValidDevServerUrl/the manual PATCH /api/projects path both accept
      // (schema.ts's devServerUrl doc comment).
      //
      // Guarded on devServerUrl still being null: eligibility for detection
      // is per-PROJECT (findEligibleDevServerSessions filters on
      // devServerUrl IS NULL), but dedup/offer state is per-SESSION — a
      // project with two plain sessions (e.g. two dev servers in a
      // monorepo) can have both independently latch a pending offer before
      // either is accepted. Without this guard, accepting the second
      // offer after the first already won would silently overwrite the
      // project's devServerUrl out from under it. Zero affected rows means
      // some other accept already set it first — a 409 lets the frontend
      // tell the user their sibling offer is now stale, rather than
      // silently swapping the port on them.
      const updated = app.db
        .update(projects)
        .set({ devServerUrl: port })
        .where(and(eq(projects.id, row.projectId), isNull(projects.devServerUrl)))
        .run();
      if (updated.changes === 0) {
        return reply.conflict(
          "This project's devServerUrl was already set by another accepted offer",
        );
      }

      // Previews are an opt-in feature (PREVIEW_BASE_HOST unset registers no
      // /api/previews routes at all — see routes/previews.ts) — a no-op here
      // for that half, never an error, while the devServerUrl patch above
      // still lands regardless.
      const preview =
        app.config.PREVIEW_BASE_HOST.trim() === ""
          ? null
          : getOrCreateProjectPreview(app, row.projectId);
      return { devServerUrl: port, preview };
    },
  );

  app.post<{ Params: { id: string }; Body: DevServerActionBody }>(
    "/api/sessions/:id/dev-server/dismiss",
    { schema: devServerActionSchema },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");

      const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
      if (!row) return reply.notFound();

      const { port } = request.body;
      const dismissed = app.pty.dismissDevServerPort(String(sessionId), port);
      if (!dismissed) {
        return reply.conflict("No pending dev-server offer for this port on this session");
      }
      reply.code(204);
    },
  );

  // Issue #68: a pasted/attached image can't travel the terminal's own byte
  // stream (no Sixel/Kitty/iTerm2 support, and the CLI in the PTY couldn't
  // read inline image bytes off stdin even if it could parse them) — this
  // takes the image over an ordinary HTTP request instead, writes it under
  // the session's own cwd (on whichever host actually runs its CLI — see
  // resolveBackend/uploadImage), and returns that path for the frontend to
  // inject into the terminal exactly like a paste. Scoped to this plugin's
  // own encapsulated context, so it never affects how any other route file
  // parses its own request bodies.
  app.addContentTypeParser(/^image\//, { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/uploads",
    { bodyLimit: MAX_UPLOAD_BYTES },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");

      const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
      if (!row) return reply.notFound();
      const [project] = app.db.select().from(projects).where(eq(projects.id, row.projectId)).all();
      if (!project) return reply.notFound();

      // Hermes review (PR #106): a bare exact-key match against the raw
      // header would 400 a real image whose Content-Type happens to carry a
      // `; charset=...` (or other) parameter — browsers send bare blob
      // types today, but stripping params costs nothing and removes the
      // footgun.
      const rawContentType = request.headers["content-type"];
      const mime = rawContentType?.split(";")[0]?.trim();
      if (!mime || !extensionForMime(mime)) {
        return reply.badRequest(`Unsupported image type: ${rawContentType ?? "(missing)"}`);
      }
      if (!Buffer.isBuffer(request.body)) return reply.badRequest("expected a raw image body");
      // Content check, not just Content-Type: rejects a body whose actual
      // leading bytes don't match the claimed image format — a client can't
      // smuggle arbitrary content onto disk under an image mime type.
      if (!matchesMagicBytes(request.body, mime)) {
        return reply.badRequest("File content does not match the declared image type");
      }

      try {
        return await resolveBackend(app, project.hostId).uploadImage(
          row.cwd ?? project.cwd,
          request.body,
          mime,
        );
      } catch (err) {
        // Same posture as createSessionRecord's own spawn-rollback catch
        // (session-lifecycle.ts, reached via POST /api/sessions): an
        // unreachable host or an agent-side rejection is a gateway
        // failure, never a 500 — there's no row here to roll back.
        app.log.error({ err, sessionId, hostId: project.hostId }, "session image upload failed");
        return reply.badGateway("Failed to upload image to host");
      }
    },
  );

  // Phase 3, issue #182 — returns the browser pane(s) a session is bound to
  // (recorded by routes/browser.ts's attachSocketToBrowser on each
  // /ws/browser/:sessionId connect). Empty array is the common case: most
  // sessions never open a browser pane.
  app.get<{ Params: { id: string } }>("/api/sessions/:id/browser", async (request, reply) => {
    const sessionId = Number(request.params.id);
    if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");

    const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
    if (!row) return reply.notFound();

    return listSessionBrowserBindings(app, sessionId);
  });

  // Fully ends the session (attach-client, dtach master, and the program
  // itself — see PtyManager.terminate()) and marks the row killed rather
  // than deleting it, so it still shows in history/list. A killed session
  // can never be re-attached (terminal.ts's preValidation rejects it), so
  // leaving the master running would just orphan it forever.
  //
  // Phase 5 (Track B, issue #196 5.6) — `?cascade=detach|kill` (default
  // detach), NOT a request body: sessions.kill (control-socket.ts) proxies
  // this exact route via app.inject(), and a DELETE-with-body is awkward to
  // carry through that path — a querystring works identically from both
  // REST and the socket.
  app.delete<{ Params: { id: string }; Querystring: { cascade?: "detach" | "kill" } }>(
    "/api/sessions/:id",
    { schema: deleteSessionSchema },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");

      const updated = await killSession(app, sessionId, request.query.cascade ?? "detach");
      if (!updated) return reply.notFound();

      reply.code(204);
    },
  );
}
