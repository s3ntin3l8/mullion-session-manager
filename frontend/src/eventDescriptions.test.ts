import { describe, it, expect } from "vitest";
import { describeEvent, describeLatestEvent, notifyKind } from "./eventDescriptions.js";
import type { NotificationEvent } from "./api.js";

function makeEvent(overrides: Partial<NotificationEvent>): NotificationEvent {
  return {
    seq: 1,
    sessionId: 1,
    kind: "attention",
    ts: Date.now(),
    payload: {},
    ...overrides,
  };
}

describe("eventDescriptions (Phase 2, issue #176)", () => {
  describe("describeEvent — hookNotification signal", () => {
    it("shows title and body when both present", () => {
      const event = makeEvent({
        kind: "attention",
        payload: {
          attention: true,
          signal: "hookNotification",
          title: "Build done",
          body: "0 errors",
        },
      });
      expect(describeEvent(event)).toEqual({ text: "Build done — 0 errors", attention: true });
    });

    it("falls back to title alone when body is missing", () => {
      const event = makeEvent({
        kind: "attention",
        payload: { attention: true, signal: "hookNotification", title: "Build done" },
      });
      expect(describeEvent(event)).toEqual({ text: "Build done", attention: true });
    });

    it("falls back to a generic message when neither is present", () => {
      const event = makeEvent({
        kind: "attention",
        payload: { attention: true, signal: "hookNotification" },
      });
      expect(describeEvent(event)).toEqual({ text: "Sent a notification", attention: true });
    });

    it("falls back to a generic message for an empty-string title, not blank text", () => {
      // Regression test: `title ?? fallback` would NOT fall back here since
      // "" is non-null/non-undefined — only `title || fallback` catches it.
      const event = makeEvent({
        kind: "attention",
        payload: { attention: true, signal: "hookNotification", title: "" },
      });
      expect(describeEvent(event)).toEqual({ text: "Sent a notification", attention: true });
    });
  });

  describe("describeEvent — reviewGate signal (the attention-flip half)", () => {
    it("shows the prompt when present", () => {
      const event = makeEvent({
        kind: "attention",
        payload: { attention: true, signal: "reviewGate", prompt: "Run rm -rf?" },
      });
      expect(describeEvent(event)).toEqual({
        text: "Waiting for review: Run rm -rf?",
        attention: true,
      });
    });

    it("falls back to a generic message with no prompt", () => {
      const event = makeEvent({
        kind: "attention",
        payload: { attention: true, signal: "reviewGate" },
      });
      expect(describeEvent(event)).toEqual({ text: "Waiting for review", attention: true });
    });
  });

  describe("describeEvent — agentIdle/promoteRequest/permissionRequest/planReady/elicitation signals (issue: extend surfaced session statuses)", () => {
    // These four attention signal kinds existed since PR #300/#301 but had
    // no dedicated case in this switch, so they all fell through to the
    // generic "Needs input" default — this locks in the specific text each
    // one now gets instead.
    it("describes agentIdle as Finished", () => {
      const event = makeEvent({
        kind: "attention",
        payload: { attention: true, signal: "agentIdle" },
      });
      expect(describeEvent(event)).toEqual({ text: "Finished", attention: true });
    });

    it("describes promoteRequest with its summary", () => {
      const event = makeEvent({
        kind: "attention",
        payload: {
          attention: true,
          signal: "promoteRequest",
          summary: "start work on the bug fix",
        },
      });
      expect(describeEvent(event)).toEqual({
        text: "Requested worktree promotion: start work on the bug fix",
        attention: true,
      });
    });

    it("describes promoteRequest with no summary generically", () => {
      const event = makeEvent({
        kind: "attention",
        payload: { attention: true, signal: "promoteRequest" },
      });
      expect(describeEvent(event)).toEqual({
        text: "Requested worktree promotion",
        attention: true,
      });
    });

    it("describes permissionRequest with its summary", () => {
      const event = makeEvent({
        kind: "attention",
        payload: { attention: true, signal: "permissionRequest", summary: "Bash: npm install" },
      });
      expect(describeEvent(event)).toEqual({
        text: "Needs permission: Bash: npm install",
        attention: true,
      });
    });

    it("describes planReady with its summary", () => {
      const event = makeEvent({
        kind: "attention",
        payload: { attention: true, signal: "planReady", summary: "Refactor the auth module" },
      });
      expect(describeEvent(event)).toEqual({
        text: "Plan ready: Refactor the auth module",
        attention: true,
      });
    });

    it("describes planReady with no summary generically", () => {
      const event = makeEvent({
        kind: "attention",
        payload: { attention: true, signal: "planReady" },
      });
      expect(describeEvent(event)).toEqual({ text: "Plan ready for review", attention: true });
    });

    it("describes elicitation with its server", () => {
      const event = makeEvent({
        kind: "attention",
        payload: { attention: true, signal: "elicitation", server: "my-mcp-server" },
      });
      expect(describeEvent(event)).toEqual({
        text: "Needs input (MCP: my-mcp-server)",
        attention: true,
      });
    });

    it("describes elicitation with no server generically", () => {
      const event = makeEvent({
        kind: "attention",
        payload: { attention: true, signal: "elicitation" },
      });
      expect(describeEvent(event)).toEqual({ text: "Needs input (MCP)", attention: true });
    });
  });

  describe("describeEvent — promote_request kind (issue: extend surfaced session statuses)", () => {
    it("was missing entirely before — now describes with its summary", () => {
      const event = makeEvent({
        kind: "promote_request",
        payload: { summary: "start work on the bug fix", suggestedBaseRef: "main" },
      });
      expect(describeEvent(event)).toEqual({
        text: "Requested worktree promotion: start work on the bug fix",
        attention: true,
      });
    });
  });

  describe("describeEvent — elicitation kind (issue: extend surfaced session statuses)", () => {
    it("describes state started as attention-worthy", () => {
      const event = makeEvent({
        kind: "elicitation",
        payload: { state: "started", server: "my-mcp-server" },
      });
      expect(describeEvent(event)).toEqual({
        text: "Needs input (MCP: my-mcp-server)",
        attention: true,
      });
    });

    it("describes state finished as resolved, not attention-worthy", () => {
      const event = makeEvent({ kind: "elicitation", payload: { state: "finished" } });
      expect(describeEvent(event)).toEqual({ text: "MCP input resolved", attention: false });
    });
  });

  describe("describeEvent — status_change progress phase", () => {
    it("describes a hook progress phase", () => {
      const event = makeEvent({ kind: "status_change", payload: { phase: "thinking" } });
      expect(describeEvent(event)).toEqual({ text: "Agent: thinking", attention: false });
    });

    it("appends detail when present (issue #321 — opencode retry backoff)", () => {
      const event = makeEvent({
        kind: "status_change",
        payload: { phase: "generating", detail: "retry attempt 2: rate limited" },
      });
      expect(describeEvent(event)).toEqual({
        text: "Agent: generating: retry attempt 2: rate limited",
        attention: false,
      });
    });
  });

  describe("describeEvent — file_change", () => {
    it.each([
      ["modify", "Changed"],
      ["create", "Created"],
      ["delete", "Deleted"],
    ] as const)("describes action %s as %s", (action, verb) => {
      const event = makeEvent({
        kind: "file_change",
        payload: { path: "src/index.ts", action },
      });
      expect(describeEvent(event)).toEqual({
        text: `${verb} src/index.ts`,
        attention: false,
      });
    });

    it("returns null when path is missing (future/malformed payload)", () => {
      const event = makeEvent({ kind: "file_change", payload: { action: "modify" } });
      expect(describeEvent(event)).toBeNull();
    });
  });

  describe("describeEvent — review_gate", () => {
    it("describes state waiting as attention-worthy, with the prompt", () => {
      const event = makeEvent({
        kind: "review_gate",
        payload: { state: "waiting", prompt: "Deploy to prod?" },
      });
      expect(describeEvent(event)).toEqual({
        text: "Waiting for review: Deploy to prod?",
        attention: true,
      });
    });

    it("describes state approved as resolved, not attention-worthy", () => {
      const event = makeEvent({ kind: "review_gate", payload: { state: "approved", prompt: "x" } });
      expect(describeEvent(event)).toEqual({ text: "Review approved", attention: false });
    });

    it("describes state denied as resolved, not attention-worthy", () => {
      const event = makeEvent({ kind: "review_gate", payload: { state: "denied", prompt: "x" } });
      expect(describeEvent(event)).toEqual({ text: "Review denied", attention: false });
    });
  });

  describe("describeLatestEvent — walks back through Phase 2 kinds too", () => {
    it("prefers the newest describable event across mixed kinds", () => {
      const events: NotificationEvent[] = [
        makeEvent({ seq: 1, kind: "file_change", payload: { path: "a.ts", action: "modify" } }),
        makeEvent({
          seq: 2,
          kind: "review_gate",
          payload: { state: "waiting", prompt: "Merge?" },
        }),
      ];
      expect(describeLatestEvent(events)).toEqual({
        text: "Waiting for review: Merge?",
        attention: true,
      });
    });
  });

  describe("notifyKind", () => {
    it("counts review_gate waiting as notification-worthy (attention)", () => {
      const event = makeEvent({ kind: "review_gate", payload: { state: "waiting", prompt: "x" } });
      expect(notifyKind(event)).toBe("attention");
    });

    it("does not count review_gate approved/denied as notification-worthy", () => {
      expect(
        notifyKind(makeEvent({ kind: "review_gate", payload: { state: "approved", prompt: "x" } })),
      ).toBeNull();
      expect(
        notifyKind(makeEvent({ kind: "review_gate", payload: { state: "denied", prompt: "x" } })),
      ).toBeNull();
    });

    it("does not count file_change as notification-worthy (routine, like title_change)", () => {
      const event = makeEvent({
        kind: "file_change",
        payload: { path: "a.ts", action: "modify" },
      });
      expect(notifyKind(event)).toBeNull();
    });

    it("counts a hook notification (kind attention, payload.attention true) as notification-worthy", () => {
      const event = makeEvent({
        kind: "attention",
        payload: { attention: true, signal: "hookNotification", title: "x", body: "y" },
      });
      expect(notifyKind(event)).toBe("attention");
    });

    // Rich statuses (issue: extend surfaced session statuses).
    it("counts promote_request as notification-worthy (was missing entirely)", () => {
      const event = makeEvent({ kind: "promote_request", payload: { summary: "x" } });
      expect(notifyKind(event)).toBe("attention");
    });

    it("counts elicitation state started as notification-worthy", () => {
      const event = makeEvent({ kind: "elicitation", payload: { state: "started" } });
      expect(notifyKind(event)).toBe("attention");
    });

    it("does not count elicitation state finished as notification-worthy", () => {
      const event = makeEvent({ kind: "elicitation", payload: { state: "finished" } });
      expect(notifyKind(event)).toBeNull();
    });
  });
});
