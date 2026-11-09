import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import { crossProjectAllowed, messageAllowed } from "../services/cross-project.js";
import {
  SessionMessageQueue,
  frameMessage,
  WindowRateLimiter,
  type DeliverOutcome,
  type QueuedMessage,
  type TargetReadiness,
} from "../services/session-message-queue.js";
import type { SessionSeverity, SessionStatus } from "../shared/types.js";
import {
  parseWaitTimeout,
  parseWaitUntil,
  waitForSession,
  type WaitSnapshot,
} from "../services/session-wait.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { resolveBackend } from "../services/session-backend.js";
import { deliverPrompt } from "../services/session-prompt.js";
import { adoptSurvivingSession } from "../services/session-adopt.js";
import {
  readSessionLiveInfo,
  resolveSessionHostId,
  withLiveInfo,
} from "../services/session-live-info.js";
import { getStoredSettings } from "../services/settings.js";
import { sessionRowIsActive } from "../services/control-session-authority.js";
import type { ConnectionState, ReplyPayload } from "./control-socket-core.js";
import {
  bad,
  buildAuthHeaders,
  injectAndShape,
  MAX_WAITS_PER_CONNECTION,
} from "./control-socket-core.js";

type ProjectRow = typeof projects.$inferSelect;

export const SESSION_SPAWN_CHILD_FIELDS: readonly string[] = [
  "command",
  "name",
  "cwd",
  "model",
  "smallModel",
  "seedPrompt",
  "open",
  "skipPermissions",
  "targetHostId",
  "targetPlatform",
  "isolate",
];

/**
 * Issue #2110 — resolves the `project` a coordinator named for a cross-project
 * spawn: a project id (a number, or a string of digits) or an EXACT project
 * name. A name that matches more than one project the caller may use -> 409,
 * asking for the id (project names are not unique).
 *
 * Issues #2123 / #2124 — only a project the source may reach AND that accepts it
 * (`allowed`) can be resolved. At session scope (`uniform`) everything else is the
 * SAME 403 — a project that does not exist, one outside the coordinator's list,
 * one that refuses coordinators — so a session cannot probe which projects and
 * names exist. Full scope is the operator and keeps the precise 404.
 */
export function resolveSpawnTarget(
  app: FastifyInstance,
  ref: unknown,
  rule: { allowed: (project: ProjectRow) => boolean; uniform: boolean },
): { ok: true; id: number } | { ok: false; reply: ReplyPayload } {
  const bad = (status: number, error: string) => ({
    ok: false as const,
    reply: { ok: false as const, status, error },
  });
  const refused = (notFound: string) =>
    rule.uniform ? bad(403, CROSS_PROJECT_TARGET_REFUSED) : bad(404, notFound);
  if (typeof ref === "number" || (typeof ref === "string" && /^\d+$/.test(ref.trim()))) {
    const id = Number(ref);
    const [row] = app.db.select().from(projects).where(eq(projects.id, id)).all();
    if (!row) return refused(`unknown project ${id}`);
    return rule.allowed(row) ? { ok: true, id: row.id } : bad(403, CROSS_PROJECT_TARGET_REFUSED);
  }
  if (typeof ref !== "string" || ref.trim() === "") {
    return bad(400, "'project' must be a project id or an exact project name");
  }
  const rows = app.db.select().from(projects).where(eq(projects.name, ref)).all();
  if (rows.length === 0) return refused(`unknown project "${ref}"`);
  const usable = rows.filter(rule.allowed);
  if (usable.length === 0) return bad(403, CROSS_PROJECT_TARGET_REFUSED);
  if (usable.length > 1) {
    return bad(
      409,
      `more than one project is named "${ref}" (ids ${usable.map((r) => r.id).join(", ")}); pass the id`,
    );
  }
  return { ok: true, id: usable[0]!.id };
}

const CROSS_PROJECT_TARGET_REFUSED =
  "no such project, or this session's project may not spawn children there " +
  "(see 'This project coordinates' and the target project's consent in Edit project)";

export const CROSS_PROJECT_DISABLED =
  "this session's project is not allowed to spawn children in other projects " +
  "(turn on 'This project coordinates' in Edit project)";

/** Whether `projectId` is a coordinator project (projects.allowCrossProjectSpawn). */
export function projectCoordinates(app: FastifyInstance, projectId: number): boolean {
  const [row] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
  return row?.allowCrossProjectSpawn === true;
}

/** The projects a session of `source` may start children in (the rule of
 * services/cross-project.ts), never including the source itself. */
export function allowedSpawnTargets(app: FastifyInstance, source: ProjectRow): ProjectRow[] {
  return app.db
    .select()
    .from(projects)
    .all()
    .filter((p) => p.id !== source.id && crossProjectAllowed(source, p));
}

/** 409 text for ops that need the child's live PTY when its host has none
 * for it: the session exited, or was never started there. (A child on ANOTHER
 * host is routed to that host — see childHostId — it is not this case.) */
export const NOT_LOCAL_MESSAGE = "the session is not running (it has no live process on its host)";

/** 503 text when a local child's scope could not be checked: not "not running". */
const UNVERIFIABLE_MESSAGE = "the session's liveness could not be verified, retry shortly";

/**
 * Issue #2271 — re-adopts a LOCAL child that survived a Mullion restart (its
 * scope is alive, PtyManager has not been told yet) before an op that needs
 * its live PTY or its live status. Resolves to a refusal when the scope could
 * not be checked (503, retryable); null otherwise, including for a dead
 * session — the op's own gate then answers it (409 "not running") as before.
 * A child on another host is that host's business.
 */
export async function adoptLocalChild(
  app: FastifyInstance,
  id: string,
): Promise<ReplyPayload | null> {
  if (childHostId(app, id) !== LOCAL_HOST_ID) return null;
  return (await adoptSurvivingSession(app, id)) === "unverifiable"
    ? bad(503, UNVERIFIABLE_MESSAGE)
    : null;
}

/** The host a session runs on: its own (`sessions.hostId`), else its project's.
 * "local" for an id with no row, so a stray id keeps today's local behaviour. */
export function childHostId(app: FastifyInstance, id: string): string {
  const row = app.db
    .select({ projectId: sessions.projectId, hostId: sessions.hostId })
    .from(sessions)
    .where(eq(sessions.id, Number(id)))
    .get();
  return row ? resolveSessionHostId(app, row) : LOCAL_HOST_ID;
}

export const enc = encodeURIComponent;

/**
 * The target-selecting fields a review/triage relay request may carry:
 * `prNumber`, and the `repo`/`branch` of work happening outside the session's
 * own project repo. Only fields the caller actually set are forwarded, so an
 * absent one keeps the route's own default; the route's schema validates them.
 */
export function relayTargetFields(
  body: Record<string, unknown> | undefined,
  keys: readonly string[] = ["prNumber", "repo", "branch"],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (body?.[key] !== undefined) out[key] = body[key];
  return out;
}

/** `?a=1&b=x` for the set fields, `""` for none. */
export function relayQuery(fields: Record<string, unknown>): string {
  const pairs = Object.entries(fields).map(([k, v]) => `${enc(k)}=${enc(String(v))}`);
  return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
}

export type WaitBodyOpts = {
  until: Set<string>;
  timeoutMs: number;
  afterSeq?: number;
};

/** Parses sessions.wait's (and sessions.prompt's `wait`) until/timeoutMs[/afterSeq]. */
export function parseWaitBody(
  body: Record<string, unknown> | undefined,
  { allowAfterSeq }: { allowAfterSeq: boolean },
): { ok: true; opts: WaitBodyOpts } | { ok: false; reply: ReplyPayload } {
  const until = parseWaitUntil(body?.until);
  if (!until.ok) return { ok: false, reply: bad(400, until.error) };
  const timeout = parseWaitTimeout(body?.timeoutMs);
  if (!timeout.ok) return { ok: false, reply: bad(400, timeout.error) };
  const afterSeq = allowAfterSeq ? body?.afterSeq : undefined;
  if (
    afterSeq !== undefined &&
    (typeof afterSeq !== "number" || !Number.isInteger(afterSeq) || afterSeq < 0)
  ) {
    return { ok: false, reply: bad(400, "'afterSeq' must be a non-negative integer") };
  }
  return {
    ok: true,
    opts: {
      until: until.until,
      timeoutMs: timeout.timeoutMs,
      ...(afterSeq !== undefined ? { afterSeq } : {}),
    },
  };
}

/** A session's derived status via the SAME REST path GET /api/sessions/:id
 * serves (so the derivation — and remote-host proxying — can't drift), or
 * null if it doesn't exist. Throws on any other failure. */
async function readDerivedStatus(app: FastifyInstance, id: string): Promise<WaitSnapshot | null> {
  const res = await injectAndShape(app, {
    method: "GET",
    url: `/api/sessions/${enc(id)}`,
    headers: buildAuthHeaders(app),
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(res.error ?? "unable to read session status");
  }
  const row = res.result as {
    sessionStatus: SessionStatus;
    sessionStatusSeverity: SessionSeverity;
    sessionStatusDetail: string | null;
  };
  return {
    status: row.sessionStatus,
    severity: row.sessionStatusSeverity,
    detail: row.sessionStatusDetail ?? null,
  };
}

/**
 * Issue #1962 — one FRESH read of a session that lives on another host: its
 * derived status (the same derivation `GET /api/sessions/:id` applies, via
 * `withLiveInfo`) plus the two fields of the host's own `SessionInfo` that the
 * primary cannot get anywhere else — the event head and whether a prompted
 * turn is in flight. `fresh` bypasses the host client's 1.5 s cache, which
 * could otherwise hand back the PREVIOUS turn's `finished` right after a
 * prompt. A host that does not answer is reported as suspended (as the REST
 * path does); one that answers with an error is thrown. `snapshot` is null for
 * a session that has no row.
 */
async function readRemoteSession(
  app: FastifyInstance,
  id: string,
  hostId: string,
): Promise<{ snapshot: WaitSnapshot | null; eventSeqHead?: number; turnInFlight: boolean }> {
  const row = app.db
    .select()
    .from(sessions)
    .where(eq(sessions.id, Number(id)))
    .get();
  if (!row) return { snapshot: null, turnInFlight: false };
  const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
  const live = await readSessionLiveInfo(app, row, idleThresholdMs, hostId, { fresh: true });
  // A host that ANSWERED and refused (a 429 from its rate limit, a stale
  // token) is not a host that is down: reporting it as `suspended` would let a
  // wait run to its timeout blaming a dead host. Throw it, so the wait's
  // consecutive-failure limit ends it with the real reason (and a prompt's
  // pre-check answers 500 with it). An unreachable host stays `suspended`.
  if (live.failure === "refused") throw live.error;
  const view = withLiveInfo(app, row, live.info, hostId, {
    hostReachable: live.hostReachable,
    hostBusy: live.failure === "busy",
  });
  return {
    snapshot: {
      status: view.sessionStatus,
      severity: view.sessionStatusSeverity,
      detail: view.sessionStatusDetail ?? null,
    },
    eventSeqHead: live.info?.eventSeqHead,
    turnInFlight: live.info?.agentTurnInFlight === true,
  };
}

/**
 * Runs one server-side wait on `id` for this connection and maps the outcome
 * to a reply. Enforces MAX_WAITS_PER_CONNECTION, aborts on socket close
 * (returns null — nobody left to reply to), and, for a session-scoped
 * waiter, requires it to stay active for the whole wait.
 */
export async function runWait(
  app: FastifyInstance,
  conn: ConnectionState,
  id: string,
  opts: WaitBodyOpts,
  // `expectGuard`: the caller just delivered a prompt, so the "a new turn
  // started" guard is part of what it asked for. A remote host that cannot arm
  // it (an agent build that reports no event head) is then SAID so in the
  // reply, rather than the wait quietly losing its protection.
  extra: { expectGuard?: boolean } = {},
): Promise<ReplyPayload | null> {
  if ((conn.activeWaits ?? 0) >= MAX_WAITS_PER_CONNECTION) {
    return bad(429, "too many pending waits on this connection");
  }
  const controller = new AbortController();
  const onClose = () => controller.abort();
  const offClose = conn.onClose(onClose);
  conn.activeWaits = (conn.activeWaits ?? 0) + 1;
  // Issue #1962 — a child on another host has no Session in THIS process's
  // PtyManager, so its event head, its events and its status all come from
  // that host: every read below is a fresh one over the wire, and the wait is
  // woken by its 1 s tick (the host's events do not reach this process).
  const remoteHostId = childHostId(app, id);
  const remote = remoteHostId !== LOCAL_HOST_ID;
  // The host's event head as of the last read. `headSeen` stays false when the
  // host never reports one (an agent build that predates the field): the
  // "a new turn started" guard is then disabled (today's behaviour), not
  // stuck closed.
  let remoteHead = 0;
  let headSeen = false;
  const eventSeqHead = (): number => {
    if (!remote) return app.pty.get(id)?.eventSeqHead ?? 0;
    if (headSeen) return remoteHead;
    // Only the guard sees this stand-in (anything but `afterSeq` opens it);
    // it is never reported as the child's counter — see `resultSeq`.
    return opts.afterSeq === undefined ? 0 : opts.afterSeq + 1;
  };
  // The `eventSeq` in the reply: the host's real counter, or 0 ("none") for a
  // host that never reported one — never the stand-in above, which is not a
  // cursor the host produced.
  const resultSeq = (): number =>
    remote ? (headSeen ? remoteHead : 0) : (app.pty.get(id)?.eventSeqHead ?? 0);
  try {
    const result = await waitForSession(opts, {
      signal: controller.signal,
      // A session-scoped waiter must stay active for the whole wait (the
      // same rule resolveOwnedSessionId applies at the start).
      authorized: () => conn.scope !== "session" || sessionRowIsActive(app, conn.sessionId!),
      readStatus: remote
        ? async () => {
            const read = await readRemoteSession(app, id, remoteHostId);
            if (read.eventSeqHead !== undefined) {
              remoteHead = read.eventSeqHead;
              headSeen = true;
            }
            return read.snapshot;
          }
        : () => readDerivedStatus(app, id),
      eventSeqHead,
      // Bound ONCE, at wait start. If the child's Session isn't in app.pty
      // yet (or is replaced mid-wait) this is a no-op and the wait is woken
      // only by the 1 s tick — added latency, not a correctness gap (a
      // `gone` child still matches via readStatus).
      subscribe: remote
        ? () => () => {}
        : (listener) => app.pty.get(id)?.onEvent(() => listener()) ?? (() => {}),
    });
    if ("aborted" in result) return null;
    // Without a head from the host (or an `afterSeq` from its prompt reply)
    // the guard ran open: a wait that matched may have matched the PREVIOUS
    // turn. Tell the caller, so it can cross-check with `wait_for_output`.
    const guardDisabled =
      extra.expectGuard === true && remote && (opts.afterSeq === undefined || !headSeen);
    return {
      ok: true,
      status: 200,
      result: {
        ...result,
        eventSeq: resultSeq(),
        ...(guardDisabled ? { guardDisabled: true } : {}),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return message === "session not found"
      ? bad(404, message)
      : message === "not authorized"
        ? bad(403, "this session is no longer active")
        : bad(500, message);
  } finally {
    conn.activeWaits -= 1;
    offClose();
  }
}

/** A 409 reply if typing into this session now would be wrong — it is
 * `blocked` on a dialog (typing would answer it) or gone — else null. Re-reads
 * the derived status, so it is accurate at the moment it runs. */
export async function refuseIfBlockedOrGone(
  app: FastifyInstance,
  id: string,
  opts: { note?: string; refuseBusy?: boolean } = {},
): Promise<ReplyPayload | null> {
  let snapshot: WaitSnapshot | null;
  // Whether a prompted turn is in flight — read from the host that owns the
  // session (issue #1962), as only that host's PtyManager knows.
  let turnInFlight: boolean;
  const hostId = childHostId(app, id);
  try {
    if (hostId === LOCAL_HOST_ID) {
      snapshot = await readDerivedStatus(app, id);
      turnInFlight = app.pty.get(id)?.agentTurnInFlight === true;
    } else {
      const read = await readRemoteSession(app, id, hostId);
      snapshot = read.snapshot;
      turnInFlight = read.turnInFlight;
    }
  } catch (err) {
    return bad(500, err instanceof Error ? err.message : String(err));
  }
  if (snapshot === null) return bad(404, "session not found");
  if (snapshot.severity === "blocked") {
    return bad(
      409,
      `agent_blocked: the session is ${snapshot.status} — typing would answer its dialog; resolve that first${opts.note ?? ""}`,
    );
  }
  if (snapshot.severity === "gone") {
    return bad(409, `agent_gone: the session is ${snapshot.status}${opts.note ?? ""}`);
  }
  // A prompt that will be WAITED on must start from a quiet agent: a child
  // that is mid-turn queues the paste, so the in-flight turn's end would
  // satisfy the wait before the prompted turn ever ran.
  // Name the in-flight turn only when that is what fired: a child that is busy
  // on background tasks / subagents can be so AFTER its turn ended.
  if (opts.refuseBusy && (snapshot.severity === "busy" || turnInFlight)) {
    return bad(
      409,
      `agent_busy: the session is ${snapshot.status}${turnInFlight ? " with a prompted turn still in flight" : ""} — prompt without \`wait\` to queue the ` +
        'message, or let it go quiet first (sessions.wait with until=["done","dormant"]; ' +
        "the default `until` never matches a child that stays busy on background tasks or subagents)",
    );
  }
  return null;
}

// Op registry — the extension point every later Phase 4 PR (4.2–4.5) appends
// to, same "adding an op is a table entry, never a dispatch-loop change"
// shape as src/mcp/tools.mjs's own TOOLS registry. Request/response ops
// (this PR's three) call `reply()` exactly once; a future streaming op
// (sessions.attach, events.subscribe) instead holds the connection open and
// emits its own `{id, type, ...}` frames outside this envelope — see
// docs/socket-api.md's stream section — without needing any change to
// handleConnection's dispatch loop below.
/** Exported for the scope-matrix test in test/plugins/control-socket.test.ts. */

// ---------------------------------------------------------------------------
// Issue #2270 — sessions.message: a coordinator's session hands text to an already
// running TOP-LEVEL session in another project, with that project's consent.
// ---------------------------------------------------------------------------

/** Most bytes of one message. Smaller than a prompt: this is a note, not a task. */
export const MAX_MESSAGE_BYTES = 8 * 1024;
export const MAX_MESSAGE_TTL_SECONDS = 3600;
/** Messages one session may send per minute. */
export const MESSAGES_PER_MINUTE = 10;

/** One uniform 403 for every reason a message is not allowed (no such session, a
 * child, the sender's own project, a project that has not opted in, ...), decided from
 * rows alone, so a sender cannot probe which sessions and projects exist. */
export const MESSAGE_REFUSED =
  "no such session, or this session may not message it " +
  "(a coordinator project, and a target project that accepts messages from it, are required)";

/** Null when `callerId` may message the running top-level session `targetId`. */
export function messageRefusal(
  app: FastifyInstance,
  callerId: number,
  targetId: number,
): string | null {
  if (callerId === targetId) return MESSAGE_REFUSED;
  const rows = app.db
    .select({
      id: sessions.id,
      status: sessions.status,
      parentSessionId: sessions.parentSessionId,
      projectId: sessions.projectId,
    })
    .from(sessions)
    .where(inArray(sessions.id, [callerId, targetId]))
    .all();
  const caller = rows.find((row) => row.id === callerId);
  const target = rows.find((row) => row.id === targetId);
  if (!caller || !target || target.status !== "active" || target.parentSessionId !== null) {
    return MESSAGE_REFUSED;
  }
  if (caller.projectId === null || target.projectId === null) return MESSAGE_REFUSED;
  const [callerProject] = app.db
    .select()
    .from(projects)
    .where(eq(projects.id, caller.projectId))
    .all();
  const [targetProject] = app.db
    .select()
    .from(projects)
    .where(eq(projects.id, target.projectId))
    .all();
  return messageAllowed(callerProject, targetProject) ? null : MESSAGE_REFUSED;
}

const isBusyOrBlocked = (error: string | undefined): boolean =>
  typeof error === "string" && /^agent_(busy|blocked)\b/.test(error);

interface MessageState {
  queue: SessionMessageQueue;
  limiter: WindowRateLimiter;
}
export const messageStates = new WeakMap<FastifyInstance, MessageState>();

export function messageState(app: FastifyInstance): MessageState {
  const existing = messageStates.get(app);
  if (existing) return existing;
  const queue = new SessionMessageQueue({
    // Re-decided at delivery time: consent can be revoked, the sender can die, the
    // target can finish or start a turn in the meantime.
    check: async (message): Promise<TargetReadiness> => {
      if (messageRefusal(app, message.fromSessionId, message.targetSessionId) !== null) {
        return { state: "refuse", reason: "no longer permitted" };
      }
      if (!sessionRowIsActive(app, String(message.fromSessionId))) {
        return { state: "refuse", reason: "the sender is no longer active" };
      }
      const refusal = await refuseIfBlockedOrGone(app, String(message.targetSessionId), {
        refuseBusy: true,
      });
      if (refusal === null) return { state: "ready" };
      // Busy and blocked wait for the target to settle. So does a server-side failure
      // reading its status (a remote host unreachable for a moment): the TTL bounds it,
      // and a note must not be lost to a one-tick blip. Gone, unknown and unsupported
      // sessions are final.
      const error = refusal.ok ? undefined : refusal.error;
      if (isBusyOrBlocked(error) || (!refusal.ok && (refusal.status ?? 0) >= 500)) {
        return { state: "wait" };
      }
      return { state: "refuse", reason: error ?? "refused" };
    },
    deliver: async (message): Promise<DeliverOutcome> => {
      const id = String(message.targetSessionId);
      const text = frameMessage(message);
      const hostId = childHostId(app, id);
      if (hostId !== LOCAL_HOST_ID) {
        const outcome = await resolveBackend(app, hostId).prompt(id, { text, submit: true });
        return outcome.ok
          ? { ok: true }
          : { ok: false, reason: outcome.error, retry: isBusyOrBlocked(outcome.error) };
      }
      const unverifiable = await adoptLocalChild(app, id);
      if (unverifiable) return { ok: false, reason: UNVERIFIABLE_MESSAGE, retry: true };
      // Set once a refusal comes AFTER the text was typed (the dialog appeared in the gap
      // before Enter): the text may still sit in the target's input box, so typing it
      // again on a retry would double it. That one is final.
      let typedBeforeRefusal = false;
      const delivery = await deliverPrompt(app, id, {
        text,
        submit: true,
        notRunning: NOT_LOCAL_MESSAGE,
        check: async (stage) => {
          const refusal = await refuseIfBlockedOrGone(
            app,
            id,
            stage === "before"
              ? { refuseBusy: true }
              : {
                  note: " — the text was typed but NOT submitted and may still be in its input box",
                },
          );
          if (refusal && !refusal.ok && stage !== "before") typedBeforeRefusal = true;
          return refusal && !refusal.ok
            ? { status: refusal.status ?? 500, error: refusal.error ?? "refused" }
            : null;
        },
      });
      return delivery.ok
        ? { ok: true }
        : {
            ok: false,
            reason: delivery.error,
            retry: !typedBeforeRefusal && isBusyOrBlocked(delivery.error),
          };
    },
    onChange: (message) => auditMessage(app, message),
  });
  const state = { queue, limiter: new WindowRateLimiter(MESSAGES_PER_MINUTE, 60_000) };
  messageStates.set(app, state);
  return state;
}

/** Logs a message's outcome and records it on both sessions' event history (where the
 * session lives on this primary; a session on another host is covered by the log). */
function auditMessage(app: FastifyInstance, message: QueuedMessage): void {
  const detail = {
    messageId: message.id,
    from: message.fromSessionId,
    to: message.targetSessionId,
    status: message.status,
    ...(message.reason !== undefined ? { reason: message.reason } : {}),
  };
  app.log.info(detail, "sessions.message");
  app.pty.get(String(message.fromSessionId))?.emitMessageEvent("message_sent", detail);
  if (message.status === "delivered") {
    app.pty.get(String(message.targetSessionId))?.emitMessageEvent("message_received", {
      ...detail,
      bytes: Buffer.byteLength(message.text, "utf8"),
    });
  }
}

export function describeMessage(message: QueuedMessage): Record<string, unknown> {
  return {
    messageId: message.id,
    status: message.status,
    targetSessionId: message.targetSessionId,
    createdAt: message.createdAt,
    expiresAt: message.expiresAt,
    ...(message.reason !== undefined ? { reason: message.reason } : {}),
    ...(message.finishedAt !== undefined ? { finishedAt: message.finishedAt } : {}),
  };
}
