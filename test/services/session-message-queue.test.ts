import { describe, expect, it, vi } from "vitest";
import {
  MAX_MESSAGE_TTL_MS,
  MAX_QUEUED_PER_TARGET,
  SessionMessageQueue,
  WindowRateLimiter,
  type DeliverOutcome,
  type QueuedMessage,
  type TargetReadiness,
} from "../../src/services/session-message-queue.js";

function makeQueue(over: {
  check?: (m: QueuedMessage) => Promise<TargetReadiness>;
  deliver?: (m: QueuedMessage) => Promise<DeliverOutcome>;
  onChange?: (m: QueuedMessage) => void;
}) {
  let now = 1_000_000;
  const queue = new SessionMessageQueue({
    check: over.check ?? (async () => ({ state: "ready" })),
    deliver: over.deliver ?? (async () => ({ ok: true })),
    onChange: over.onChange,
    now: () => now,
    tickMs: 10,
  });
  return { queue, advance: (ms: number) => (now += ms) };
}

const send = (queue: SessionMessageQueue, target = 2, ttlMs = 60_000) =>
  queue.enqueue({ fromSessionId: 1, targetSessionId: target, text: "hello", ttlMs })!;

describe("SessionMessageQueue (#2270)", () => {
  it("delivers straight away to an idle target and reports it", async () => {
    const onChange = vi.fn();
    const deliver = vi.fn(async () => ({ ok: true }) as const);
    const { queue } = makeQueue({ deliver, onChange });
    const message = send(queue);
    expect(message.status).toBe("queued");
    await queue.tick();
    expect(queue.get(message.id)?.status).toBe("delivered");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: message.id, status: "delivered" }),
    );
    queue.stop();
  });

  it("holds a message while the target is busy or blocked, then delivers once it is idle", async () => {
    let state: TargetReadiness = { state: "wait" };
    const deliver = vi.fn(async () => ({ ok: true }) as const);
    const { queue } = makeQueue({ check: async () => state, deliver });
    const message = send(queue);
    await queue.tick();
    await queue.tick();
    expect(queue.get(message.id)?.status).toBe("queued");
    expect(deliver).not.toHaveBeenCalled();
    state = { state: "ready" };
    await queue.tick();
    expect(queue.get(message.id)?.status).toBe("delivered");
    queue.stop();
  });

  it("delivers a target's messages in order, one per pass", async () => {
    const order: string[] = [];
    const { queue } = makeQueue({
      deliver: async (m) => {
        order.push(m.text);
        return { ok: true };
      },
    });
    queue.enqueue({ fromSessionId: 1, targetSessionId: 2, text: "first", ttlMs: 60_000 });
    queue.enqueue({ fromSessionId: 1, targetSessionId: 2, text: "second", ttlMs: 60_000 });
    for (let i = 0; i < 4; i++) await queue.tick();
    expect(order).toEqual(["first", "second"]);
    queue.stop();
  });

  it("expires a message the target never became idle for", async () => {
    const { queue, advance } = makeQueue({ check: async () => ({ state: "wait" }) });
    const message = send(queue, 2, 5_000);
    await queue.tick();
    advance(6_000);
    await queue.tick();
    expect(queue.get(message.id)).toMatchObject({ status: "expired" });
    expect(queue.get(message.id)?.reason).toContain("idle");
  });

  it("refuses when the target is gone or the delivery fails for good, but retries a transient failure", async () => {
    const gone = makeQueue({ check: async () => ({ state: "refuse", reason: "agent_gone" }) });
    const a = send(gone.queue);
    await gone.queue.tick();
    expect(gone.queue.get(a.id)).toMatchObject({ status: "refused", reason: "agent_gone" });

    let attempt = 0;
    const flaky = makeQueue({
      deliver: async () =>
        ++attempt === 1 ? { ok: false, reason: "busy", retry: true } : { ok: true },
    });
    const b = send(flaky.queue);
    await flaky.queue.tick();
    expect(flaky.queue.get(b.id)?.status).toBe("queued");
    await flaky.queue.tick();
    expect(flaky.queue.get(b.id)?.status).toBe("delivered");

    const broken = makeQueue({ deliver: async () => ({ ok: false, reason: "not supported" }) });
    const c = send(broken.queue);
    await broken.queue.tick();
    expect(broken.queue.get(c.id)).toMatchObject({ status: "refused", reason: "not supported" });
    for (const q of [gone, flaky, broken]) q.queue.stop();
  });

  it("treats a throwing check or deliver as a refusal rather than crashing the pass", async () => {
    const { queue } = makeQueue({
      check: async () => {
        throw new Error("status unreadable");
      },
    });
    const message = send(queue);
    await queue.tick();
    expect(queue.get(message.id)).toMatchObject({ status: "refused", reason: "status unreadable" });
    const second = makeQueue({
      deliver: async () => {
        throw new Error("pty write failed");
      },
    });
    const other = send(second.queue);
    await second.queue.tick();
    expect(second.queue.get(other.id)).toMatchObject({
      status: "refused",
      reason: "pty write failed",
    });
  });

  it("caps what waits for one target and clamps the TTL", async () => {
    const { queue } = makeQueue({ check: async () => ({ state: "wait" }) });
    for (let i = 0; i < MAX_QUEUED_PER_TARGET; i++) expect(send(queue)).toBeTruthy();
    expect(
      queue.enqueue({ fromSessionId: 1, targetSessionId: 2, text: "x", ttlMs: 1_000 }),
    ).toBeNull();
    // Another target is unaffected.
    expect(
      queue.enqueue({ fromSessionId: 1, targetSessionId: 3, text: "x", ttlMs: 10 * 3_600_000 })!
        .expiresAt - 1_000_000,
    ).toBe(MAX_MESSAGE_TTL_MS);
    queue.stop();
  });

  it("waitUntilSettled resolves when the message leaves the queue", async () => {
    let state: TargetReadiness = { state: "wait" };
    const { queue } = makeQueue({ check: async () => state });
    const message = send(queue);
    const settled = queue.waitUntilSettled(message.id);
    state = { state: "ready" };
    await queue.tick();
    expect((await settled)?.status).toBe("delivered");
    expect(await queue.waitUntilSettled("nope")).toBeUndefined();
    queue.stop();
  });

  it("forgets finished messages after the retention window", async () => {
    const { queue, advance } = makeQueue({});
    const message = send(queue);
    await queue.tick();
    expect(queue.get(message.id)?.status).toBe("delivered");
    advance(2 * 60 * 60_000);
    send(queue, 9);
    await queue.tick();
    expect(queue.get(message.id)).toBeUndefined();
    queue.stop();
  });
});

describe("WindowRateLimiter", () => {
  it("allows the budget per window per key, then refuses, then resets", () => {
    let now = 0;
    const limiter = new WindowRateLimiter(2, 1_000, () => now);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
    expect(limiter.take("b")).toBe(true);
    now = 1_001;
    expect(limiter.take("a")).toBe(true);
  });
});
