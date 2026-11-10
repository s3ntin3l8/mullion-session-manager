import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { compareWorktreePaths } from "../services/worktree-paths.js";
import { renderScrollback } from "../services/scrollback-render.js";
import {
  DEFAULT_LIMIT as DEFAULT_TRANSCRIPT_LIMIT,
  readSessionTranscript,
} from "../services/session-transcript.js";
import { expandHome } from "../services/project-config.js";
import { compileOutputMatcher, waitForOutput } from "../services/output-wait.js";
import { deliverPrompt, REMOTE_WAIT_CHUNK_MS } from "../services/session-prompt.js";
import {
  rememberSessionBrowserTarget,
  sessionBrowserTarget,
  forgetSessionBrowserTarget,
  touchSessionBrowserTarget,
} from "../services/session-browser-targets.js";
import type { SessionInfo } from "../services/pty-manager.js";
import { adapterHasInitialPromptArgs } from "../services/hook-adapters/index.js";
import { explicitModelError } from "../services/task-model-resolve.js";
import { setSessionGithubAuth, type SessionGithubAuth } from "../services/session-github-token.js";
import {
  SESSION_ID_PARAMS_SCHEMA,
  spawnSessionSchema,
  sessionGithubAuthSchema,
  liveStatusSchema,
  livenessSchema,
  terminateSchema,
  promptSchema,
  waitOutputSchema,
  type PromptBody,
  type WaitOutputBody,
  reviewGateSchema,
  promoteDecisionSchema,
} from "./internal-schemas.js";
import type {
  SpawnSessionBody,
  LiveStatusBody,
  LivenessBody,
  ReviewGateBody,
  PromoteDecisionBody,
} from "./internal-schemas.js";
import { INTERNAL_RATE_LIMIT } from "./internal-rate-limits.js";
import { resolveWithinRoots } from "./internal-roots.js";

/**
 * The agent's sessions and worktree comparison routes. Registered from `internalRoutes` so they sit
 * behind its auth hook and share its rate limits.
 */
export function registerSessionRoutes(app: FastifyInstance): void {
  // Mirrors POST /api/sessions' "create the row and spawn immediately" — an
  // agent has no row to create, just the spawn half. Idempotent the same way
  // app.pty.getOrCreate always is: calling this again for an id already
  // tracked in this process's memory is a no-op beyond respawning a dead
  // attach-client, same as a fresh /internal/ws/attach would do.
  app.post<{ Body: SpawnSessionBody }>(
    "/internal/sessions",
    { ...INTERNAL_RATE_LIMIT, schema: spawnSessionSchema },
    async (request, reply) => {
      const {
        id,
        cwd,
        command,
        cols,
        rows,
        skipPermissions,
        initialPrompt,
        seedPrompt,
        projectId,
        env,
        briefingOverride,
        workflowConventionsText,
        projectSkill,
        projectReviewerAgent,
        injectAgentGuide,
        injectProjectBriefing,
        // Issue #1089 — see CreateSessionOptions.injectMullionBundle's own
        // doc comment (pty-manager.ts). Forwarded verbatim to getOrCreate
        // below, same as injectAgentGuide/injectProjectBriefing — this is
        // the fix: before it, getOrCreate() ignored an explicit
        // opts.injectMullionBundle entirely and always fell back to this
        // agent's own DB-less getInjectMullionBundle() closure (always
        // `true`), no matter what the primary's actual stored setting was.
        injectMullionBundle,
        // Task Master marker — see CreateSessionOptions.taskId's own doc
        // comment (pty-manager.ts). Forwarded verbatim to getOrCreate
        // below; the opencode and codex adapters read it back off the
        // resulting Session at applyHookAdapters time and use it to deny
        // superpowers skills that gate on a human in the loop.
        // Hermes review, PR #966 — version-skewed, same posture as
        // `initialPromptApplied` below: an older agent build (one that
        // pre-dates the taskId field) strips this from the request body
        // before the handler runs (Fastify's `removeAdditional` with the
        // `additionalProperties: false` declared by spawnSessionSchema),
        // so `taskId` here is `undefined` for that case — the resulting
        // Session therefore has `taskId: undefined`, the adapter sees no
        // denial list, and the primary learns this via the
        // `taskIdApplied` echo (below) being `false`.
        taskId,
        // The resolved git identity — see CreateSessionOptions.gitIdentity.
        // An older agent build strips it (additionalProperties: false) and
        // the session simply commits with the host's own identity.
        gitIdentity,
        // Issue #2639 — the session's browser target, resolved on the primary
        // (kept by session-browser-targets.ts, not on the Session).
        browserTarget,
        // #2246 — the session's GitHub credential; getOrCreate stores it in
        // this agent's memory (session-github-token.ts) and never persists it.
        githubAuth,
        // Issue #1337 — opencode model overrides forwarded from spawn_child_session
        // MCP tool. When omitted, the parent session's model/smallModel are inherited
        // by the POST /api/sessions route handler (server-side fallback).
        model,
        smallModel,
      } = request.body;
      // Issue #1423 — defense in depth. The primary has already validated
      // these (POST /api/sessions), so this only matters if a compromised
      // or buggy primary, or a direct caller, reaches this agent-side route
      // directly with an unvalidated value.
      if (model !== undefined) {
        const err = explicitModelError(command, "model", model);
        if (err) return reply.badRequest(err);
      }
      if (smallModel !== undefined) {
        const err = explicitModelError(command, "smallModel", smallModel);
        if (err) return reply.badRequest(err);
      }
      const session = app.pty.getOrCreate({
        id,
        cwd: expandHome(cwd),
        command,
        cols,
        rows,
        skipPermissions,
        initialPrompt,
        seedPrompt,
        projectId,
        env,
        briefingOverride,
        workflowConventionsText,
        projectSkill,
        projectReviewerAgent,
        injectAgentGuide,
        injectProjectBriefing,
        injectMullionBundle,
        taskId,
        gitIdentity,
        githubAuth,
        model,
        smallModel,
      });
      rememberSessionBrowserTarget(app.pty, id, browserTarget, app.config.SESSIONS_DIR);
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
      // Issue #884 — same "echoed back, not assumed" posture as
      // initialPromptApplied above, read straight off the resulting Session
      // rather than the request body: a session id this process already
      // tracked (a reattach, not a fresh spawn) keeps its ORIGINAL
      // spawn-time values, which may differ from what this request asked
      // for — see LocalBackend.spawn's identical comment (session-backend.ts).
      // Hermes review, PR #966 — same posture for `taskId`. An old agent
      // build that pre-dates this field strips it before the handler
      // runs, the resulting Session has `taskId: undefined`, and the
      // primary learns this via `taskIdApplied: false` (the field
      // itself is still present, unlike initialPromptApplied's
      // deliberate-omission posture — `false` here is the right value
      // because the OPENCODE_CONFIG_CONTENT it produces is itself a
      // known-shape object, never omitted). Forwarded through
      // RemoteBackend.spawn's SpawnResult (session-backend.ts) so the
      // primary's task-claim / task-reconciler / task-reseed sites can
      // log a version-skew warning exactly like the injectAgentGuide
      // loop in session-lifecycle.ts does (see createSessionRecord's
      // own comment).
      return {
        ok: true,
        initialPromptApplied: initialPrompt !== undefined && adapterHasInitialPromptArgs(command),
        injectAgentGuide: session.injectAgentGuide,
        injectProjectBriefing: session.injectProjectBriefing,
        // Issue #1089 — same "echoed back, not assumed" posture as
        // injectAgentGuide/injectProjectBriefing immediately above, read
        // straight off the resulting Session for the same reattach-keeps-
        // original-values reason those two are.
        injectMullionBundle: session.injectMullionBundle,
        taskIdApplied: taskId !== undefined && session.taskId === taskId,
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
  // as services/session-live-info.ts's withLiveStatus falls back to for app.pty.get
  // returning undefined.
  app.post<{ Body: LiveStatusBody }>(
    "/internal/sessions/live",
    { ...INTERNAL_RATE_LIMIT, schema: liveStatusSchema },
    async (request) => {
      // `sessionProjectIds` is still accepted (an older primary sends it) but
      // no longer read: a project id cannot tell which checkout's browser a
      // session is looking at.
      const { ids, idleThresholdMs } = request.body;
      // Use Map to store key-value pairs (prototype injection safe), then
      // convert to a null-prototype object using Object.fromEntries(..., null).
      // This satisfies the CodeQL remote property injection scanner while
      // ensuring serialized JSON keys have no inherited setters to hijack.
      const result = new Map<string, SessionInfo | null>();
      for (const id of ids) {
        const info = app.pty.get(id)?.toInfo(idleThresholdMs) ?? null;
        // Issue #2639 — only the browser of the session's OWN target (the one
        // the primary sent at spawn), never another checkout's page: a URL can
        // carry tokens or query secrets. A session with no target, or whose
        // target has no running browser, reports nothing.
        const target = sessionBrowserTarget(id, app.config.SESSIONS_DIR);
        // Seen alive: keeps a long-running session's target out of the prune.
        if (info && target) touchSessionBrowserTarget(id, app.config.SESSIONS_DIR);
        if (info && app.browserEnabled && target) {
          const managed = app.browser.get(target);
          if (managed?.browser.isConnected()) {
            try {
              info.browserUrl = managed.page.url();
            } catch {
              // Best-effort
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

  // Resolve path identity on the owning host. Unknown/out-of-root paths never
  // become a negative match, and the response contains no filesystem data.
  app.post<{ Body: { target: string; candidates: { id: string; cwd: string | null }[] } }>(
    "/internal/worktrees/compare-paths",
    {
      ...INTERNAL_RATE_LIMIT,
      schema: {
        body: {
          type: "object",
          required: ["target", "candidates"],
          additionalProperties: false,
          properties: {
            target: { type: "string", minLength: 1, maxLength: 4096 },
            candidates: {
              type: "array",
              maxItems: 256,
              items: {
                type: "object",
                required: ["id", "cwd"],
                additionalProperties: false,
                properties: {
                  id: { type: "string", maxLength: 128 },
                  cwd: { type: ["string", "null"], maxLength: 4096 },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const generation = () =>
        createHash("sha256")
          .update(
            JSON.stringify(
              app.pty
                .list()
                .map(({ id, liveCwd }) => [id, liveCwd])
                .sort(([a], [b]) => String(a).localeCompare(String(b))),
            ),
          )
          .digest("hex");
      const before = generation();
      const relations = await compareWorktreePaths(
        request.body.target,
        request.body.candidates.map((candidate) => ({
          ...candidate,
          // The project mapping can change after spawn. Only the agent's
          // immutable session cwd is authoritative when the row has none.
          cwd: candidate.cwd ?? app.pty.get(candidate.id)?.cwd ?? null,
        })),
        (candidate) => resolveWithinRoots(app, candidate) !== null,
        (id) => app.pty.get(id)?.liveCwd ?? null,
      );
      const after = generation();
      return { generation: after, stable: before === after, relations };
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
      forgetSessionBrowserTarget(request.params.id, app.config.SESSIONS_DIR);
      reply.code(204);
    },
  );

  // #2246 — the primary re-sending a session's App token before it expires.
  // Accepts any valid id, tracked or not: the store is memory-only, an agent
  // restart (sessions survive it) empties it, and the next refresh is what
  // refills it. Expired entries are pruned on every set.
  app.put<{ Params: { id: string }; Body: SessionGithubAuth }>(
    "/internal/sessions/:id/github-auth",
    { ...INTERNAL_RATE_LIMIT, schema: sessionGithubAuthSchema },
    async (request, reply) => {
      setSessionGithubAuth(request.params.id, request.body);
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
  app.get<{ Params: { id: string }; Querystring: { mode?: string } }>(
    "/internal/sessions/:id/scrollback",
    {
      ...INTERNAL_RATE_LIMIT,
      schema: {
        params: SESSION_ID_PARAMS_SCHEMA,
        querystring: {
          type: "object",
          properties: { mode: { type: "string", enum: ["raw", "rendered"] } },
        },
      },
    },
    async (request) => {
      const session = app.pty.get(request.params.id);
      // Issue #2112 — `mode=rendered`: the screen as plain text, rendered here
      // where the PTY's real size is known.
      if (request.query.mode === "rendered") {
        return {
          text: session
            ? await renderScrollback(session.getRenderableScrollback(), session.size)
            : "",
        };
      }
      return { b64: session ? session.getScrollback().toString("base64") : "" };
    },
  );

  // Issue #2268 — the agent-side counterpart of GET /api/sessions/:id/transcript:
  // the transcript file lives on this host, so this agent reads it. Answers a
  // TranscriptResult as a 200 either way (`ok: false` carries the status the
  // primary should report), like /internal/sessions/:id/prompt's refusals.
  app.get<{
    Params: { id: string };
    Querystring: { afterSeq?: number; limit?: number; tools?: string };
  }>(
    "/internal/sessions/:id/transcript",
    {
      ...INTERNAL_RATE_LIMIT,
      schema: {
        params: SESSION_ID_PARAMS_SCHEMA,
        querystring: {
          type: "object",
          properties: {
            afterSeq: { type: "integer", minimum: 0 },
            limit: { type: "integer", minimum: 1, maximum: 500 },
            tools: { type: "string", enum: ["0", "1"] },
          },
        },
      },
    },
    async (request) =>
      readSessionTranscript(app.pty.get(request.params.id), {
        afterSeq: request.query.afterSeq ?? 0,
        limit: request.query.limit ?? DEFAULT_TRANSCRIPT_LIMIT,
        fullTools: request.query.tools === "1",
      }),
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
        params: SESSION_ID_PARAMS_SCHEMA,
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
        params: SESSION_ID_PARAMS_SCHEMA,
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
      const { decision, reason, gateId } = request.body;
      const ok = app.resolveHookGate(request.params.id, gateId, decision, reason);
      return { ok };
    },
  );

  // Issue #1472 — the agent-side counterpart of
  // POST /api/sessions/:id/attention/ack, for a remote-hosted session.
  // Mirrors /internal/sessions/:id/review-gate's shape (`{ok}`, not a bare
  // 204) for the same reason: `false` is a genuine, expected outcome (a
  // blocking kind is still pending, or this agent doesn't track the id at
  // all — see PtyManager.acknowledgeAttention's own doc comment), not an
  // error. A successful ack here also fires this agent's own "attention"
  // NotificationEvent (AttentionTracker.acknowledgeAttention) exactly as it
  // would for a local session; that event already reaches a browser
  // connected to the primary unchanged, via the existing byte-for-byte
  // /internal/ws/events relay (routes/events.ts's relayRemoteEventsHost) —
  // no new plumbing needed for the badge to clear.
  app.post<{ Params: { id: string } }>(
    "/internal/sessions/:id/attention/ack",
    { ...INTERNAL_RATE_LIMIT, schema: { params: SESSION_ID_PARAMS_SCHEMA } },
    async (request) => {
      const ok = app.pty.acknowledgeAttention(request.params.id);
      return { ok };
    },
  );

  // Issue #1951 — the agent-side half of `sessions.prompt` for a child
  // whose PTY lives on THIS host. The primary has already decided typing is
  // wise (the derived status is not blocked/gone) and enforced the size and
  // sanitization rules; this only runs the delivery against the local
  // PtyManager (services/session-prompt.ts, the same code a local child
  // uses). A refusal is HTTP 422 carrying `{status, error}` — the status the
  // primary should surface — because RemoteHostClient.request() discards the
  // body of a 5xx, and the real answer ("not running", "no prompt framing
  // for that agent", "backpressure") must survive the hop.
  app.post<{ Params: { id: string }; Body: PromptBody }>(
    "/internal/sessions/:id/prompt",
    { ...INTERNAL_RATE_LIMIT, schema: promptSchema },
    async (request, reply) => {
      const delivery = await deliverPrompt(app, request.params.id, {
        text: request.body.text,
        submit: request.body.submit,
        notRunning: "the session is not running on its host",
      });
      if (!delivery.ok) {
        reply.code(422);
        return { status: delivery.status, error: delivery.error };
      }
      // `afterSeq` (issue #1962): the event head right after the turn began,
      // which arms the primary's "a new turn started" guard for `wait`.
      return { outputOffset: delivery.outputOffset, afterSeq: delivery.afterSeq };
    },
  );

  // Issue #1951 — the agent-side half of `sessions.wait_for_output`: ONE
  // bounded wait against the local PTY. The primary loops over these
  // (SessionBackend.waitOutput), so this bounds a single call and gives up its
  // PTY subscription as soon as the request goes away — an agent never holds
  // a listener for an hour on behalf of a primary that has stopped caring.
  app.post<{ Params: { id: string }; Body: WaitOutputBody }>(
    "/internal/sessions/:id/wait-output",
    { ...INTERNAL_RATE_LIMIT, schema: waitOutputSchema },
    async (request, reply) => {
      // An explicit upper bound on the wait, rejected rather than clamped: the
      // primary never asks for more than one chunk (SessionBackend.waitOutput
      // loops), so a longer request is not a legitimate caller, and a timer
      // length taken from a request body must be visibly bounded.
      if (request.body.timeoutMs > REMOTE_WAIT_CHUNK_MS) {
        reply.code(422);
        return { status: 400, error: `'timeoutMs' exceeds ${REMOTE_WAIT_CHUNK_MS}` };
      }
      const matcher = compileOutputMatcher(request.body.match, request.body.regex);
      if (!matcher.ok) {
        reply.code(422);
        return { status: 400, error: matcher.error };
      }
      const session = app.pty.get(request.params.id);
      if (!session || !session.isAlive) return { notRunning: true };
      const controller = new AbortController();
      // `reply.raw`, not `request.raw`: the REQUEST message emits `close` as
      // soon as its body has been consumed (Node >= 16), which is before this
      // handler even runs — aborting on it would cancel every wait at once.
      // The RESPONSE closes when the connection does; `writableFinished`
      // separates "we already answered" from "the requester hung up".
      const onClose = () => {
        if (!reply.raw.writableFinished) controller.abort();
      };
      reply.raw.once("close", onClose);
      try {
        const result = await waitForOutput(matcher, request.body.timeoutMs, {
          signal: controller.signal,
          onData: (listener) => session.onData((chunk) => listener(Buffer.from(chunk))),
          ...(request.body.afterOffset !== undefined
            ? { seed: session.getOutputSince(request.body.afterOffset) }
            : {}),
          alive: () => session.isAlive,
        });
        // The requester hung up: nobody to answer.
        if ("aborted" in result) return reply.code(499).send();
        return { ...result, outputOffset: session.outputOffset };
      } finally {
        reply.raw.off("close", onClose);
      }
    },
  );
}
