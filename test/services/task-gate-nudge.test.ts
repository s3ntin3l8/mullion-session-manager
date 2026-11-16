// failReviewingGate answers a no-commits gate failure with a continuation nudge
// first (task-nudge.ts), but only for an in_progress spell.
import { describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const { mockNudge } = vi.hoisted(() => ({ mockNudge: vi.fn() }));
vi.mock("../../src/services/task-nudge.js", () => ({ nudgeInsteadOfFailing: mockNudge }));

const { failReviewingGate } = await import("../../src/services/task-gate-failure.js");

describe("failReviewingGate and the continuation nudge", () => {
  it("returns without failing the task when a nudge was sent", async () => {
    mockNudge.mockResolvedValue(true);
    // Any use of these would throw — a nudged gate must touch nothing else.
    const untouched = new Proxy(
      {},
      {
        get: () => {
          throw new Error("touched after a nudge");
        },
      },
    );
    await expect(
      failReviewingGate(
        untouched as unknown as FastifyInstance,
        { id: 1 } as never,
        untouched as never,
        untouched as never,
        untouched as never,
        "in_progress",
        "agent ended its turn with no commits",
        new Date(),
        null,
      ),
    ).resolves.toBeUndefined();
    expect(mockNudge).toHaveBeenCalledTimes(1);
  });
});
