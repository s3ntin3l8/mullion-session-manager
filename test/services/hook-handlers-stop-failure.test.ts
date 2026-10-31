// The stop_failure handler's own derivation of the session's error detail
// (hook-handlers.ts).
//
// Its own file: test/services/pty-manager.test.ts is at the file-size
// ratchet's ceiling (scripts/check-max-file-lines.mjs), so it cannot grow.
//
// Issue #2505 — the detail this handler derives is what the "no commits"
// failure reason quotes (checkReviewingGate, task-reconciler.ts). A provider
// error that ended the turn must be NAMED there, or the task card reads as
// if the agent gave up.

import { describe, it, expect, vi } from "vitest";
import { HOOK_HANDLERS, type SessionHookContext } from "../../src/services/hook-handlers.js";
import type { HookMessage } from "../../src/services/hook-protocol.js";
import MullionHookEmitterDefault from "../../src/hooks/opencode-plugin.js";
import { isRateLimitGraceActive } from "../../src/services/task-rate-limit-grace.js";

/**
 * The slice of the session context the stop_failure handler touches. The
 * handler is exercised directly (rather than through a real Session) because
 * the derivation under test is the only thing it does with these fields.
 */
function fakeContext() {
  return {
    errorState: "idle",
    errorAt: null,
    errorDetail: null,
    lastTurnEndedAt: null,
    cancelDeferred: vi.fn(),
    emitEvent: vi.fn(),
    emitAttentionSignalDeferred: vi.fn(),
  };
}

function stopFailure(message: HookMessage, ctx: ReturnType<typeof fakeContext>) {
  const handler = HOOK_HANDLERS.get("stop_failure");
  expect(handler).toBeDefined();
  handler!(ctx as unknown as SessionHookContext, message);
  return ctx;
}

describe("the stop_failure handler — the session's error detail (issue #2505)", () => {
  it("keeps the rate_limit label: it is the exact string the grace window matches on", () => {
    const ctx = stopFailure(
      {
        kind: "stop_failure",
        error: "Token Plan usage limit reached (2056)",
        errorType: "rate_limit",
      },
      fakeContext(),
    );

    expect(ctx.errorState).toBe("api_error");
    expect(ctx.errorDetail).toBe("rate_limit");
  });

  it("keeps a classification label when the adapter sent one", () => {
    const ctx = stopFailure(
      { kind: "stop_failure", error: "bad key", errorType: "provider.auth" },
      fakeContext(),
    );

    expect(ctx.errorDetail).toBe("provider.auth");
  });

  // Claude Code's StopFailure and agy's Stop carry the provider's message in
  // `error` and classify only the failures they recognize — an unrecognized
  // provider error arrived with no detail at all, and the failure reason had
  // nothing to show.
  it("falls back to the failing hook's own error text", () => {
    const ctx = stopFailure(
      { kind: "stop_failure", error: "API Error: 529 model overloaded" },
      fakeContext(),
    );

    expect(ctx.errorState).toBe("api_error");
    expect(ctx.errorDetail).toBe("API Error: 529 model overloaded");
  });

  it("prefers the adapter's free-text detail over the raw error text", () => {
    const ctx = stopFailure(
      { kind: "stop_failure", error: "unknown", errorDetails: "the provider said no" },
      fakeContext(),
    );

    expect(ctx.errorDetail).toBe("the provider said no");
  });

  it("has no detail for an empty error", () => {
    const ctx = stopFailure({ kind: "stop_failure", error: "" }, fakeContext());

    expect(ctx.errorDetail).toBeNull();
  });

  // The whole chain of issue #2505, end to end: the opencode plugin
  // classifies the provider's plan-exhausted message, this handler turns
  // that classification into the session's error detail, and the grace
  // window recognizes it — so the task is deferred instead of failed.
  it("defers a MiniMax plan-exhausted turn through the grace window", () => {
    const { mapOpenCodeEvent } = MullionHookEmitterDefault as typeof MullionHookEmitterDefault & {
      mapOpenCodeEvent: (event: unknown) => HookMessage[] | null;
    };
    const messages = mapOpenCodeEvent({
      type: "session.execution.failed",
      data: {
        error: {
          type: "provider.error",
          message:
            "Token Plan usage limit reached: Upgrade your Token Plan or purchase Credits for more usage. (2056)",
        },
      },
    });
    const ctx = stopFailure(messages![0], fakeContext());

    expect(ctx.errorDetail).toBe("rate_limit");
    expect(
      isRateLimitGraceActive(
        { errorState: ctx.errorState, errorDetail: ctx.errorDetail },
        { lastRateLimitAt: new Date() },
        { graceMinutes: 60, hasCommitsPastBase: false },
      ),
    ).toBe(true);
  });
});
