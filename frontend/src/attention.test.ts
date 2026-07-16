import { describe, it, expect } from "vitest";
import { isUnreadAttention } from "./attention.js";
import type { Session } from "./api.js";

// Minimal fixture matching api.ts's Session shape — only `attention` and
// `attentionAt` vary per test, everything else is fixed filler.
function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 1,
    projectId: 1,
    name: "test",
    command: "bash",
    cwd: null,
    kind: "terminal",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastAttachedAt: null,
    alive: true,
    subscriberCount: 0,
    activity: "idle",
    lastActivityAt: null,
    attention: false,
    attentionAt: null,
    lastTitle: null,
    ...overrides,
  };
}

describe("isUnreadAttention", () => {
  it("is false when the session has no live attention flag", () => {
    const session = makeSession({ attention: false, attentionAt: 1000 });
    expect(isUnreadAttention(session, { 1: 0 })).toBe(false);
  });

  it("is true when attention is set and the session was never acknowledged", () => {
    const session = makeSession({ attention: true, attentionAt: 1000 });
    expect(isUnreadAttention(session, {})).toBe(true);
  });

  it("is false once acknowledged at the session's current attentionAt", () => {
    const session = makeSession({ attention: true, attentionAt: 1000 });
    expect(isUnreadAttention(session, { 1: 1000 })).toBe(false);
  });

  it("re-surfaces as unread once a new bell moves attentionAt past the acknowledged value", () => {
    const acked = { 1: 1000 };
    const rangAgain = makeSession({ attention: true, attentionAt: 2000 });
    expect(isUnreadAttention(rangAgain, acked)).toBe(true);
  });

  it("treats a null attentionAt as older than any acknowledged timestamp", () => {
    const session = makeSession({ attention: true, attentionAt: null });
    expect(isUnreadAttention(session, { 1: 0 })).toBe(false);
  });
});
