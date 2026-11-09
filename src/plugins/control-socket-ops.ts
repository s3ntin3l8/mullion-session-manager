import { resolveAndAttach } from "../routes/terminal.js";
import { attachAggregatedEventsSocket, attachLocalEventsSocket } from "../routes/events.js";
import { SocketChannel } from "../services/socket-channel.js";
import { and, eq } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import { crossProjectAllowed } from "../services/cross-project.js";
import { DEFAULT_MESSAGE_TTL_MS, provenanceLabel } from "../services/session-message-queue.js";
import { compileOutputMatcher } from "../services/output-wait.js";
import { parseWaitTimeout } from "../services/session-wait.js";
import {
  CONTROL_SOCKET_VIA_HEADER,
  CONTROL_SOCKET_VIA_TOKEN,
} from "../services/internal-request.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { resolveBackend } from "../services/session-backend.js";
import { deliverPrompt } from "../services/session-prompt.js";
import { adoptSurvivingSession } from "../services/session-adopt.js";
import { MAX_PROMPT_BYTES, sanitizePromptText } from "../services/hook-adapters/shared.js";
import {
  extractIdField,
  sessionRowIsActive,
  childSessionIds,
  ownAndChildSessionFilter,
  resolveTargetSessionId,
  resolveOwnedSessionId,
  resolveEventsSessionFilter,
  resolveParentSessionId,
  resolveTargetProjectId,
} from "../services/control-session-authority.js";
import type { OpContext, OpSpec, ReplyPayload, Route, Scope } from "./control-socket-core.js";
import {
  STREAM_UNAVAILABLE,
  bad,
  buildAuthHeaders,
  buildQueryUrl,
  injectAndShape,
  injectRoute,
  json,
  jsonHeaders,
  requireChannel,
  streamSlotError,
  MAX_WAITS_PER_CONNECTION,
} from "./control-socket-core.js";
import type { WaitBodyOpts } from "./control-socket-support.js";
import {
  CROSS_PROJECT_DISABLED,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGE_TTL_SECONDS,
  MESSAGES_PER_MINUTE,
  MESSAGE_REFUSED,
  NOT_LOCAL_MESSAGE,
  SESSION_SPAWN_CHILD_FIELDS,
  adoptLocalChild,
  allowedSpawnTargets,
  childHostId,
  describeMessage,
  enc,
  messageRefusal,
  messageState,
  parseWaitBody,
  projectCoordinates,
  refuseIfBlockedOrGone,
  relayQuery,
  relayTargetFields,
  resolveSpawnTarget,
  runWait,
} from "./control-socket-support.js";

type ResolveFn = (ctx: OpContext) => Route | ReplyPayload | Promise<Route | ReplyPayload>;

/**
 * A resolver that has DECLARED how it relates to session scope — the tagged
 * union `routeOp` requires for any op listing "session" in its scopes:
 *  - `pinned`: the resolver verifies the request's target against the
 *    connection's own session/project pin (resolveTargetSessionId & co).
 *  - `unscoped`: the target is deliberately NOT pinned to the connection
 *    (a host-global read, or an explicit resource id by design) — a
 *    reviewed, greppable opt-out rather than an accident.
 *  - `owned`: the target may be the connection's own session OR a child it
 *    spawned (resolveOwnedSessionId) — wider than `pinned`, but still
 *    bounded by the parent_session_id relationship, never an arbitrary id.
 * `routeOp`'s full-only overload also takes a bare function, because
 * `injectRoute` already structurally enforces full scope there; the
 * session-reachable overload does not, so an op can't list "session" with a
 * resolver that silently pins nothing (#1546).
 */
export interface DeclaredResolver {
  readonly target: "pinned" | "unscoped" | "owned";
  readonly run: ResolveFn;
}

/** Declares that `run` pins its target to the connection's own session/project. */
export const pinned = (run: ResolveFn): DeclaredResolver => ({ target: "pinned", run });

/** Declares that `run` deliberately does not pin its target. */
export const unscoped = (run: ResolveFn): DeclaredResolver => ({ target: "unscoped", run });

/** Declares that `run` limits its target to the connection's own session or
 * one of that session's children (resolveOwnedSessionId). */
export const owned = (run: ResolveFn): DeclaredResolver => ({ target: "owned", run });

type FullOnlyScopes = readonly ["full"];
type SessionReachableScopes =
  readonly ["full", "session"] | readonly ["session", "full"] | readonly ["session"];

/**
 * Declarative request/response op: `resolve` turns the request into either a
 * `Route` to forward or an early `ReplyPayload` (validation / pin failure).
 * The runner picks `injectRoute` for full-scope-only ops (structural
 * enforcement) and `injectAndShape` for ops that list "session" — whose
 * resolver the type system forces to be declared `pinned`/`unscoped`.
 */
export function routeOp(scopes: FullOnlyScopes, resolve: ResolveFn | DeclaredResolver): OpSpec;
export function routeOp(scopes: SessionReachableScopes, resolve: DeclaredResolver): OpSpec;
export function routeOp(scopes: readonly Scope[], resolve: ResolveFn | DeclaredResolver): OpSpec {
  const fullOnly = scopes.length === 1 && scopes[0] === "full";
  const run = typeof resolve === "function" ? resolve : resolve.run;
  return {
    scopes,
    handler: async (ctx) => {
      const resolved = await run(ctx);
      if (!("method" in resolved)) {
        ctx.reply(resolved);
        return;
      }
      const opts = {
        method: resolved.method,
        url: resolved.url,
        headers: {
          ...(resolved.payload !== undefined ? jsonHeaders(ctx.app) : buildAuthHeaders(ctx.app)),
          // Marks a CLI/agent-originated request so routes that audit their
          // caller (DELETE /api/sessions/:id) can tell it from a browser one.
          [CONTROL_SOCKET_VIA_HEADER]: CONTROL_SOCKET_VIA_TOKEN,
        },
        ...(resolved.payload !== undefined ? { payload: resolved.payload } : {}),
      };
      ctx.reply(
        await (fullOnly ? injectRoute(ctx.app, ctx.conn, opts) : injectAndShape(ctx.app, opts)),
      );
    },
  };
}

type Resolver = DeclaredResolver;

/** Resolver wrapper: pins the target session (resolveTargetSessionId). */
const onSession = (fn: (id: string, ctx: OpContext) => Route | ReplyPayload): Resolver =>
  pinned((ctx) => {
    const target = resolveTargetSessionId(ctx.conn, ctx.body);
    return target.ok ? fn(target.id, ctx) : target.reply;
  });

/** Resolver wrapper: own session or one of its children (resolveOwnedSessionId). */
const onOwnedSession = (
  fn: (id: string, ctx: OpContext) => Route | ReplyPayload | Promise<Route | ReplyPayload>,
): Resolver =>
  owned((ctx) => {
    const target = resolveOwnedSessionId(ctx.app, ctx.conn, ctx.body);
    return target.ok ? fn(target.id, ctx) : target.reply;
  });

/** Resolver wrapper: pins the target project (resolveTargetProjectId). */
const onProject = (fn: (id: string, ctx: OpContext) => Route | ReplyPayload): Resolver =>
  pinned((ctx) => {
    const target = resolveTargetProjectId(ctx.app, ctx.conn, ctx.body);
    return target.ok ? fn(target.id, ctx) : target.reply;
  });

/** Resolver wrapper: a required explicit id field, 400 when absent. Does NOT
 * pin — the caller names the resource (see device.action's own comment). */
const onField = (key: string, fn: (id: string, ctx: OpContext) => Route | ReplyPayload): Resolver =>
  unscoped((ctx) => {
    const id = extractIdField(ctx.body, key);
    return id === null ? bad(400, `'${key}' is required`) : fn(id, ctx);
  });

export const OPS: Record<string, OpSpec> = {
  ping: {
    scopes: ["full", "session"],
    handler: ({ reply }) => {
      reply({ ok: true, status: 200, result: { pong: true } });
    },
  },
  "sessions.list": routeOp(["full"], ({ body }) => ({
    method: "GET",
    url: buildQueryUrl("/api/sessions", body),
  })),
  // Phase 4 (#187) — single-session inspect. Reachable at session scope
  // with no `sessionId` at all (defaults to the connection's own pinned
  // session — see resolveTargetSessionId), which is the shape an agent
  // running inside that session actually uses.
  "sessions.get": routeOp(
    ["full", "session"],
    onOwnedSession(async (id, { app }) => {
      // Reads `alive`/`stateRestored`/`hookEmits` off the live PTY, so a
      // survivor of a restart must be re-adopted first (#2271). A read stays
      // usable when that fails: a dead, unverifiable or erroring scope just
      // reads as not alive, unlike the ops that need the PTY and refuse.
      await adoptSurvivingSession(app, id).catch(() => undefined);
      return { method: "GET", url: `/api/sessions/${enc(id)}` };
    }),
  ),
  // The caller's own children (live and exited) with their derived status —
  // the parent→child orchestration listing. Session scope is pinned to its
  // OWN id as the parent (a session can only enumerate its own children);
  // full scope names the parent via `sessionId`. An optional `status` filter
  // (active|killed|exited) rides through.
  "sessions.children": routeOp(
    ["full", "session"],
    pinned(async ({ app, conn, body }) => {
      const target = resolveTargetSessionId(conn, body);
      if (!target.ok) return target.reply;
      // Same "caller must still be active" rule as every other op that
      // looks at a child (resolveOwnedSessionId) — a killed parent's
      // lingering hook token must not keep enumerating its children.
      if (conn.scope === "session" && !sessionRowIsActive(app, target.id)) {
        return bad(403, "this session is no longer active");
      }
      // Children that survived a Mullion restart are alive in their scopes
      // but untracked until something attaches (#2271): re-adopt them so the
      // listing reports their real status. One failure must not sink the list.
      const activeChildren = app.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.parentSessionId, Number(target.id)), eq(sessions.status, "active")))
        .all();
      // Only untracked ones: a listing must cost what the adoption does.
      await Promise.allSettled(
        activeChildren
          .filter((c) => !app.pty.get(String(c.id))?.isAlive)
          .map((c) => adoptSurvivingSession(app, String(c.id))),
      );
      return {
        method: "GET",
        url: buildQueryUrl("/api/sessions", {
          parentSessionId: target.id,
          status: body?.status,
        }),
      };
    }),
  ),
  // Server-owned wait (services/session-wait.ts): blocks THIS request — not
  // the agent's own turn budget — until the target's derived status matches
  // `until` (statuses and/or severities; default = anything needing
  // attention), or `timeoutMs` (default 10 min, max 1 h) elapses. At session
  // scope the target must be a CHILD (waiting on yourself can only time out).
  // The handler stays pending, so the dispatch loop counts it against
  // MAX_INFLIGHT_OPS for as long as it waits; a closed socket aborts it.
  // `afterSeq` is the stale-latch guard (see WaitOptions); the reply carries
  // the session's current `eventSeq` so a caller can chain it into the next
  // wait.
  //
  // Deliberately a raw OpSpec rather than routeOp(): a long-lived, cancellable
  // handler can't be expressed as a Route to forward. That means routeOp's
  // compile-time scope guard (#1546) does not cover it, so this handler must
  // do its own pin work — it resolves its target through
  // resolveOwnedSessionId({childOnly:true}) FIRST, before any other work, and
  // test/plugins/control-socket.test.ts's sessions.wait block asserts the
  // self / stranger / no-target 403s that guard exists for.
  "sessions.wait": {
    scopes: ["full", "session"],
    handler: async ({ app, conn, body, reply }) => {
      const target = resolveOwnedSessionId(app, conn, body, { childOnly: true });
      if (!target.ok) {
        reply(target.reply);
        return;
      }
      const parsed = parseWaitBody(body, { allowAfterSeq: true });
      if (!parsed.ok) {
        reply(parsed.reply);
        return;
      }
      const unverifiable = await adoptLocalChild(app, target.id);
      if (unverifiable) {
        reply(unverifiable);
        return;
      }
      // null == the peer hung up mid-wait; there is nobody to reply to.
      const result = await runWait(app, conn, target.id, parsed.opts);
      if (result) reply(result);
    },
  },
  // Waits until a CHILD prints some text (issue #1625) — the output-content
  // sibling of sessions.wait. Body: `sessionId` (a child), `match` (<= 256
  // chars; a literal substring unless `regex: true`, in which case it must
  // have no backreferences/lookarounds and star height <= 1 — see
  // services/output-wait.ts), `timeoutMs` (default 10 min, clamped to 1 h) and
  // `afterOffset` (a `sessions.prompt` reply's `outputOffset`, taken after the
  // prompt was typed and submitted: output printed since then still counts, so a
  // fast reply is not missed — but a TUI may redraw the submitted prompt into its
  // transcript, so do not match on text the prompt contains; omitted means only
  // output from now on). Matches against the last 16 KiB of ANSI-stripped
  // output. A child on another host is waited on THERE, in bounded chunks
  // (SessionBackend.waitOutput, #1951); 409 only when it has no live process.
  // Resolves `{matched, text, line}`, `{timedOut:true}` or `{gone:true}`.
  // A raw OpSpec like sessions.wait, so it does its own pinning FIRST.
  "sessions.wait_for_output": {
    scopes: ["full", "session"],
    handler: async ({ app, conn, body, reply }) => {
      const target = resolveOwnedSessionId(app, conn, body, { childOnly: true });
      if (!target.ok) {
        reply(target.reply);
        return;
      }
      const matcher = compileOutputMatcher(body?.match, body?.regex);
      if (!matcher.ok) {
        reply(bad(400, matcher.error));
        return;
      }
      const timeout = parseWaitTimeout(body?.timeoutMs);
      if (!timeout.ok) {
        reply(bad(400, timeout.error));
        return;
      }
      const afterOffset = body?.afterOffset;
      if (
        afterOffset !== undefined &&
        (typeof afterOffset !== "number" || !Number.isInteger(afterOffset) || afterOffset < 0)
      ) {
        reply(bad(400, "'afterOffset' must be a non-negative integer"));
        return;
      }
      if ((conn.activeWaits ?? 0) >= MAX_WAITS_PER_CONNECTION) {
        reply(bad(429, "too many pending waits on this connection"));
        return;
      }
      const unverifiable = await adoptLocalChild(app, target.id);
      if (unverifiable) {
        reply(unverifiable);
        return;
      }
      const controller = new AbortController();
      const onClose = () => controller.abort();
      const offClose = conn.onClose(onClose);
      conn.activeWaits = (conn.activeWaits ?? 0) + 1;
      try {
        const callerActive = () =>
          conn.scope !== "session" || sessionRowIsActive(app, conn.sessionId!);
        // The wait runs on the child's own host (issue #1951): the PTY lives
        // there. A local child is one in-process wait; a remote one is a loop
        // of bounded waits (SessionBackend.waitOutput).
        const outcome = await resolveBackend(app, childHostId(app, target.id)).waitOutput(
          target.id,
          {
            match: body?.match as string,
            regex: body?.regex === true,
            timeoutMs: timeout.timeoutMs,
            ...(afterOffset !== undefined ? { afterOffset } : {}),
            signal: controller.signal,
            // The caller must stay active for the whole wait, same as sessions.wait.
            alive: callerActive,
          },
        );
        if ("aborted" in outcome) return;
        if ("notRunning" in outcome) {
          reply(bad(409, NOT_LOCAL_MESSAGE));
          return;
        }
        if ("failed" in outcome) {
          reply(bad(outcome.status, outcome.error));
          return;
        }
        if ("gone" in outcome && !callerActive()) {
          reply(bad(403, "this session is no longer active"));
          return;
        }
        reply({ ok: true, status: 200, result: outcome });
      } finally {
        conn.activeWaits -= 1;
        offClose();
      }
    },
  },
  // Types a prompt into a running CHILD agent and (optionally) waits for its
  // turn to end — the "lead agent drives a worker" primitive. Body:
  // `sessionId` (a child at session scope), `text` (<= 32 KB), `submit`
  // (default true; false pastes without pressing Enter), `wait` (true, or
  // {until?, timeoutMs?} — see sessions.wait). Refuses rather than guesses:
  //   - 409 if the child is `blocked` (typing would ANSWER a permission /
  //     plan / question dialog) or gone;
  //   - 501 if the child's agent has no opt-in `submitPrompt` framing
  //     (hook-adapters/*: claude-code, codex, opencode; plain shells, agy and
  //     unknown CLIs don't);
  //   - 503 if the bytes could not be delivered (write backpressure).
  // The input goes through Session.writeAgentInput, NOT write(): a parent's
  // prompt must not read as the human acknowledging the child's pending
  // attention. It still starts a new turn (Session.beginAgentTurn) so a
  // following wait can't match the previous turn's `finished`.
  // Issue #2270 — hand a note to an already-running top-level session in ANOTHER
  // project. Session scope only (full scope has sessions.prompt). Allowed when the
  // caller's project is a coordinator that reaches the target's project AND that
  // project accepts messages from it (off by default); anything else is one uniform
  // 403. The text is QUEUED, not typed: it is delivered, framed with its source, once
  // the target is idle and not on a dialog, or expires. `wait: true` holds the reply
  // until it is delivered, refused or expired.
  "sessions.message": {
    scopes: ["session"],
    handler: async ({ app, conn, body, reply }) => {
      const targetRef = extractIdField(body, "sessionId");
      if (targetRef === null) {
        reply(bad(400, "'sessionId' is required (the session to message)"));
        return;
      }
      const text = body?.text;
      if (typeof text !== "string") {
        reply(bad(400, "'text' is required"));
        return;
      }
      if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
        reply(bad(413, `'text' exceeds ${MAX_MESSAGE_BYTES} bytes`));
        return;
      }
      if (sanitizePromptText(text).trim().length === 0) {
        reply(bad(400, "'text' is required"));
        return;
      }
      const ttlSeconds = body?.ttlSeconds;
      if (
        ttlSeconds !== undefined &&
        (typeof ttlSeconds !== "number" ||
          !Number.isInteger(ttlSeconds) ||
          ttlSeconds < 1 ||
          ttlSeconds > MAX_MESSAGE_TTL_SECONDS)
      ) {
        reply(bad(400, `'ttlSeconds' must be an integer from 1 to ${MAX_MESSAGE_TTL_SECONDS}`));
        return;
      }
      const wait = body?.wait;
      if (wait !== undefined && typeof wait !== "boolean") {
        reply(bad(400, "'wait' must be a boolean"));
        return;
      }
      const callerId = Number(conn.sessionId);
      if (!sessionRowIsActive(app, conn.sessionId!)) {
        reply({ ok: false, status: 403, error: "this session is no longer active" });
        return;
      }
      const { queue, limiter } = messageState(app);
      // Counted before the authorization below, so probing for a consenting session
      // is bounded too.
      if (!limiter.take(String(callerId))) {
        reply(bad(429, `at most ${MESSAGES_PER_MINUTE} messages per minute per session`));
        return;
      }
      const targetId = Number(targetRef);
      const refusal = Number.isInteger(targetId)
        ? messageRefusal(app, callerId, targetId)
        : MESSAGE_REFUSED;
      if (refusal !== null) {
        reply({ ok: false, status: 403, error: refusal });
        return;
      }
      if (wait === true && (conn.activeWaits ?? 0) >= MAX_WAITS_PER_CONNECTION) {
        reply(bad(429, "too many pending waits on this connection"));
        return;
      }
      const [callerRow] = app.db
        .select({ name: projects.name })
        .from(sessions)
        .innerJoin(projects, eq(sessions.projectId, projects.id))
        .where(eq(sessions.id, callerId))
        .all();
      const message = queue.enqueue({
        fromSessionId: callerId,
        fromLabel: provenanceLabel(callerRow?.name ?? "?"),
        targetSessionId: targetId,
        text,
        ttlMs: (ttlSeconds ?? DEFAULT_MESSAGE_TTL_MS / 1000) * 1000,
      });
      if (message === null) {
        reply(bad(429, "too many messages are already waiting for that session"));
        return;
      }
      if (wait !== true) {
        reply({ ok: true, status: 202, result: describeMessage(message) });
        return;
      }
      conn.activeWaits += 1;
      const aborter = new AbortController();
      const offClose = conn.onClose(() => aborter.abort());
      try {
        const settled = await queue.waitUntilSettled(message.id, aborter.signal);
        if (!aborter.signal.aborted) {
          // `undefined`: the record was evicted (the retention cap) between settling and
          // this poll. Say so rather than leave the client waiting on its socket timeout.
          reply(
            settled
              ? { ok: true, status: 200, result: describeMessage(settled) }
              : bad(404, "the message was forgotten before its outcome could be read"),
          );
        }
      } finally {
        conn.activeWaits -= 1;
        offClose();
      }
    },
  },
  // The delivery status of a message the caller sent: queued, delivered, expired or
  // refused. Only the sender can ask; an unknown id, someone else's, and a message the
  // primary forgot (a restart, or an hour after it finished) are all the same 404.
  "sessions.message_status": {
    scopes: ["session"],
    handler: ({ app, conn, body, reply }) => {
      const messageId = body?.messageId;
      if (typeof messageId !== "string" || messageId.length === 0) {
        reply(bad(400, "'messageId' is required"));
        return;
      }
      const message = messageState(app).queue.get(messageId);
      if (!message || message.fromSessionId !== Number(conn.sessionId)) {
        reply(bad(404, "unknown message (it may have been forgotten after a restart)"));
        return;
      }
      reply({ ok: true, status: 200, result: describeMessage(message) });
    },
  },
  "sessions.prompt": {
    scopes: ["full", "session"],
    handler: async ({ app, conn, body, reply }) => {
      const target = resolveOwnedSessionId(app, conn, body, { childOnly: true });
      if (!target.ok) {
        reply(target.reply);
        return;
      }
      const text = body?.text;
      if (typeof text !== "string") {
        reply(bad(400, "'text' is required"));
        return;
      }
      if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES) {
        reply(bad(413, `'text' exceeds ${MAX_PROMPT_BYTES} bytes`));
        return;
      }
      // Validate what will actually be TYPED: text that is only control
      // characters sanitizes to nothing and must not become a bare Enter.
      if (sanitizePromptText(text).trim().length === 0) {
        reply(bad(400, "'text' is required"));
        return;
      }
      const submit = body?.submit;
      if (submit !== undefined && typeof submit !== "boolean") {
        reply(bad(400, "'submit' must be a boolean"));
        return;
      }
      const shouldSubmit = submit !== false;
      let waitOpts: Omit<WaitBodyOpts, "afterSeq"> | null = null;
      const waitArg = body?.wait;
      if (waitArg !== undefined && waitArg !== false) {
        // Strict like `submit`: only `true` or an options object. null / 0 /
        // [] / "yes" must not fall through to a default 10-minute wait.
        if (
          waitArg !== true &&
          (typeof waitArg !== "object" || waitArg === null || Array.isArray(waitArg))
        ) {
          reply(bad(400, "'wait' must be a boolean or an object"));
          return;
        }
        if (!shouldSubmit) {
          reply(bad(400, "'wait' requires 'submit' (nothing to wait for otherwise)"));
          return;
        }
        const parsed = parseWaitBody(waitArg === true ? {} : (waitArg as Record<string, unknown>), {
          allowAfterSeq: false,
        });
        if (!parsed.ok) {
          reply(parsed.reply);
          return;
        }
        waitOpts = parsed.opts;
        if ((conn.activeWaits ?? 0) >= MAX_WAITS_PER_CONNECTION) {
          reply(bad(429, "too many pending waits on this connection"));
          return;
        }
      }

      const id = target.id;
      const hostId = childHostId(app, id);
      let outputOffset: number;
      let afterSeq: number | undefined;
      if (hostId !== LOCAL_HOST_ID) {
        // Issue #1951 — a child on another host: its PTY is there, so the
        // delivery runs there (SessionBackend.prompt). What the primary can
        // still decide itself is whether typing is wise at all, from a fresh
        // read of the child's status (issue #1962: also its in-flight turn,
        // which only that host knows — the `agent_busy` refusal of a wait).
        const refusal = await refuseIfBlockedOrGone(app, id, { refuseBusy: waitOpts !== null });
        if (refusal) {
          reply(refusal);
          return;
        }
        const outcome = await resolveBackend(app, hostId).prompt(id, {
          text,
          submit: shouldSubmit,
        });
        if (!outcome.ok) {
          reply(bad(outcome.status, outcome.error));
          return;
        }
        ({ outputOffset, afterSeq } = outcome);
      } else {
        const unverifiable = await adoptLocalChild(app, id);
        if (unverifiable) {
          reply(unverifiable);
          return;
        }
        // One prompt at a time per session, and the typing itself, live in
        // services/session-prompt.ts so a remote child's host runs the SAME
        // code. The two checks are this op's derived-status gate: asked
        // before anything is typed, and again before Enter.
        const delivery = await deliverPrompt(app, id, {
          text,
          submit: shouldSubmit,
          notRunning: NOT_LOCAL_MESSAGE,
          check: async (stage) => {
            const refusal = await refuseIfBlockedOrGone(
              app,
              id,
              stage === "before"
                ? { refuseBusy: waitOpts !== null }
                : {
                    note: " — the text was typed but NOT submitted and may still be in its input box",
                  },
            );
            return refusal && !refusal.ok
              ? { status: refusal.status ?? 500, error: refusal.error ?? "refused" }
              : null;
          },
        });
        if (!delivery.ok) {
          reply(bad(delivery.status, delivery.error));
          return;
        }
        ({ afterSeq, outputOffset } = delivery);
      }

      const delivered = { delivered: true, submitted: shouldSubmit, outputOffset };
      if (waitOpts === null) {
        reply({ ok: true, status: 200, result: delivered });
        return;
      }
      // `afterSeq` is the HOST's event head right after the turn began; a
      // remote host that predates it sends none, which runs the wait without
      // the "a new turn started" guard (see runWait).
      const waited = await runWait(app, conn, id, { ...waitOpts, afterSeq }, { expectGuard: true });
      if (waited === null) return;
      // The prompt WAS delivered; a failed wait is reported alongside, not
      // as a failure of the whole op.
      reply({
        ok: true,
        status: 200,
        result: {
          ...delivered,
          wait: waited.ok ? waited.result : { error: waited.error, status: waited.status },
        },
      });
    },
  },
  // Full scope only (deliberately, not just because REST requires a
  // projectId a session-scoped connection wouldn't have handy) — an agent
  // inside a session has no business spawning an unrelated one.
  "sessions.create": routeOp(["full"], ({ body }) => ({
    method: "POST",
    url: "/api/sessions",
    payload: json(body),
  })),
  // Phase 5 (Track B, issue #193 5.3b) — the narrow, session-scoped path to
  // a REAL child session (own PTY, own dtach socket), as opposed to
  // sessions.create's full-scope-only restriction above ("an agent inside a
  // session has no business spawning an UNRELATED one" — a same-project
  // child of the caller's own session is precisely the case that leaves
  // open). Same-project (unless the parent's project is a coordinator, #2110)
  // and one-level-of-nesting are enforced in
  // createSessionRecord (services/session-lifecycle.ts), not here — this handler's
  // only job is resolving WHICH session is the parent, deriving that
  // parent's own project via a real GET (never trusting a body-supplied
  // projectId), and stamping both onto the forwarded POST /api/sessions
  // body. `worktree`/`worktreeRefresh` are stripped from the caller's body
  // deliberately: createSessionRecord's cwd-containment check for a child
  // spawn assumes no worktree was requested (see that function's comment).
  "sessions.spawn_child": {
    scopes: ["full", "session"],
    handler: async ({ app, conn, body, reply }) => {
      const parent = resolveParentSessionId(conn, body);
      if (!parent.ok) {
        reply(parent.reply);
        return;
      }
      const parentLookup = await injectAndShape(app, {
        method: "GET",
        url: `/api/sessions/${encodeURIComponent(parent.id)}`,
        headers: buildAuthHeaders(app),
      });
      if (!parentLookup.ok) {
        reply(parentLookup);
        return;
      }
      const parentProjectId = (parentLookup.result as { projectId?: unknown } | undefined)
        ?.projectId;
      if (typeof parentProjectId !== "number") {
        reply({ ok: false, status: 400, error: "unable to resolve the parent session's project" });
        return;
      }
      // A session-scoped connection outlives its session's own intent: a hook
      // token stays valid until the process is reaped, so re-check the ROW
      // (the source of intent; the in-memory PtyManager map can lack a live
      // session) and refuse to let a killed/exited parent keep spawning (#1518).
      if (conn.scope === "session" && !sessionRowIsActive(app, parent.id)) {
        reply({ ok: false, status: 403, error: "the parent session is no longer active" });
        return;
      }
      const {
        sessionId: _sessionId,
        parentSessionId: _parentSessionId,
        projectId: _projectId,
        // Issue #2110 — read below; never forwarded (the forwarded projectId is
        // the resolved target, set explicitly).
        project: projectRef,
        worktree: _worktree,
        worktreeRefresh: _worktreeRefresh,
        ...fullRest
      } = body ?? {};
      // Issue #2110 — a coordinator names the project to spawn into. Staying
      // in the parent's own project (by its numeric id) needs no permission; any OTHER project
      // needs the parent's project to be a coordinator. createSessionRecord's
      // validateParent enforces the same rule again for every caller.
      let childProjectId = parentProjectId;
      if (projectRef !== undefined && projectRef !== null) {
        if (!projectCoordinates(app, parentProjectId)) {
          // Not a coordinator. The only `project` accepted is the parent's OWN
          // id (a no-op); anything else is the same 403 whether or not such a
          // project exists, decided BEFORE any lookup, so a session without the
          // setting cannot use the 404/403/409 difference to probe which
          // projects and names exist.
          const ownRef =
            typeof projectRef === "number" ||
            (typeof projectRef === "string" && /^\d+$/.test(projectRef.trim()))
              ? Number(projectRef)
              : Number.NaN;
          if (ownRef !== parentProjectId) {
            reply({ ok: false, status: 403, error: CROSS_PROJECT_DISABLED });
            return;
          }
        } else {
          const [sourceProject] = app.db
            .select()
            .from(projects)
            .where(eq(projects.id, parentProjectId))
            .all();
          const target = resolveSpawnTarget(app, projectRef, {
            allowed: (candidate) =>
              candidate.id === parentProjectId || crossProjectAllowed(sourceProject, candidate),
            uniform: conn.scope === "session",
          });
          if (!target.ok) {
            reply(target.reply);
            return;
          }
          childProjectId = target.id;
        }
      }
      // Session scope forwards an explicit ALLOWLIST (#1518), not a denylist:
      // a field newly added to POST /api/sessions' schema (as `env` once was)
      // must not silently widen what a session-scoped caller can set.
      // `kind`, `env`, `nameLocked` etc. are privilege- or visibility-adjacent
      // and stay full-scope only (a full-scope caller has that power
      // directly). `seedPrompt` grants nothing `command` doesn't already (a
      // session-scoped caller fully controls its child's first turn via
      // `command` itself).
      //
      // Issue #1733 — `skipPermissions` IS forwarded now, so a delegated
      // child inherits the parent's unattended permission posture instead of
      // stalling on a prompt nobody is watching. It is CAPPED by the parent's
      // own value, so the field can only narrow: a session-scoped caller can
      // ask for a MORE permissive child and will not get one.
      //
      // The cap is applied HERE, where the connection's scope is known, and
      // not in createSessionRecord — because full scope keeps its own power
      // over a child (the repo pins that: a full-scope caller setting
      // `skipPermissions` on a child of a prompting parent still gets it),
      // and a full-scope caller can already set the flag on the parent
      // itself. Session scope is the only path where the cap is a security
      // boundary rather than a policy.
      const rest: Record<string, unknown> =
        conn.scope === "session"
          ? (() => {
              const forwarded = Object.fromEntries(
                Object.entries(fullRest).filter(([key]) =>
                  SESSION_SPAWN_CHILD_FIELDS.includes(key),
                ),
              );
              // The parent's own posture is the ceiling. `requested` may only
              // narrow it: unset means "inherit", and an explicit true still
              // cannot exceed what the parent has.
              //
              // A NON-boolean value ("true", 1) is neither unset nor `true`,
              // so it narrows to false — the fail-closed reading. The socket
              // body is not schema-validated before this point (only
              // POST /api/sessions would 400 it), so this is the only place
              // a nonsense value can be caught.
              const parentSkipPermissions =
                (parentLookup.result as { skipPermissions?: unknown } | undefined)
                  ?.skipPermissions === true;
              const requested = forwarded.skipPermissions;
              forwarded.skipPermissions =
                (requested === undefined ? true : requested === true) && parentSkipPermissions;
              return forwarded;
            })()
          : fullRest;
      // A name the spawner chose is pinned: unlocked, the agent's own terminal
      // title replaces it in the sidebar within seconds (issue #2112). A
      // full-scope caller that sends an explicit `nameLocked` keeps its value;
      // session scope can't send one (SESSION_SPAWN_CHILD_FIELDS).
      const pinName =
        typeof rest.name === "string" && rest.name.trim() !== "" && rest.nameLocked === undefined;
      const payload = {
        ...rest,
        ...(pinName ? { nameLocked: true } : {}),
        projectId: childProjectId,
        parentSessionId: Number(parent.id),
      };
      app.log.info(
        {
          parentSessionId: parent.id,
          projectId: childProjectId,
          crossProject: childProjectId !== parentProjectId,
          scope: conn.scope,
        },
        "sessions.spawn_child",
      );
      reply(
        await injectAndShape(app, {
          method: "POST",
          url: "/api/sessions",
          headers: jsonHeaders(app),
          payload: JSON.stringify(payload),
        }),
      );
    },
  },
  // Full scope: any session, `body.sessionId` required (no implicit "self").
  // Session scope: a CHILD of the caller's own session only — a session may
  // never kill itself or an unrelated session through this socket
  // (resolveOwnedSessionId's `childOnly`). A child has no children of its own
  // (one level of nesting), so `body.cascade` is moot there but still
  // validated. `body.cascade` ("detach"|"kill", default "detach" — see
  // services/session-lifecycle.ts's killSession) rides through as a querystring on the
  // proxied DELETE, same transport reasoning as that route's own comment.
  "sessions.kill": routeOp(
    ["full", "session"],
    owned(({ app, conn, body }) => {
      const target = resolveOwnedSessionId(app, conn, body, { childOnly: true });
      if (!target.ok) return target.reply;
      const cascade = body?.cascade;
      if (cascade !== undefined && cascade !== "detach" && cascade !== "kill") {
        return bad(400, "'cascade' must be 'detach' or 'kill'");
      }
      const query = cascade !== undefined ? { cascade } : undefined;
      return { method: "DELETE", url: buildQueryUrl(`/api/sessions/${enc(target.id)}`, query) };
    }),
  ),
  // Reachable at session scope (an agent renaming its own session), same
  // target-id shape as sessions.get above.
  "sessions.rename": routeOp(
    ["full", "session"],
    onSession((id, { body }) =>
      typeof body?.name !== "string" || body.name.length === 0
        ? bad(400, "'name' is required")
        : { method: "PATCH", url: `/api/sessions/${enc(id)}`, payload: json({ name: body.name }) },
    ),
  ),
  // Reachable at session scope: an agent asking the Mullion server to relay a
  // Hermes review request for the PR of the repo it is working in. Pinned to
  // the caller's own session (same target-id shape as sessions.get); the repo
  // is derived server-side from that session's project (routes/
  // review-relay.ts), and the Hermes URL/key never reach the session.
  "reviews.request": routeOp(
    ["full", "session"],
    onSession((id, { body }) => ({
      method: "POST",
      url: `/api/sessions/${enc(id)}/review-request`,
      // `force` is for the request only: it overrides the approved-PR guard.
      payload: json(relayTargetFields(body, ["prNumber", "repo", "branch", "force"])),
    })),
  ),
  // #2102 — a Task Master worker pushes its branch through Mullion (gated,
  // bot identity) instead of with its own git credentials. Pinned to the
  // caller's OWN session, so a session can only push its own task; the route
  // (routes/task-push.ts) further requires that session to be a task's worker.
  // Approving a workflow change is deliberately NOT an op.
  "tasks.push": routeOp(
    ["full", "session"],
    onSession((id) => ({ method: "POST", url: `/api/sessions/${enc(id)}/task-push` })),
  ),
  // Status of the latest review run for the caller's PR, and stopping a run the
  // caller's own session dispatched (routes/review-relay.ts enforces that).
  "reviews.status": routeOp(
    ["full", "session"],
    onSession((id, { body }) => ({
      method: "GET",
      url: `/api/sessions/${enc(id)}/review-request${relayQuery(relayTargetFields(body))}`,
    })),
  ),
  // The stop op covers every relay run — a review or a triage — because the
  // run is named, not derived from a target.
  "reviews.stop": routeOp(
    ["full", "session"],
    onSession((id, { body }) =>
      typeof body?.runId !== "string" || body.runId.length === 0
        ? bad(400, "'runId' is required")
        : {
            method: "POST",
            url: `/api/sessions/${enc(id)}/review-stop`,
            payload: json({ runId: body.runId }),
          },
    ),
  ),
  // Issue triage through the same relay (issue #1629). The repo is chosen
  // exactly as for a review (the caller's project, or a named registered
  // one); the issue number
  // always comes from the caller — there is no "current issue" to infer.
  "triage.request": routeOp(
    ["full", "session"],
    onSession((id, { body }) => {
      const issueNumber = body?.issueNumber;
      if (typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber < 1) {
        return bad(400, "'issueNumber' must be a positive integer");
      }
      return {
        method: "POST",
        url: `/api/sessions/${enc(id)}/triage-request`,
        payload: json({ issueNumber, ...relayTargetFields(body, ["repo"]) }),
      };
    }),
  ),
  "triage.status": routeOp(
    ["full", "session"],
    onSession((id, { body }) => {
      const issueNumber = body?.issueNumber;
      if (typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber < 1) {
        return bad(400, "'issueNumber' must be a positive integer");
      }
      return {
        method: "GET",
        url: `/api/sessions/${enc(id)}/triage-request${relayQuery({
          issueNumber,
          ...relayTargetFields(body, ["repo"]),
        })}`,
      };
    }),
  ),
  // Reachable at session scope — same target-id shape as sessions.get.
  "sessions.scrollback": routeOp(
    ["full", "session"],
    onOwnedSession((id, ctx) => ({
      method: "GET",
      // mode:"rendered" asks for the terminal screen as plain text (issue
      // #2112) instead of the raw byte stream; anything else stays raw.
      url: `/api/sessions/${enc(id)}/scrollback${ctx.body?.mode === "rendered" ? "?mode=rendered" : ""}`,
    })),
  ),
  // Issue #2268 — the session's conversation as plain text, from the agent CLI's
  // own transcript. Same target-id shape and reach as sessions.scrollback: own
  // session and own children at session scope. `afterSeq` is the opaque cursor a
  // previous page returned (`nextSeq`); `tools: true` keeps tool calls and
  // results in full instead of a one-line summary.
  "sessions.transcript": routeOp(
    ["full", "session"],
    onOwnedSession((id, ctx) => {
      const { afterSeq, limit, tools } = ctx.body ?? {};
      if (
        afterSeq !== undefined &&
        (typeof afterSeq !== "number" || !Number.isInteger(afterSeq) || afterSeq < 0)
      ) {
        return bad(400, "'afterSeq' must be a non-negative integer");
      }
      if (
        limit !== undefined &&
        (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 500)
      ) {
        return bad(400, "'limit' must be an integer from 1 to 500");
      }
      if (tools !== undefined && typeof tools !== "boolean") {
        return bad(400, "'tools' must be a boolean");
      }
      return {
        method: "GET",
        url: `/api/sessions/${enc(id)}/transcript${relayQuery({
          ...(afterSeq !== undefined ? { afterSeq } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(tools === true ? { tools: "1" } : {}),
        })}`,
      };
    }),
  ),
  // Phase 4 (#186) — opens a multiplexed PTY I/O stream on this connection,
  // keyed by this request's own `id`: attachSocketToSession/
  // proxyToRemoteAttach (terminal.ts) write scrollback replay and live
  // output as unsolicited `{id, type:"data", b64}`/`{id, type:"exited"}`
  // frames on the SAME `id`, entirely outside this `reply()` envelope — see
  // resolveAndAttach's own doc comment for why this function, not a
  // reimplementation, is what both this op and /ws/terminal call. Only a
  // FAILED attach gets a `reply()` — a successful one has no separate ack at
  // all (see the handler's own comment for why one would be confusingly
  // out of order): the scrollback replay's own `{id,type:"data"}` frame,
  // sent synchronously inside resolveAndAttach before this handler returns,
  // IS the success signal, and it's unconditional (getScrollback()'s
  // synthesized preamble is never actually empty) so it always arrives even
  // for a session that's produced no real output yet.
  "sessions.attach": {
    scopes: ["full", "session"],
    handler: ({ app, conn, id, body, reply }) => {
      if (conn.socket === null) {
        reply(STREAM_UNAVAILABLE);
        return;
      }
      const target = resolveTargetSessionId(conn, body);
      if (!target.ok) {
        reply(target.reply);
        return;
      }
      const slotError = streamSlotError(conn, id);
      if (slotError) {
        reply(slotError);
        return;
      }
      // Same fallback shape as /ws/terminal's own query-param defaults
      // (terminal.ts) — a caller that doesn't care about real dimensions
      // yet (e.g. a one-shot `mullion logs`) doesn't have to supply them.
      const cols = Number(body?.cols) || 80;
      const rows = Number(body?.rows) || 24;

      // No explicit `reply({ok:true})` on success: resolveAndAttach's own
      // attachSocketToSession call synchronously writes the scrollback
      // replay as a `{id,type:"data",b64}` frame on this same id BEFORE
      // this handler gets a chance to run any code after it returns — an
      // ack sent after that would be confusingly out of order (data before
      // its own "attach succeeded" acknowledgment). getScrollback()'s
      // synthesized alt-screen preamble is unconditional (pty-manager.ts),
      // so that first data frame always arrives regardless of whether the
      // session has actually produced any real output yet — it IS the
      // success signal, matching the wire protocol's own documented shape
      // (docs/socket-api.md): only a failure gets a `reply()`.
      const channel = new SocketChannel(conn.socket, id);
      const result = resolveAndAttach(app, channel, { sessionId: Number(target.id), cols, rows });
      if (!result.ok) {
        reply({ ok: false, status: result.status, error: result.error });
        return;
      }
      conn.openChannels.set(id, channel);
      // The stream can end WITHOUT going through sessions.detach below —
      // most importantly, proxyToRemoteAttach (terminal.ts) calls this
      // channel's close() on any upstream (remote-host) failure, with no
      // request/response op involved at all. Without this listener,
      // conn.openChannels would keep the dead entry forever: a fresh
      // sessions.attach on this same id would 400 "already open" forever,
      // and sessions.input/resize would keep silently reaching a channel
      // whose message listeners already stopped forwarding anywhere.
      channel.on("close", () => {
        conn.openChannels.delete(id);
      });
    },
  },
  // Client→server keystrokes for an already-open sessions.attach stream —
  // deliberately silent on success (no reply): acking every single input
  // frame would be a reply flood for interactive typing. Errors still
  // reply, so a caller can tell a broken/detached stream apart from normal
  // fire-and-forget input.
  "sessions.input": {
    scopes: ["full", "session"],
    handler: ({ conn, id, body, reply }) => {
      const channel = requireChannel(conn, id, reply);
      if (!channel) return;
      const b64 = typeof body?.b64 === "string" ? body.b64 : null;
      if (b64 === null) {
        reply({ ok: false, status: 400, error: "'b64' is required" });
        return;
      }
      // isBinary: true routes into attachSocketToSession's own binary-frame
      // branch (raw keystroke bytes → session.write()), not its JSON
      // control-message branch.
      channel.emitMessage(Buffer.from(b64, "base64"), true);
    },
  },
  // Same "silent on success, reply on error" posture as sessions.input —
  // delivered as attachSocketToSession's own `{"type":"resize",...}` text
  // control frame, so the resize logic itself lives in exactly one place.
  "sessions.resize": {
    scopes: ["full", "session"],
    handler: ({ conn, id, body, reply }) => {
      const channel = requireChannel(conn, id, reply);
      if (!channel) return;
      const cols = body?.cols;
      const rows = body?.rows;
      // Number.isFinite, not just typeof === "number": NaN/Infinity are
      // both `typeof "number"` too, and would otherwise sail past this
      // check only to get silently swallowed downstream — JSON.stringify
      // renders them as `null`, which attachSocketToSession's own
      // isResizeMessage (terminal.ts) then rejects as not a resize message
      // at all, dropping the request with no error ever reported back
      // (Hermes review, PR #399).
      if (
        typeof cols !== "number" ||
        typeof rows !== "number" ||
        !Number.isFinite(cols) ||
        !Number.isFinite(rows)
      ) {
        reply({ ok: false, status: 400, error: "'cols' and 'rows' are required" });
        return;
      }
      channel.emitMessage(Buffer.from(JSON.stringify({ type: "resize", cols, rows })), false);
    },
  },
  // Ends one stream without affecting the connection or any other stream
  // multiplexed on it — the session itself is never killed (matching
  // /ws/terminal's own "socket close ≠ session death" posture); use
  // sessions.kill for that.
  "sessions.detach": {
    scopes: ["full", "session"],
    handler: ({ conn, id, reply }) => {
      const channel = requireChannel(conn, id, reply);
      if (!channel) return;
      // notify: false — the reply() below already tells this caller the
      // stream ended; a redundant unsolicited {id,type:"closed"} frame
      // would arrive on the wire ahead of this very reply (close() runs
      // synchronously here) and is exactly the "confusingly out of order"
      // shape sessions.attach's own success path avoids for the same
      // reason. The close listener registered in sessions.attach above
      // still fires and removes this entry from openChannels regardless.
      channel.close(false);
      reply({ ok: true, status: 200 });
    },
  },
  // Phase 4 (#188) — opens a multiplexed notification-events stream on this
  // connection, keyed by this request's own `id`, exactly the same
  // multiplexing shape as sessions.attach above. Unlike sessions.attach,
  // this DOES send an explicit `{ok:true}` ack: attachLocalEventsSocket's
  // replay batch (routes/events.ts) can genuinely be empty (an idle system
  // with nothing buffered yet), unlike getScrollback()'s unconditionally
  // non-empty preamble — so there is no data frame guaranteed to arrive
  // that could serve as an implicit success signal the way it does for PTY
  // attach. The ack is sent AFTER attaching (which synchronously flushes
  // any replay events first), so a client can rely on: anything received
  // before the ack is replay, anything after is live.
  "events.subscribe": {
    scopes: ["full", "session"],
    handler: ({ app, conn, id, body, reply }) => {
      if (conn.socket === null) {
        reply(STREAM_UNAVAILABLE);
        return;
      }
      const slotError = streamSlotError(conn, id);
      if (slotError) {
        reply(slotError);
        return;
      }
      const channel = new SocketChannel(conn.socket, id);
      if (conn.scope === "session") {
        // Always a LOCAL session — a session-scoped connection's pin can
        // only ever resolve against this process's own PtyManager (see
        // attachAggregatedEventsSocket's own doc comment) — so there is no
        // multi-host aggregation to open here, only a same-process filter.
        if (body?.includeChildren === true) {
          // Opt-in: self plus the caller's own children. Like the other
          // owned ops, the caller's own row must be active when subscribing;
          // the stream then lives until the socket closes (unlike
          // events.query, which re-checks per request).
          if (!sessionRowIsActive(app, conn.sessionId!)) {
            reply({ ok: false, status: 403, error: "this session is no longer active" });
            return;
          }
          const ownId = Number(conn.sessionId);
          attachLocalEventsSocket(app, channel, {
            sessionFilter: ownAndChildSessionFilter(app, ownId),
            // Receiving a child's events is not writing its read cursor.
            seenFilter: (sessionId) => sessionId === ownId,
            // Issue #2125 — the session and its children may live on another host.
            includeRemote: true,
            remoteReplayIds: [ownId, ...childSessionIds(app, ownId)].filter(
              (sessionId) => childHostId(app, String(sessionId)) !== LOCAL_HOST_ID,
            ),
          });
        } else {
          attachLocalEventsSocket(app, channel, {
            sessionIdFilter: conn.sessionId!,
            includeRemote: true,
            remoteReplayIds:
              childHostId(app, conn.sessionId!) !== LOCAL_HOST_ID ? [Number(conn.sessionId)] : [],
          });
        }
      } else {
        attachAggregatedEventsSocket(app, channel);
      }
      conn.openChannels.set(id, channel);
      channel.on("close", () => {
        conn.openChannels.delete(id);
      });
      reply({ ok: true, status: 200 });
    },
  },
  // Forwards a "seen" cursor update on an already-open events.subscribe
  // stream — delivered as attachLocalEventsSocket's own
  // `{"type":"seen",...}` text control frame (routes/events.ts), the exact
  // same message a real /ws/events browser connection sends, so the cursor
  // logic itself lives in exactly one place. Deliberately silent on success
  // (no reply), same posture as sessions.input/resize; errors still reply.
  // A session-scoped connection naming a different session's id is
  // silently ignored by attachLocalEventsSocket's own filter (not rejected
  // with an error here) — matching how a session-scoped events.subscribe
  // never received that other session's events in the first place, so
  // there is nothing for this op to have corrupted.
  "events.seen": {
    scopes: ["full", "session"],
    handler: ({ conn, id, body, reply }) => {
      const channel = requireChannel(conn, id, reply);
      if (!channel) return;
      const sessionId = body?.sessionId;
      const seq = body?.seq;
      if (
        typeof sessionId !== "number" ||
        typeof seq !== "number" ||
        !Number.isFinite(sessionId) ||
        !Number.isFinite(seq)
      ) {
        reply({ ok: false, status: 400, error: "'sessionId' and 'seq' must be finite numbers" });
        return;
      }
      channel.emitMessage(Buffer.from(JSON.stringify({ type: "seen", sessionId, seq })), false);
    },
  },
  // Ends one events stream without affecting the connection or any other
  // stream multiplexed on it — same shape as sessions.detach.
  "events.unsubscribe": {
    scopes: ["full", "session"],
    handler: ({ conn, id, reply }) => {
      const channel = requireChannel(conn, id, reply);
      if (!channel) return;
      channel.close(false);
      reply({ ok: true, status: 200 });
    },
  },
  // Issue #213 (roadmap 4.7) — request/response, not a stream: unlike
  // events.subscribe (a live push feed), this queries the persisted
  // `session_events` history (src/plugins/event-store.ts) via GET
  // /api/events, one shot, same shape as sessions.list. Full scope may
  // query any session (or omit `sessionId` for every session); session
  // scope may query its own pinned session or one of its children — see
  // resolveEventsSessionFilter / resolveOwnedSessionId. Unlike
  // events.subscribe's `includeChildren`, the caller's row is re-checked on
  // every request.
  "events.query": routeOp(
    ["full", "session"],
    owned(({ app, conn, body }) => {
      const resolved = resolveEventsSessionFilter(app, conn, body);
      if (!resolved.ok) return resolved.reply;
      const queryBody: Record<string, unknown> = { ...body };
      if (resolved.sessionId !== undefined) queryBody.sessionId = resolved.sessionId;
      else delete queryBody.sessionId;
      return { method: "GET", url: buildQueryUrl("/api/events", queryBody) };
    }),
  ),
  // Phase 4 (#189) — request/response, not a stream: `executeBrowserAction`
  // (browser-automation.ts) already returns a full snapshot/console/errors
  // envelope in one shot, so there's nothing here that needs multiplexing
  // the way PTY output or a live events feed does. Same target-id shape as
  // sessions.get/scrollback/rename above — `body.sessionId` is stripped
  // before forwarding (it's this socket's own targeting field, not part of
  // AgentAction's schema) so the REST route only ever sees the action body
  // it actually expects.
  "browser.action": routeOp(
    ["full", "session"],
    onSession((id, { body }) => {
      const { sessionId: _sessionId, ...actionBody } = body ?? {};
      return { method: "POST", url: `/api/sessions/${enc(id)}/browser`, payload: json(actionBody) };
    }),
  ),
  // Same shape as browser.action — `body.sessionId` targets the session,
  // the rest (`by`/`value`/`name`/`limit`) is FindElementsBody verbatim.
  "browser.find": routeOp(
    ["full", "session"],
    onSession((id, { body }) => {
      const { sessionId: _sessionId, ...findBody } = body ?? {};
      const url = `/api/sessions/${enc(id)}/browser/find`;
      return { method: "POST", url, payload: json(findBody) };
    }),
  ),
  // The way out of a `binding_unavailable` browser: drops the session's
  // binding so its next browser call resolves its current host and checkout.
  "browser.unbind": routeOp(
    ["full", "session"],
    onSession((id) => ({ method: "DELETE", url: `/api/sessions/${enc(id)}/browser` })),
  ),
  // Read-only inspect of which browser pane(s) a session is bound to —
  // same target-id shape as sessions.get, no request body beyond sessionId.
  "browser.bindings": routeOp(
    ["full", "session"],
    onSession((id) => ({ method: "GET", url: `/api/sessions/${enc(id)}/browser` })),
  ),
  // Unlike browser.action/browser.bindings above, a device has no "belongs
  // to this session" relationship to resolve — resolveTargetSessionId's
  // whole point is pinning a session-scoped connection to ITS OWN session,
  // and there is no analogous "this session's own device." So `deviceId` is
  // always explicit, at either scope, and a session-scoped connection is
  // NOT restricted to any particular device — a deliberate choice, not an
  // oversight: closing the agent-facing "verify my own UI change" loop
  // (the whole point of exposing this at session scope at all) requires
  // acting on whichever device the agent is actually driving, which this
  // socket has no way to know in advance the way it does for "my own
  // session." Devices are a much lower blast-radius resource than the SSH
  // agent traffic resolveTargetSessionId's pinning exists to protect
  // (worst case here: an unrelated tap/screenshot, not a credential). Still
  // reached via injectAndShape directly, never injectRoute, per this file's
  // own structural rule for any op listing "session" in scopes.
  "device.action": routeOp(
    ["full", "session"],
    onField("deviceId", (id, { body }) => {
      const { deviceId: _deviceId, ...actionBody } = body ?? {};
      return { method: "POST", url: `/api/devices/${enc(id)}/action`, payload: json(actionBody) };
    }),
  ),
  "device.list": routeOp(
    ["full", "session"],
    unscoped(() => ({ method: "GET", url: "/api/devices" })),
  ),
  // Same "explicit deviceId, no pinning" posture as device.action above.
  "device.get": routeOp(
    ["full", "session"],
    onField("deviceId", (id) => ({ method: "GET", url: `/api/devices/${enc(id)}` })),
  ),
  "device.create": {
    scopes: ["full", "session"],
    handler: async ({ app, conn, body, reply }) => {
      // Hermes review on this PR: `kind: "physical"` (routed to
      // wireless.connect() with `serial: address`, device-manager.ts's
      // connectPhysical()) is NOT the same blast radius as the emulator
      // path below it — it makes the host's adb server dial an ARBITRARY
      // network address a session-scoped caller supplies, an outbound-dial/
      // internal-network-probe primitive the emulator branch never had, and
      // then that same session-scope connection can drive it via the
      // already-session-scope device.action ops. That is exactly the
      // "bigger blast radius" reasoning device.pair (below) is gated
      // full-scope-only for, so the same gate applies here — checked
      // inline, not via injectRoute, since (per this file's own structural
      // rule for any op listing "session" in scopes) only the EMULATOR
      // half of this op may still go through injectAndShape directly for a
      // session-scoped caller.
      if ((body as { kind?: string } | undefined)?.kind === "physical" && conn.scope !== "full") {
        reply({ ok: false, status: 403, error: "this operation requires full-scope credentials" });
        return;
      }
      reply(
        await injectAndShape(app, {
          method: "POST",
          url: "/api/devices",
          headers: jsonHeaders(app),
          payload: JSON.stringify(body ?? {}),
        }),
      );
    },
  },
  // Deliberately `["full"]` ONLY — unlike every other device.* op above,
  // which mirrors device.action's "worst case: an unrelated tap/screenshot,
  // not a credential" reasoning (see that op's own comment), pairing
  // authorizes the HOST's adb server to trust a new piece of hardware.
  // That's a materially bigger blast radius than driving a device Mullion
  // already manages, so it doesn't get the session-scope carve-out the rest
  // of this family does.
  "device.pair": routeOp(["full"], ({ body }) => ({
    method: "POST",
    url: "/api/devices/pair",
    payload: json(body),
  })),
  // Same "full-only because it dials an arbitrary address" reasoning as
  // device.pair above. Accepts either a `discoveryId` (from
  // device.discovered) or a manual `pairingAddress`+`connectAddress` pair.
  "device.pair-and-connect": routeOp(["full"], ({ body }) => ({
    method: "POST",
    url: "/api/devices/pair-and-connect",
    payload: json(body),
  })),
  // Read-only mDNS snapshot. Cheap (in-memory cache), no network side
  // effects, no scope concerns beyond the rest of the device.list family.
  "device.discovered": routeOp(
    ["full", "session"],
    unscoped(() => ({ method: "GET", url: "/api/devices/discovered" })),
  ),
  // Keeps its historical name (and its documented meaning — "flips the row
  // to `killed` and tears down the live process/scope") even though the
  // `mullion device stop` verb now maps here rather than to DELETE: stop is
  // reversible, the row survives, and `device.delete` below is the
  // irreversible one. Renaming the op would break every raw-socket caller
  // of a published API for no behavioural gain.
  "device.terminate": routeOp(
    ["full", "session"],
    onField("deviceId", (id) => ({ method: "POST", url: `/api/devices/${enc(id)}/stop` })),
  ),
  // Start is the mirror of terminate above and equally reversible, so it
  // gets the same full+session reachability — an agent that can stop a
  // device can start one again.
  "device.start": routeOp(
    ["full", "session"],
    onField("deviceId", (id) => ({ method: "POST", url: `/api/devices/${enc(id)}/start` })),
  ),
  // Full scope only, on the same "bigger blast radius than driving a device
  // Mullion already manages" reasoning as device.pair and (for the same
  // destroy-something-permanently shape) sessions.kill/previews.delete:
  // this drops the row and the id that identifies its systemd scope, with
  // no undo. A session-scoped caller can still start/stop the device.
  "device.delete": routeOp(
    ["full"],
    onField("deviceId", (id) => ({ method: "DELETE", url: `/api/devices/${enc(id)}` })),
  ),
  "projects.list": routeOp(["full"], () => ({ method: "GET", url: "/api/projects" })),
  // Phase 4 (#134, PR6) — reachable at session scope: an agent inside a
  // session asking "what launchers does my own project have" with no
  // `projectId` at all is the shape `mullion project actions` actually uses
  // — see resolveTargetProjectId. Multi-host proxying (a project on a
  // remote agent host) is inherited for free through app.inject() against
  // the real route, same as every other op here.
  "projects.actions": routeOp(
    ["full", "session"],
    onProject((id) => ({ method: "GET", url: `/api/projects/${enc(id)}/actions` })),
  ),
  // Issue #2110 — the projects a coordinator session may spawn a child in:
  // `{ id, name, hostId }` for every OTHER project, so it can name one in
  // `sessions.spawn_child`'s `project`. Only for a session whose own project is
  // a coordinator (403 otherwise) — `projects.list` stays full-scope, and a
  // session that cannot spawn elsewhere has no use for the list. The caller's
  // own project is left out (spawning there needs no `project`).
  "projects.spawn_targets": {
    scopes: ["full", "session"],
    handler: async ({ app, conn, body, reply }) => {
      const caller = resolveParentSessionId(conn, body);
      if (!caller.ok) {
        reply(caller.reply);
        return;
      }
      if (conn.scope === "session" && !sessionRowIsActive(app, caller.id)) {
        reply({ ok: false, status: 403, error: "the session is no longer active" });
        return;
      }
      const own = app.db
        .select({ projectId: sessions.projectId })
        .from(sessions)
        .where(eq(sessions.id, Number(caller.id)))
        .get();
      if (!own) {
        reply({ ok: false, status: 404, error: `unknown session ${caller.id}` });
        return;
      }
      if (own.projectId === null || !projectCoordinates(app, own.projectId)) {
        reply({ ok: false, status: 403, error: CROSS_PROJECT_DISABLED });
        return;
      }
      const [source] = app.db.select().from(projects).where(eq(projects.id, own.projectId)).all();
      const targets = allowedSpawnTargets(app, source!).map((p) => ({
        id: p.id,
        name: p.name,
        hostId: p.hostId,
      }));
      reply({ ok: true, status: 200, result: targets });
    },
  },
  // Full scope only, per the plan's per-scope allowlist — unlike
  // projects.actions above, dock controls are an operator-facing concept
  // (persistent monitors toggled from the dashboard), not something an
  // agent inside a session needs to introspect about itself.
  "projects.dock": routeOp(
    ["full"],
    onField("projectId", (id) => ({ method: "GET", url: `/api/projects/${enc(id)}/dock` })),
  ),
  // Full scope only — project tooling is operator-authored config, not
  // something an agent inside a session should modify about an unrelated
  // project. GET is session-scoped (agents can read their own project's
  // tooling); SET is full-scope only.
  "projects.get_tooling": routeOp(
    ["full", "session"],
    onProject((id) => ({ method: "GET", url: `/api/projects/${enc(id)}/tooling` })),
  ),
  "projects.set_tooling": {
    scopes: ["full"],
    handler: async ({ app, conn, body, reply }) => {
      const id = extractIdField(body, "projectId");
      if (id === null) {
        reply({ ok: false, status: 400, error: "'projectId' is required" });
        return;
      }
      // Forward each field that was explicitly provided. The REST routes
      // each handle their own validation and upsert independently.
      const results: Record<string, unknown> = {};
      let allOk = true;
      const base = `/api/projects/${encodeURIComponent(id)}/tooling`;
      const headers = buildAuthHeaders(app);
      const b = body ?? {};
      if (b.briefing !== undefined) {
        results.briefing = await injectRoute(app, conn, {
          method: "PUT",
          url: base,
          headers,
          payload: { briefing: b.briefing },
        });
        if ((results.briefing as { ok?: boolean })?.ok === false) allOk = false;
      }
      if (b.skill !== undefined) {
        results.skill = await injectRoute(app, conn, {
          method: "PUT",
          url: `${base}/skill`,
          headers,
          payload: { skill: b.skill },
        });
        if ((results.skill as { ok?: boolean })?.ok === false) allOk = false;
      }
      if (b.reviewerAgent !== undefined) {
        results.reviewerAgent = await injectRoute(app, conn, {
          method: "PUT",
          url: `${base}/reviewer-agent`,
          headers,
          payload: { reviewerAgent: b.reviewerAgent },
        });
        if ((results.reviewerAgent as { ok?: boolean })?.ok === false) allOk = false;
      }
      reply({ ok: allOk, ...results });
    },
  },
  // Full scope only — same posture as sessions.create: an agent inside a
  // session has no business minting a preview subdomain for an unrelated
  // project or arbitrary external URL through this socket.
  "previews.create": routeOp(["full"], ({ body }) => ({
    method: "POST",
    url: "/api/previews",
    payload: json(body),
  })),
  "previews.get": routeOp(["full"], (ctx) => {
    const slug = typeof ctx.body?.slug === "string" ? ctx.body.slug : null;
    if (slug === null || slug.length === 0) return bad(400, "'slug' is required");
    return { method: "GET", url: `/api/previews/${enc(slug)}` };
  }),
  "previews.delete": routeOp(["full"], (ctx) => {
    const slug = typeof ctx.body?.slug === "string" ? ctx.body.slug : null;
    if (slug === null || slug.length === 0) return bad(400, "'slug' is required");
    return { method: "DELETE", url: `/api/previews/${enc(slug)}` };
  }),
  // Full scope only — previews are host-global (no session/user scoping
  // column on the table), so a session-scoped connection listing all
  // previews would leak every external preview's URL to whichever session
  // happens to hold a hook token.
  "previews.list": routeOp(["full"], () => ({ method: "GET", url: "/api/previews" })),
  // Full scope only, matching the plan's allowlist — the set of installed
  // agent CLIs on the host is operator-facing config, not something an
  // in-session agent needs to query about itself.
  "agents.list": routeOp(["full"], () => ({ method: "GET", url: "/api/agents" })),
  // Full scope only — issue #944, same posture as agents.list: bundle-sync
  // status is operator-facing host config, not something an in-session
  // agent needs to introspect about itself.
  "bundle.status": routeOp(["full"], () => ({ method: "GET", url: "/api/bundle-sync/status" })),
  "bundle.resync": routeOp(["full"], () => ({
    method: "POST",
    url: "/api/bundle-sync/resync",
    payload: "{}",
  })),
  // Issue #945 — full scope only, same reasoning: removing Mullion's own
  // integration from the host is an operator action, never something an
  // in-session agent should be able to trigger against its own host.
  "bundle.remove": routeOp(["full"], () => ({
    method: "POST",
    url: "/api/bundle-sync/remove",
    payload: "{}",
  })),
};
