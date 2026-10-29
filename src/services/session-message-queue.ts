// Issue #2270 — delivery of a message one session sends to another.
//
// `sessions.message` does not type into the target at once. The target may be mid-turn
// (typed text would land in its input box while it works) or on a permission dialog
// (typed text would answer it), so the text is QUEUED and delivered only when the target
// is idle, then framed with its source. This is the in-memory queue: bounded per target,
// with a TTL, and lost on a primary restart (a status lookup afterwards is a 404).
//
// The queue knows nothing about sessions or PTYs. Two callbacks, supplied by the control
// socket, do the work: `check` says whether the target can take text right now, `deliver`
// types it. That keeps the policy here and the terminal handling where it already lives.
import { randomUUID } from "node:crypto";

export type MessageStatus = "queued" | "delivered" | "expired" | "refused";

export interface QueuedMessage {
  id: string;
  fromSessionId: number;
  /** Who it is from, for the provenance line (the sender's project name). */
  fromLabel: string;
  targetSessionId: number;
  /** The text as sent (before provenance framing). */
  text: string;
  status: MessageStatus;
  /** Why it was refused or expired. */
  reason?: string;
  createdAt: number;
  expiresAt: number;
  finishedAt?: number;
}

/** What `check` reports about the target: deliver now, try again later, or give up. */
export type TargetReadiness =
  { state: "ready" } | { state: "wait" } | { state: "refuse"; reason: string };

export type DeliverOutcome = { ok: true } | { ok: false; reason: string; retry?: boolean };

export interface MessageQueueDeps {
  check: (message: QueuedMessage) => Promise<TargetReadiness>;
  deliver: (message: QueuedMessage) => Promise<DeliverOutcome>;
  /** Called whenever a message changes status (audit, wakes waiters). */
  onChange?: (message: QueuedMessage) => void;
  now?: () => number;
  tickMs?: number;
}

/** Most messages that may wait for one target. */
export const MAX_QUEUED_PER_TARGET = 8;
export const DEFAULT_MESSAGE_TTL_MS = 10 * 60_000;
export const MAX_MESSAGE_TTL_MS = 60 * 60_000;
export const MESSAGE_TICK_MS = 2_000;
/** Finished messages stay readable (status lookups) this long, and at most this many. */
const FINISHED_RETAIN_MS = 60 * 60_000;
const FINISHED_RETAIN_MAX = 500;

export class SessionMessageQueue {
  private readonly messages = new Map<string, QueuedMessage>();
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly tickMs: number;

  constructor(private readonly deps: MessageQueueDeps) {
    this.now = deps.now ?? Date.now;
    this.tickMs = deps.tickMs ?? MESSAGE_TICK_MS;
  }

  /** Queues a message. Returns null when the target already has the maximum waiting. */
  enqueue(input: {
    fromSessionId: number;
    fromLabel?: string;
    targetSessionId: number;
    text: string;
    ttlMs: number;
  }): QueuedMessage | null {
    const waiting = this.queuedFor(input.targetSessionId).length;
    if (waiting >= MAX_QUEUED_PER_TARGET) return null;
    const createdAt = this.now();
    const message: QueuedMessage = {
      id: randomUUID(),
      fromSessionId: input.fromSessionId,
      fromLabel: input.fromLabel ?? "",
      targetSessionId: input.targetSessionId,
      text: input.text,
      status: "queued",
      createdAt,
      expiresAt: createdAt + Math.min(Math.max(input.ttlMs, 1_000), MAX_MESSAGE_TTL_MS),
    };
    this.messages.set(message.id, message);
    this.arm();
    // Try straight away: an idle target should not wait a whole tick.
    void this.tick();
    return message;
  }

  get(id: string): QueuedMessage | undefined {
    return this.messages.get(id);
  }

  queuedFor(targetSessionId: number): QueuedMessage[] {
    return [...this.messages.values()].filter(
      (m) => m.status === "queued" && m.targetSessionId === targetSessionId,
    );
  }

  /** Resolves once the message leaves `queued` (it always does: the TTL ends it). */
  waitUntilSettled(id: string, signal?: AbortSignal): Promise<QueuedMessage | undefined> {
    return new Promise((resolve) => {
      const poll = (): void => {
        const message = this.messages.get(id);
        if (!message || message.status !== "queued" || signal?.aborted) {
          resolve(message);
          return;
        }
        setTimeout(poll, Math.min(this.tickMs, 500)).unref();
      };
      poll();
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private inflight: Promise<void> | null = null;

  /** One pass: expire what ran out, then deliver the head of each target's queue. A
   * call while a pass is running joins it rather than starting a second. */
  tick(): Promise<void> {
    if (this.inflight) return this.inflight;
    const pass = this.run().finally(() => {
      this.inflight = null;
    });
    this.inflight = pass;
    return pass;
  }

  private async run(): Promise<void> {
    try {
      const now = this.now();
      this.prune(now);
      const heads = new Map<number, QueuedMessage>();
      for (const message of this.messages.values()) {
        if (message.status !== "queued") continue;
        if (now >= message.expiresAt) {
          this.finish(message, "expired", "the target did not become idle in time");
          continue;
        }
        // Insertion order is arrival order, so the first seen per target is the oldest.
        if (!heads.has(message.targetSessionId)) heads.set(message.targetSessionId, message);
      }
      for (const message of heads.values()) await this.attempt(message);
    } finally {
      if (![...this.messages.values()].some((m) => m.status === "queued")) this.stop();
    }
  }

  private async attempt(message: QueuedMessage): Promise<void> {
    let readiness: TargetReadiness;
    try {
      readiness = await this.deps.check(message);
    } catch (err) {
      this.finish(message, "refused", err instanceof Error ? err.message : String(err));
      return;
    }
    if (readiness.state === "wait") return;
    if (readiness.state === "refuse") {
      this.finish(message, "refused", readiness.reason);
      return;
    }
    let outcome: DeliverOutcome;
    try {
      outcome = await this.deps.deliver(message);
    } catch (err) {
      outcome = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (message.status !== "queued") return;
    if (outcome.ok) this.finish(message, "delivered");
    else if (outcome.retry) return;
    else this.finish(message, "refused", outcome.reason);
  }

  private finish(message: QueuedMessage, status: MessageStatus, reason?: string): void {
    message.status = status;
    if (reason !== undefined) message.reason = reason;
    message.finishedAt = this.now();
    try {
      this.deps.onChange?.(message);
    } catch {
      // Auditing must never stop delivery.
    }
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref();
  }

  private prune(now: number): void {
    const finished = [...this.messages.values()].filter((m) => m.status !== "queued");
    for (const message of finished) {
      if (now - (message.finishedAt ?? now) > FINISHED_RETAIN_MS) this.messages.delete(message.id);
    }
    const left = finished.filter((m) => this.messages.has(m.id));
    for (const message of left.slice(0, Math.max(0, left.length - FINISHED_RETAIN_MAX))) {
      this.messages.delete(message.id);
    }
  }
}

/**
 * A fixed-window limiter per key (the sending session), in memory. `take` returns false
 * when the key has used its allowance for the current window.
 */
export class WindowRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; used: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): boolean {
    const now = this.now();
    const current = this.windows.get(key);
    if (!current || now - current.startedAt >= this.windowMs) {
      this.windows.set(key, { startedAt: now, used: 1 });
      // Opportunistic cleanup so a long-lived primary does not keep dead keys.
      if (this.windows.size > 1024) {
        for (const [k, w] of this.windows) {
          if (now - w.startedAt >= this.windowMs) this.windows.delete(k);
        }
      }
      return true;
    }
    if (current.used >= this.max) return false;
    current.used += 1;
    return true;
  }
}
