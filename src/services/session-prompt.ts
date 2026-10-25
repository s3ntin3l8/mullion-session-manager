import type { FastifyInstance } from "fastify";
import { getAdapterPromptFraming } from "./hook-adapters/index.js";
import type { OutputWaitResult } from "./output-wait.js";

// Types the text of a prompt into a running agent's PTY and submits it — the
// "lead agent drives a worker" primitive behind `sessions.prompt` (issue
// #1951 moved it out of plugins/control-socket.ts so the SAME delivery runs on
// whichever host owns the PTY: the control socket calls it for a local child,
// and the agent's `/internal/sessions/:id/prompt` route calls it for a remote
// one).
//
// The input goes through Session.writeAgentInput, NOT write(): a parent's
// prompt must not read as the human acknowledging the child's pending
// attention. It still starts a new turn (Session.beginAgentTurn) so a
// following wait can't match the previous turn's `finished`.

/** The longest a single remote output-wait request holds an agent's PTY
 * subscription open (see SessionBackend.waitOutput). */
export const REMOTE_WAIT_CHUNK_MS = 60_000;

/** A refusal, in the status-code vocabulary `sessions.prompt` replies with. */
export interface PromptRefusal {
  status: number;
  error: string;
}

export type PromptDelivery =
  | {
      ok: true;
      /** The PTY's byte counter BEFORE the prompt was typed — the cursor a
       * following wait_for_output hands back as `afterOffset`. */
      outputOffset: number;
      /** The session's event head right after the turn began; arms
       * `sessions.wait`'s "a new turn started" guard. */
      afterSeq: number;
    }
  | ({ ok: false } & PromptRefusal);

/** What `SessionBackend.prompt` reports — the delivery without the `afterSeq`
 * a remote host cannot usefully hand a primary (see sessions.prompt). */
export type PromptOutcome = { ok: true; outputOffset: number } | ({ ok: false } & PromptRefusal);

/** One output wait, as the control socket asks a host to run it. */
export interface WaitOutputRequest {
  match: string;
  regex: boolean;
  timeoutMs: number;
  /** A previous reply's `outputOffset`: output printed since then still counts. */
  afterOffset?: number;
  signal: AbortSignal;
  /** False once the CALLER is gone (a session-scoped waiter must stay active). */
  alive: () => boolean;
}

/** How an output wait ended. `notRunning` / `failed` are the two ways it
 * never got to wait: no live PTY for the id on that host, or the host could
 * not be asked. */
export type WaitOutputOutcome =
  | (Exclude<OutputWaitResult, { aborted: true }> & { outputOffset: number })
  | { aborted: true }
  | { notRunning: true }
  | ({ failed: true } & PromptRefusal);

/** Which of the two moments a caller-supplied check is being asked at. */
export type PromptCheckStage = "before" | "before-submit";

const promptLocks = new WeakMap<object, Promise<void>>();

/** Serializes `fn` per key (a Session): FIFO, and a throwing `fn` still releases. */
export async function withPromptLock<T>(key: object, fn: () => Promise<T>): Promise<T> {
  const previous = promptLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  promptLocks.set(
    key,
    previous.then(() => mine),
  );
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Delivers one prompt to session `id` on THIS process's PtyManager.
 *
 * `check` is the caller's own gate on whether typing is wise right now, asked
 * twice: before anything is typed, and again after the body is typed but
 * before Enter (a dialog can appear in the gap, and Enter would then ANSWER
 * it). The control socket injects its derived-status check (blocked / gone /
 * busy); the agent route passes none, because the primary has already made
 * that decision from the derived status before it proxies the prompt.
 *
 * `notRunning` is the 409 text for "no live PTY for this id here" — what a
 * dead session looks like locally, and what a session on ANOTHER host looks
 * like to the control socket.
 */
export async function deliverPrompt(
  app: FastifyInstance,
  id: string,
  opts: {
    text: string;
    submit: boolean;
    notRunning: string;
    check?: (stage: PromptCheckStage) => Promise<PromptRefusal | null>;
  },
): Promise<PromptDelivery> {
  const refuse = (r: PromptRefusal): PromptDelivery => ({ ok: false, ...r });
  const initial = app.pty.get(id);
  if (!initial || !initial.isAlive) return refuse({ status: 409, error: opts.notRunning });

  // One prompt at a time per session: two concurrent prompts would
  // interleave (body A, body B, Enter A, Enter B) into one merged prompt
  // and a stray empty submit.
  return withPromptLock(initial, async (): Promise<PromptDelivery> => {
    const session = app.pty.get(id);
    if (session !== initial || !session.isAlive) {
      return refuse({ status: 409, error: opts.notRunning });
    }
    const refusal = await opts.check?.("before");
    if (refusal) return refuse(refusal);
    const framing = getAdapterPromptFraming(session.command, opts.text, {
      bracketedPaste: session.bracketedPaste,
    });
    if (framing === null) {
      return refuse({
        status: 501,
        error: "prompt delivery is not supported for this session's agent",
      });
    }
    // Captured BEFORE writing, so a following wait_for_output can cover
    // everything the child printed in response (the prompt -> wait gap).
    const outputOffset = session.outputOffset;
    if (!session.writeAgentInput(framing.body)) {
      return refuse({
        status: 503,
        error: "the prompt was not delivered (write backpressure or no live process)",
      });
    }
    if (opts.submit) {
      await new Promise((resolve) => setTimeout(resolve, framing.submitDelayMs));
      if (app.pty.get(id) !== session || !session.isAlive) {
        return refuse({
          status: 409,
          error: "the session exited before the prompt could be submitted",
        });
      }
      // A dialog can appear during the gap; Enter would then ANSWER it.
      // The text is already typed and cannot be taken back, so say so.
      const lateRefusal = await opts.check?.("before-submit");
      if (lateRefusal) return refuse(lateRefusal);
      if (!session.writeAgentInput(framing.submit)) {
        return refuse({
          status: 503,
          error:
            "the prompt was typed but could not be submitted (it may still be in the input box)",
        });
      }
      session.beginAgentTurn();
    }
    // Armed AFTER beginAgentTurn(): its own agent_prompt event must not
    // count as "the child started a turn" — only a later, real event
    // (the agent's turn_start / progress hook) may satisfy the guard.
    return { ok: true, outputOffset, afterSeq: session.eventSeqHead };
  });
}
