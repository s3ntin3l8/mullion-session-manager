import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import net from "node:net";
import path from "node:path";
import { chmodSync, unlinkSync } from "node:fs";
import { parseHookMessage } from "../services/hook-protocol.js";
import type { ReviewGateHookMessage, BrowserActionHookMessage } from "../services/hook-protocol.js";
import type { Page } from "playwright";
import { eq } from "drizzle-orm";
import { sessions } from "../db/schema.js";
import {
  executeBrowserAction,
  executeBrowserFind,
  resolveSearchRoot,
} from "../routes/browser-automation.js";
import type { AgentAction, FindElementsBody } from "../routes/browser-automation.js";
import { DEFAULT_SETTINGS, getStoredSettings } from "../services/settings.js";
import {
  agentGuideSourceExists,
  readAgentGuideExcerpt,
  sessionAgentGuidePath,
} from "../services/agent-guide.js";
import { readSessionBriefing } from "../services/project-briefing.js";
import { isAuthEnabled } from "../services/auth.js";
import { reclaimSocketPath } from "../services/unix-socket.js";

// Issue #271, option 2 — the decision a human ultimately reaches for a
// pending `promote_request` (POST /api/sessions/:id/promote or
// .../promote/decline), delivered back down the still-open MCP-tool socket
// connection. "accepted" carries the new worktree session's own id/path so
// the model's tool result can tell it where its work moved; "declined"
// optionally carries a reason.
export type PromoteDecision =
  | { decision: "accepted"; worktreePath: string; newSessionId: number }
  | { decision: "declined"; reason?: string };

// Phase 2's structured agent-hook channel (issue #172) — a second,
// structured channel alongside the existing PTY-parsed one (attention-detect.ts):
// agents write newline-delimited JSON to this ONE shared Unix socket
// (PtyManager.hookSocketPath, injected into every session as
// MULLION_HOOK_SOCKET — see pty-manager.ts's Session.bootstrapMaster()) and
// this listener attributes each connection to a session via a handshake
// token (MULLION_HOOK_TOKEN), validated through app.pty.resolveToken().
//
// Every line after a successful handshake is validated against the wire
// protocol (issue #173, see hook-protocol.ts) — a malformed line gets a
// `{"error":...}` reply and the connection stays open (only a failed
// *handshake*, or an oversized/unterminated line, closes the connection
// outright); a valid one is routed into the Phase 1 notification event
// model via PtyManager.emitHookEvent() (issue #176, see pty-manager.ts's
// Session.emitHookEvent for the per-kind mapping).
//
// No impact on an agent that never connects: the socket exists (like the
// dtach sockets already do) but sits idle otherwise.

// Max bytes buffered per-connection before a line terminator (\n) arrives —
// guards against a single misbehaving or malicious connection growing this
// process's memory unbounded while waiting for a newline that never comes.
// Same "don't let a chatty/broken input source blow memory" posture as
// routes/events.ts's own backpressure cap, just for the read direction
// instead of the write direction.
const MAX_LINE_BYTES = 64 * 1024;

// Permission approval (Phase 2, issue #178, rescoped by #264 from a
// PreToolUse/Bash gate to a PermissionRequest-based one — see
// forwarder-core.mjs's mapClaudeCodePermissionRequest for why). A
// `review_gate {state: "waiting"}` message keeps its connection open (see
// handleConnection below) instead of the fire-and-forget notify-then-close
// every other hook kind uses; this map tracks that open connection per
// session so a later decision (POST /api/sessions/:id/review-gate, routed
// here via app.resolveHookGate) knows which socket to write the reply to.
//
// One gate at a time per session, by design: Claude Code (and any future
// gating agent) can in principle fire two PermissionRequest hooks
// concurrently for the same session (parallel tool calls), which would
// otherwise silently overwrite this map's entry — the human's decision
// would then only ever reach whichever connection registered *second*,
// leaving the first wedged until its own hook-level timeout. Rather than
// thread a correlation id through the wire protocol for a "minimal" slice, a
// second concurrent waiting gate for an already-pending session resolves
// immediately (see handleConnection) to "no_response" — falling through to
// the agent's own native prompt for that specific tool call, same as any
// other "nobody decided" outcome (Hermes review, PR #839) — and the first
// gate's own pending state is left completely undisturbed.
interface PendingGate {
  socket: net.Socket;
  timer: NodeJS.Timeout;
}

// Must stay comfortably below every gating adapter's own hook-level
// `timeout` (claude-code.ts's PermissionRequest entry sets 300s) — the whole
// point of owning a server-side timeout here, rather than relying solely on
// the forwarder's own internal one, is that Mullion controls the outcome and
// can update gateState accordingly; if the agent's own hook timeout fired
// first instead, its on-expiry behavior is per-agent and only confirmed for
// Claude Code (see the plan's PR9 timeout note).
//
// Hermes review, PR #839 — this timeout resolves to "no_response" (issue
// #264 rescope), NOT a fail-closed deny: nobody ever answering must fall
// through to the agent's own native prompt, the same as if Mullion weren't
// involved at all. In practice this server-side timer is mostly a backstop:
// the forwarder's own internal one (forwarder.mjs's GATE_TIMEOUT_MS, 280s)
// fires ~10s earlier and reaches the same "no_response" outcome first.
export const GATE_TIMEOUT_MS = 290_000;

// Issue #271, option 2 — the same "register an open connection, resolve it
// later" shape as PendingGate above, for a `promote_request` message: the
// `promote_to_worktree` MCP tool call stays blocked until a human resolves
// it via POST /api/sessions/:id/promote or .../promote/decline (deliberately
// blocking, not fire-and-forget — see the roadmap's "deterministic
// isolation, not a nudge the model could race past" reasoning). One promote
// request at a time per session, same reasoning as PendingGate: a second
// concurrent request is denied immediately rather than silently overwriting
// the first's pending state.
interface PendingPromote {
  socket: net.Socket;
  timer: NodeJS.Timeout;
}

// A human decision here waits on a person, not an agent's own tool-call
// budget — generous, but still bounded so a forgotten promote dialog
// doesn't wedge the model's tool call (and the MCP client it's running
// under) forever. Same magnitude as GATE_TIMEOUT_MS for the same reason:
// comfortably below a plausible client-side MCP tool timeout, so Mullion
// controls the fail-closed decision rather than the client's own timeout
// handling doing something unpredictable.
export const PROMOTE_TIMEOUT_MS = 290_000;

// Issue #405 — the short SessionStart pointer to a session's own copy of
// the shipped agent guide doc (docs/agent-guide.md), composed alongside
// (never in place of) the existing promote-flow seed — see the
// "session_start" branch below. Deliberately a few lines, not the guide
// itself: the guide is already on disk (Session.bootstrapMaster() ->
// writeSessionAgentGuide(), unconditional — see agent-guide.ts), so this
// only needs to make an agent aware it exists and summarize the one thing
// most likely to trip it up (the scope model) before it reads the rest.
//
// This reaches Claude Code, Codex, and agy sessions this way (issue #437,
// landing per-agent): forwarder-core.mjs's formatSessionStartOutput
// switches on `agent` and, as of this writing, produces a real reply for
// `"claude-code"`, `"codex"`, and `"agy"` (agy's own dialect is confirmed
// live against a real SessionStart firing, issue #715 — see that case's own
// doc comment) — opencode still falls through to `default: return {}`, silently dropping
// whatever additionalContext this plugin sends back (verified by reading
// forwarder-core.mjs directly, not assumed).
//
// opencode is NOT left without a mechanism, though — it gets a materially
// different one (issue #437c, hook-adapters/opencode.ts's prepareLaunch):
// the guide's full text loaded via its own `instructions` config, not this
// short pointer sentence. Confirmed live (not just by reading the adapter)
// that the injected content actually reaches the model's context — an
// `opencode run` probe against a real per-session config answered a
// question only the guide's body could answer. What that mechanism does
// NOT do is say "this is the Mullion agent guide, on disk at <path>" the
// way this pointer does; a production incident had an opencode session
// with the guide's content in context still fail to connect it to
// `agent-guide.md` by name when asked. Fixed at the source instead of
// here: agent-guide.ts's buildSessionAgentGuideContent now prepends a
// short self-identifying header to the per-session copy every agent reads
// (or, for opencode, has injected) — so this pointer and that header now
// say the same thing via two different channels.
export function buildAgentGuidePointer(guidePath: string, authEnabled: boolean): string {
  return [
    `Mullion agent guide available at ${guidePath}.`,
    authEnabled
      ? "You have session-scope control-socket access via MULLION_HOOK_TOKEN; MULLION_AUTH_TOKEN is never present in a session. Full scope ops (session list/create/kill, dock control, previews) will 403 — that's expected."
      : "This host has in-app auth disabled, so every control-socket connection (including yours) resolves to full scope — session list/create/kill, dock control, and previews are all reachable, not just session-scoped ops.",
  ].join("\n");
}

// Issue (agent-briefing follow-up to #405) — a live session empirically
// never opened the path buildAgentGuidePointer names (an agent told "the
// guide is available at <path>" has no reason to go read it mid-task). This
// wraps that same pointer with a short CONTENT excerpt ahead of it — the
// four env vars and a one-paragraph scope summary, read straight out of
// docs/agent-guide.md's own `mullion:tier1` marked region
// (readAgentGuideExcerpt) — so the load-bearing facts reach context
// directly instead of behind a path the agent has to choose to follow.
// `excerpt` is null on any install whose docs/agent-guide.md predates the
// markers; the pointer alone (today's behavior) is what that install falls
// back to.
export function buildAgentGuideBlock(
  excerpt: string | null,
  guidePath: string,
  authEnabled: boolean,
): string {
  return [excerpt, buildAgentGuidePointer(guidePath, authEnabled)].filter(Boolean).join("\n\n");
}

/** Writes a decision back to a still-open promote connection and clears its
 * bookkeeping — shared by the server-side timeout below and
 * app.resolvePendingPromote (called from POST /api/sessions/:id/promote and
 * .../promote/decline). Returns false, touching nothing, if no promote
 * request is currently pending for this session. */
function resolvePendingPromote(
  app: FastifyInstance,
  pendingPromotes: Map<string, PendingPromote>,
  sessionId: string,
  decision: PromoteDecision,
): boolean {
  const pending = pendingPromotes.get(sessionId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingPromotes.delete(sessionId);
  if (pending.socket.writable) {
    pending.socket.write(`${JSON.stringify(decision)}\n`);
  }
  app.pty.resolvePromote(sessionId, decision.decision);
  return true;
}

/** Writes a decision back to a still-open gate connection and clears its
 * bookkeeping — shared by the server-side timeout above and
 * app.resolveHookGate (called from POST /api/sessions/:id/review-gate).
 * Returns false, touching nothing, if no gate is currently pending for this
 * session (already resolved, timed out, or the connection died — see the
 * `close` handler below) so the caller can report "nothing to resolve"
 * rather than silently no-op.
 *
 * `decision` accepts a third value, "no_response" (issue #264 rescope), used
 * ONLY by the server-side timeout below and the duplicate-concurrent-gate
 * path — a real human decision from POST /api/sessions/:id/review-gate is
 * always "approved"/"denied". "no_response" is written to the socket
 * verbatim (the forwarder's formatGateDecision maps it to a bare `{}`,
 * falling through to the agent's own native prompt rather than denying the
 * tool call outright), and reported to app.pty.resolveGate/
 * SessionInfo.gateState as "lapsed" (issue #840/#844) — a distinct fourth
 * state from "denied", since nobody actually decided anything; the agent
 * fell through to its own prompt instead. */
function resolvePendingGate(
  app: FastifyInstance,
  pendingGates: Map<string, PendingGate>,
  sessionId: string,
  decision: { decision: "approved" | "denied" | "no_response"; reason?: string },
): boolean {
  const pending = pendingGates.get(sessionId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingGates.delete(sessionId);
  if (pending.socket.writable) {
    pending.socket.write(`${JSON.stringify(decision)}\n`);
  }
  app.pty.resolveGate(
    sessionId,
    decision.decision === "no_response" ? "lapsed" : decision.decision,
    decision.reason,
  );
  return true;
}

function handleConnection(
  app: FastifyInstance,
  socket: net.Socket,
  pendingGates: Map<string, PendingGate>,
  pendingPromotes: Map<string, PendingPromote>,
): void {
  let buffer = "";
  // null until the handshake line resolves to a real session id — every
  // subsequent line on this connection is attributed to it. A connection
  // that never completes a valid handshake never gets to send anything else
  // (see the `continue`/`return` shape below).
  let sessionId: string | null = null;

  socket.on("data", async (chunk: Buffer) => {
    socket.pause();
    try {
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_LINE_BYTES) {
        app.log.warn("hook connection sent an oversized line without a terminator, closing");
        socket.destroy();
        return;
      }

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (line.trim() === "") continue;

        if (sessionId === null) {
          let handshake: unknown;
          try {
            handshake = JSON.parse(line);
          } catch {
            app.log.warn("malformed hook handshake, closing connection");
            socket.destroy();
            return;
          }
          const token =
            typeof handshake === "object" &&
            handshake !== null &&
            typeof (handshake as { token?: unknown }).token === "string"
              ? (handshake as { token: string }).token
              : null;
          const resolved = token !== null ? app.pty.resolveToken(token) : undefined;
          if (resolved === undefined) {
            // Log only a short, non-secret prefix — enough to correlate
            // repeated warnings from the same stale session without exposing
            // the token itself. Distinguishing "no token at all" from "a
            // token that doesn't match anything" matters for diagnosis: the
            // latter, recurring for the same prefix, is exactly what a
            // session whose hookToken predates a Mullion restart looks like
            // (see loadOrCreateHookToken() in pty-manager.ts) — previously
            // indistinguishable from a malicious/misconfigured probe.
            const hint =
              token === null
                ? "no token presented"
                : `token ${token.slice(0, 8)}… not tracked by any live session (stale pre-restart token?)`;
            app.log.warn(
              `hook connection presented an unknown or invalid token, closing (${hint})`,
            );
            socket.destroy();
            return;
          }
          sessionId = resolved;
          continue;
        }

        const result = parseHookMessage(line);
        if (!result.ok) {
          // Malformed *message* (as opposed to a malformed *handshake*, which
          // closes the connection above) gets an error reply but keeps the
          // connection open — a single bad line from an otherwise-well-behaved
          // agent shouldn't force it to reconnect and re-handshake.
          if (socket.writable) {
            socket.write(`${JSON.stringify({ error: result.error })}\n`);
          }
          app.log.warn({ sessionId, error: result.error }, "malformed hook message");
          continue;
        }

        app.log.debug({ sessionId, message: result.message }, "hook message received");

        // Issue #178 — a blocking gate is the one message kind that keeps its
        // connection open rather than fire-and-forget (see forwarder.mjs's
        // runGate): register it so a later decision knows where to reply.
        // See PendingGate's doc comment above for why a second concurrent
        // waiting gate for the same session is denied immediately instead of
        // silently overwriting the first's pending state.
        // HookMessage's `UnknownHookMessage` fallback has a `kind: string`
        // (not a literal) plus a `[key: string]: unknown` index signature, so
        // TS can't discriminate `result.message` down to just
        // ReviewGateHookMessage from `kind === "review_gate"` alone — an
        // explicit cast (matching pty-manager.ts's Session.emitHookEvent) is
        // clearer than relying on `unknown === "waiting"` happening to
        // type-check. Safe: the protocol layer's validateReviewGate
        // (hook-protocol.ts) only ever produces a real ReviewGateHookMessage
        // for this kind, never UnknownHookMessage.
        if (
          result.message.kind === "review_gate" &&
          (result.message as ReviewGateHookMessage).state === "waiting"
        ) {
          // A `const` capture, not the outer `let sessionId` directly: the
          // setTimeout callback below is a separate function scope, and TS
          // doesn't carry the `sessionId !== null` narrowing established
          // above across that boundary for a mutable `let`.
          const sid: string = sessionId;
          if (pendingGates.has(sid)) {
            // Resolved immediately, on THIS connection only, as no_response —
            // NOT a denial (Hermes review, PR #839): a second concurrent tool
            // call genuinely has nobody deciding FOR IT specifically (the
            // human is answering the first, unrelated one), so it falls
            // through to the agent's own native prompt for that one, same as
            // every other "nobody answered" outcome — consistent with issue
            // #264's fall-through philosophy rather than an ambiguity-driven
            // exception to it. Deliberately does NOT reach
            // app.pty.emitHookEvent below: the first gate is still the one
            // truly pending, and routing this duplicate through emitHookEvent
            // would overwrite SessionInfo.gateState/gatePrompt with this
            // second prompt, even though pendingGates still points at the
            // first connection's socket. See PendingGate's doc comment above
            // for the full "why resolve immediately, not queue" reasoning.
            app.log.warn(
              { sessionId: sid },
              "a review gate is already pending for this session, falling through the newest one immediately",
            );
            if (socket.writable) {
              socket.write(
                `${JSON.stringify({
                  decision: "no_response",
                  reason: "another review is already pending for this session",
                })}\n`,
              );
            }
            continue;
          }
          const timer = setTimeout(() => {
            app.log.warn(
              { sessionId: sid },
              "review gate timed out waiting for a decision — falling through to the agent's own prompt",
            );
            resolvePendingGate(app, pendingGates, sid, {
              decision: "no_response",
              reason: "timed out waiting for a decision",
            });
          }, GATE_TIMEOUT_MS);
          pendingGates.set(sid, { socket, timer });
        }

        // Issue #271 — a `session_start` message is answered immediately, on
        // this same connection, rather than routed through emitHookEvent (it
        // has no Session-level state of its own — see
        // Session.emitHookEvent's "session_start" case). The stashed seed
        // (if any) is always already present by the time SessionStart fires
        // — but only because of issue #678's fix: session-lifecycle.ts's
        // createSessionRecord now stashes it BEFORE calling
        // resolveBackend(...).spawn(...), not after. Before that fix, POST
        // /api/sessions/:id/promote stashed the seed only after
        // createSessionRecord had already returned success — i.e. after the
        // new session's PTY had already spawned — so a fast-starting agent
        // could fire SessionStart before the stash ever landed, silently
        // dropping the seed. See PtyManager.stashSeed's own doc comment.
        if (result.message.kind === "session_start") {
          // Follow-up to #275 (gap #1): SessionStart is Claude Code's own
          // genuinely-first hook at cold start, and — because it's answered
          // here rather than through emitHookEvent — would otherwise never
          // latch Session.hooksProven, leaving a brand-new session's own
          // startup splash render exposed to the exact false positive #275
          // fixed. See Session.markHooksProven's doc comment.
          app.pty.markHooksProven(sessionId);
          const seed = app.pty.consumeSeed(sessionId);
          // Issue #405 — composed alongside the seed above, never in place
          // of it: consumeSeed() is single-use and already serves the
          // promote-to-worktree flow above, so this pointer is generated
          // fresh on every call instead of being stashed/consumed itself.
          //
          // `app.db` is absent on a multi-host "agent" role process (see
          // app.ts's role branch — hooksPlugin registers there too, with no
          // dbPlugin ahead of it), which has no settings DB of its own to
          // read; DEFAULT_SETTINGS.sessions.injectAgentGuide (true) is what
          // that role effectively always uses, regardless of what an
          // operator configured on the primary.
          const settings = app.db ? getStoredSettings(app.db) : DEFAULT_SETTINGS;
          const sessionsDir = path.dirname(app.pty.hookSocketPath);
          const guidePath = sessionAgentGuidePath(sessionsDir, sessionId);
          // agentGuideSourceExists(), not just the setting: a checkout/
          // install that hasn't shipped docs/agent-guide.md (see
          // agent-guide.ts) must never send an agent to read a path that
          // isn't there. Checked against the shipped SOURCE doc rather than
          // this specific session's own copy — see agentGuideSourceExists's
          // own doc comment for why (the per-session write and this
          // SessionStart reply race on different clocks; the source's
          // presence doesn't).
          const guideBlock =
            settings.sessions.injectAgentGuide && agentGuideSourceExists()
              ? buildAgentGuideBlock(readAgentGuideExcerpt(), guidePath, isAuthEnabled(app.config))
              : null;
          // Independent of injectAgentGuide — a different owner (the
          // PROJECT's own operating instructions, not Mullion's doc) and a
          // different clock (this reads the per-session copy
          // writeSessionBriefing already wrote at spawn time, same as the
          // opencode adapter's own existsSync check does — see
          // project-briefing.ts). Placed last in additionalContext: it's
          // the project's operative instruction set, and recency in a
          // small context block favors it.
          const briefing = settings.sessions.injectProjectBriefing
            ? readSessionBriefing(sessionsDir, sessionId)
            : null;
          const additionalContext = [seed, guideBlock, briefing].filter(Boolean).join("\n\n");
          if (socket.writable) {
            socket.write(`${JSON.stringify({ additionalContext })}\n`);
          }
          continue;
        }

        // Issue #271 — a `promote_request` keeps its connection open, same
        // shape as the review_gate branch above: register it so a later
        // decision knows where to reply, and deny a second concurrent
        // request for the same session immediately rather than overwrite the
        // first's pending state.
        if (result.message.kind === "promote_request") {
          const sid: string = sessionId;
          if (pendingPromotes.has(sid)) {
            app.log.warn(
              { sessionId: sid },
              "a promote request is already pending for this session, denying the newest one immediately",
            );
            if (socket.writable) {
              socket.write(
                `${JSON.stringify({
                  decision: "declined",
                  reason: "another promote request is already pending for this session",
                })}\n`,
              );
            }
            continue;
          }
          const timer = setTimeout(() => {
            app.log.warn({ sessionId: sid }, "promote request timed out waiting for a decision");
            resolvePendingPromote(app, pendingPromotes, sid, {
              decision: "declined",
              reason: "timed out waiting for a decision",
            });
          }, PROMOTE_TIMEOUT_MS);
          pendingPromotes.set(sid, { socket, timer });
        }

        if (result.message.kind === "browser_action") {
          const msg = result.message as BrowserActionHookMessage;
          const session = app.pty.get(sessionId);
          let projectId = session?.projectId;
          if (!projectId && app.db) {
            const [row] = app.db
              .select()
              .from(sessions)
              .where(eq(sessions.id, Number(sessionId)))
              .all();
            projectId = row?.projectId;
          }

          if (!projectId) {
            if (socket.writable) {
              socket.write(
                `${JSON.stringify({ error: `No project found for session ${sessionId}` })}\n`,
              );
            }
            continue;
          }

          if (!app.config.BROWSER_ENABLED) {
            if (socket.writable) {
              socket.write(`${JSON.stringify({ error: "Browser feature is disabled" })}\n`);
            }
            continue;
          }

          let page: Page;
          try {
            const managed = await app.browser.getOrLaunch(projectId);
            page = managed.page;
          } catch (err) {
            if (socket.writable) {
              socket.write(`${JSON.stringify({ error: (err as Error).message })}\n`);
            }
            continue;
          }

          try {
            let actionResult: unknown;
            if (msg.action === "find") {
              // `find`'s own schema (findElementsSchema) constrains `value` to a
              // plain string — only the general action path's "select" ever
              // carries the array form (AgentAction's `value: string | string[]`,
              // which is why BrowserActionHookMessage widened to match it).
              const findBody: FindElementsBody = {
                by: msg.by!,
                value: msg.value as string,
                name: msg.name,
                limit: msg.limit,
                frame: msg.frame,
              };
              // Issue #382 — this hook-socket path (the MCP use_browser/
              // browser_action tools) is a second call site for
              // executeBrowserFind, alongside the REST route
              // (src/routes/browser-automation.ts) — resolve `frame` here
              // too, or a frame-scoped `find` sent through the MCP tool
              // would silently search the whole page instead.
              const root = await resolveSearchRoot(page, msg.frame);
              actionResult = await executeBrowserFind(app, root, findBody);
            } else {
              const actionBody: AgentAction = msg as unknown as AgentAction;
              actionResult = await executeBrowserAction(app, page, actionBody, projectId);
            }

            if (socket.writable) {
              socket.write(`${JSON.stringify(actionResult)}\n`);
            }
          } catch (err) {
            if (socket.writable) {
              socket.write(`${JSON.stringify({ error: (err as Error).message })}\n`);
            }
          }
          continue;
        }

        app.pty.emitHookEvent(sessionId, result.message);
      }
    } finally {
      socket.resume();
    }
  });

  socket.on("error", (err) => {
    app.log.debug({ err, sessionId }, "hook connection error");
  });

  // A gate connection that closes WITHOUT a decision ever being written
  // (the forwarder process crashed, or something severed the connection)
  // must still resolve the gate rather than leave gateState stuck on
  // "waiting" forever — fail closed, same as the timeout above. Guarded on
  // `pendingGates.get(sessionId)?.socket === socket` (not just
  // `.has(sessionId)`) so this never clobbers a *different*, newer pending
  // gate for the same session id — resolvePendingGate() already deletes the
  // map entry as part of writing a real decision, so the ordinary
  // resolved-then-closed path is already a no-op by the time this fires.
  socket.on("close", () => {
    if (sessionId === null) return;
    if (pendingGates.get(sessionId)?.socket === socket) {
      resolvePendingGate(app, pendingGates, sessionId, {
        decision: "denied",
        reason: "hook connection closed before a decision was made",
      });
    }
    // Same fail-closed reasoning as the review-gate case above, guarded the
    // same way (by socket identity, not just session id) so this never
    // clobbers a different, newer pending promote for the same session.
    if (pendingPromotes.get(sessionId)?.socket === socket) {
      resolvePendingPromote(app, pendingPromotes, sessionId, {
        decision: "declined",
        reason: "hook connection closed before a decision was made",
      });
    }
  });
}

export const hooksPlugin = fp(async (app: FastifyInstance) => {
  const socketPath = app.pty.hookSocketPath;

  // Removes a genuinely stale socket file (a prior process that exited
  // without running this plugin's onClose — crash, kill -9 — leaves one
  // behind, and net.Server.listen() refuses to bind an already-existing
  // path even though nothing is actually listening on it anymore) but
  // throws instead of unlinking if something IS still live at this path —
  // see unix-socket.ts's own doc comment for the incident this prevents
  // (this socket path is injected into every spawned session, so a stray
  // dev backend started from inside one inherits it and would otherwise
  // silently hijack the real listener).
  await reclaimSocketPath(socketPath);

  // One Map per app instance (not module-level) — see PendingGate's doc
  // comment above. Shared by every connection this server ever accepts, and
  // by app.resolveHookGate below.
  const pendingGates = new Map<string, PendingGate>();
  const pendingPromotes = new Map<string, PendingPromote>();

  const openSockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
    handleConnection(app, socket, pendingGates, pendingPromotes);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  // 0600: this socket accepts session-attributed agent messages (eventually
  // review-gate decisions, issue #178) — filesystem perms are the first
  // line of defense alongside the per-session handshake token above. See
  // the roadmap's "Security & trust" design note.
  chmodSync(socketPath, 0o600);

  app.decorate("hookServer", server);

  // Issue #178 — the seam POST /api/sessions/:id/review-gate (via
  // session-backend.ts's LocalBackend, and /internal/sessions/:id/review-gate
  // for a remote host's own agent process) calls to deliver a real decision.
  // Returns false if no gate is currently pending for this session (already
  // resolved, timed out, or its connection died — see resolvePendingGate's
  // doc comment) so the route can report "nothing to resolve" instead of a
  // false success.
  app.decorate(
    "resolveHookGate",
    (sessionId: string, decision: "approved" | "denied", reason?: string): boolean =>
      resolvePendingGate(app, pendingGates, sessionId, { decision, reason }),
  );

  // Issue #271 — the seam POST /api/sessions/:id/promote and
  // .../promote/decline (via session-backend.ts's LocalBackend, and
  // /internal/sessions/:id/promote for a remote host's own agent process)
  // call to deliver a real decision to a pending promote_request.
  app.decorate("resolvePendingPromote", (sessionId: string, decision: PromoteDecision): boolean =>
    resolvePendingPromote(app, pendingPromotes, sessionId, decision),
  );

  // CodeQL (js/missing-rate-limiting) flags this hook: it performs a
  // filesystem access (unlinkSync) with no rate-limit decorator of its own.
  // Reviewed — not applicable, same category as the identical flag on
  // src/plugins/auth.ts's onRequest hook: `onClose` runs exactly once, at
  // graceful shutdown, triggered by this process's own lifecycle
  // (app.close()) — never per-request, never on any attacker-reachable
  // trigger a rate limiter could meaningfully throttle.
  app.addHook("onClose", async () => {
    // Issue #844 — resolve every gate still pending to "lapsed" BEFORE
    // destroying its socket, not after. This is a graceful stop, not a
    // forwarder failure: the wire reply is "no_response" (same as the
    // timeout/duplicate-gate paths above), so the agent falls through to its
    // own native prompt exactly as it would on a live timeout — but without
    // this, `socket.destroy()` below would instead trip the `close` handler,
    // which fail-closes to "denied" (correct for a genuine dropped
    // connection, wrong here: Mullion closed the socket on purpose). Getting
    // this right matters more than it looks — a "denied" persisted here is
    // what a restored session would boot back up showing, misrepresenting a
    // graceful restart as a real human denial. Snapshot the ids first:
    // resolvePendingGate() deletes from `pendingGates` as it resolves each
    // one, so iterating the live map while mutating it would skip entries.
    for (const sessionId of [...pendingGates.keys()]) {
      resolvePendingGate(app, pendingGates, sessionId, {
        decision: "no_response",
        reason: "Mullion is shutting down",
      });
    }
    for (const socket of openSockets) socket.destroy();
    openSockets.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    // Any gate/promote still pending at shutdown would otherwise leak its
    // timer past process lifetime (harmless once the process exits, but
    // real inside a single long-lived test run — see hooks.test.ts). Gates
    // are already resolved and removed by the loop above; this remains for
    // promotes (untouched by issue #844) and as a defensive no-op for gates.
    for (const pending of pendingGates.values()) clearTimeout(pending.timer);
    pendingGates.clear();
    for (const pending of pendingPromotes.values()) clearTimeout(pending.timer);
    pendingPromotes.clear();
    try {
      unlinkSync(socketPath);
    } catch {
      // Already gone is fine.
    }
  });
});

declare module "fastify" {
  interface FastifyInstance {
    hookServer: net.Server;
    resolveHookGate: (
      sessionId: string,
      decision: "approved" | "denied",
      reason?: string,
    ) => boolean;
    resolvePendingPromote: (sessionId: string, decision: PromoteDecision) => boolean;
  }
}
