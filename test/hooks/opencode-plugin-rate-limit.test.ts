// The rate-limit classification of an opencode v2 turn failure (issue #2505).
//
// Its own file, not a block in opencode-plugin.test.ts: that file is at the
// file-size ratchet's ceiling (scripts/check-max-file-lines.mjs), so it
// cannot grow — the same reason task-gate-failure.test.ts and
// task-claim-diagnostics.test.ts are files of their own.
//
// The plugin file is plain JS and exposes exactly one top-level export (the
// default), so the mapper is read off it as a property — see
// opencode-plugin.test.ts's own header for the full contract.

import { describe, it, expect } from "vitest";
import MullionHookEmitterDefault from "../../src/hooks/opencode-plugin.js";

type OpenCodeEventLike = {
  type?: unknown;
  data?: unknown;
  location?: { directory?: unknown };
  [key: string]: unknown;
};

const { mapOpenCodeEvent } = MullionHookEmitterDefault as typeof MullionHookEmitterDefault & {
  mapOpenCodeEvent: (
    event: OpenCodeEventLike | null | undefined,
    fallbackCwd?: string,
  ) => { kind: string; error?: string; errorDetails?: string; errorType?: string }[] | null;
};

/** v2's event envelope: the payload is under `data` (1.x: `properties`). */
const ev = (type: string, data: Record<string, unknown>) => ({ type, data });

/** The `stop_failure` a failed turn produces, or null when it produced none. */
function stopFailureFor(message: string) {
  const messages = mapOpenCodeEvent(
    ev("session.execution.failed", { error: { type: "provider.error", message } }),
  );
  const failure = messages?.find((m) => m.kind === "stop_failure");
  return failure ?? null;
}

describe("opencode-plugin.js — the rate-limit classification (issue #2505)", () => {
  // Issue #2495: an opencode worker on minimax-coding-plan ran its Token Plan
  // out mid-task. The message matched none of the rate-limit patterns, so the
  // failure carried no `errorType`, Task Master's grace window never engaged,
  // and the task was failed outright as "agent ended its turn with no
  // commits" — a provider plan running out, reported as the agent giving up.
  it("classifies the #2495 MiniMax plan-exhausted message as a rate_limit", () => {
    const message =
      "Token Plan usage limit reached: Upgrade your Token Plan or purchase Credits for more usage. (2056)";
    expect(stopFailureFor(message)).toEqual({
      kind: "stop_failure",
      error: message,
      errorDetails: message,
      errorType: "rate_limit",
    });
  });

  it("classifies the other plan-exhausted wording as a rate_limit", () => {
    expect(stopFailureFor("Your usage limit exceeded for this plan")?.errorType).toBe("rate_limit");
  });

  it("matches the usage-limit phrase case-insensitively", () => {
    expect(stopFailureFor("USAGE LIMIT REACHED")?.errorType).toBe("rate_limit");
  });

  // The narrowness is the point: the exact label "rate_limit" is what
  // task-reconciler.ts and task-rate-limit-grace.ts treat as "recoverable —
  // defer this task", so a loose match would defer a task that is genuinely
  // broken.
  it.each([
    ["your usage of 42 tokens per minute is fine", "usage alone is not the phrase"],
    ["the model exceeded its output limit", "limit alone is not the phrase"],
    ["context window usage limit", "the phrase needs reached/exceeded"],
    ["disk quota exceeded: no space left on device", "a disk quota is not a provider rate limit"],
    ["quota exceeded", "a bare quota is never a rate limit"],
    ["build (2056) failed", "the numeric code alone is not a rate limit"],
    ["(2056)", "the numeric code alone is not a rate limit"],
  ])("does not classify %j as a rate_limit failure (%s)", (message) => {
    expect(stopFailureFor(message)?.errorType).toBe("provider.error");
  });
});
