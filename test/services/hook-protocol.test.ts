import { describe, it, expect } from "vitest";
import { parseHookMessage } from "../../src/services/hook-protocol.js";

describe("parseHookMessage", () => {
  describe("transport-level failures", () => {
    it("rejects invalid JSON", () => {
      const result = parseHookMessage("not json at all");
      expect(result).toEqual({ ok: false, error: "malformed JSON" });
    });

    it("rejects a JSON array", () => {
      const result = parseHookMessage("[1,2,3]");
      expect(result.ok).toBe(false);
    });

    it("rejects a bare JSON primitive", () => {
      expect(parseHookMessage("42").ok).toBe(false);
      expect(parseHookMessage('"a string"').ok).toBe(false);
      expect(parseHookMessage("null").ok).toBe(false);
    });

    it("rejects an object with no kind field", () => {
      const result = parseHookMessage(JSON.stringify({ title: "hi" }));
      expect(result.ok).toBe(false);
    });

    it("rejects an object with a non-string kind field", () => {
      const result = parseHookMessage(JSON.stringify({ kind: 123 }));
      expect(result.ok).toBe(false);
    });

    it("rejects an object with an empty-string kind field", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "" }));
      expect(result.ok).toBe(false);
    });
  });

  describe("notification", () => {
    it("accepts a well-formed notification", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "notification", title: "Build done", body: "0 errors" }),
      );
      expect(result).toEqual({
        ok: true,
        message: { kind: "notification", title: "Build done", body: "0 errors" },
      });
    });

    it("rejects a notification missing title", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "notification", body: "x" }));
      expect(result.ok).toBe(false);
    });

    it("rejects a notification with a non-string body", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "notification", title: "x", body: 123 }),
      );
      expect(result.ok).toBe(false);
    });
  });

  describe("progress", () => {
    it.each(["thinking", "generating", "done"] as const)("accepts phase %s", (phase) => {
      const result = parseHookMessage(JSON.stringify({ kind: "progress", phase }));
      expect(result).toEqual({ ok: true, message: { kind: "progress", phase } });
    });

    it("rejects an unrecognized phase value", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "progress", phase: "sleeping" }));
      expect(result.ok).toBe(false);
    });

    it("rejects a missing phase field", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "progress" }));
      expect(result.ok).toBe(false);
    });
  });

  describe("file_change", () => {
    it.each(["modify", "create", "delete"] as const)("accepts action %s", (action) => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "file_change", path: "src/index.ts", action }),
      );
      expect(result).toEqual({
        ok: true,
        message: { kind: "file_change", path: "src/index.ts", action },
      });
    });

    it("rejects a missing path", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "file_change", action: "modify" }));
      expect(result.ok).toBe(false);
    });

    it("rejects an unrecognized action value", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "file_change", path: "x", action: "rename" }),
      );
      expect(result.ok).toBe(false);
    });
  });

  describe("review_gate", () => {
    it.each(["waiting", "approved", "denied"] as const)("accepts state %s", (state) => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "review_gate", state, prompt: "Run destructive command?" }),
      );
      expect(result).toEqual({
        ok: true,
        message: { kind: "review_gate", state, prompt: "Run destructive command?" },
      });
    });

    it("rejects an unrecognized state value", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "review_gate", state: "pending", prompt: "x" }),
      );
      expect(result.ok).toBe(false);
    });

    it("rejects a missing prompt", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "review_gate", state: "waiting" }));
      expect(result.ok).toBe(false);
    });
  });

  describe("fork/join", () => {
    it.each(["fork", "join"] as const)("accepts a well-formed %s message", (kind) => {
      const result = parseHookMessage(JSON.stringify({ kind, childPid: 1234 }));
      expect(result).toEqual({ ok: true, message: { kind, childPid: 1234 } });
    });

    it("rejects a non-numeric childPid", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "fork", childPid: "1234" }));
      expect(result.ok).toBe(false);
    });

    it("rejects a non-finite childPid", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "join", childPid: Infinity }));
      expect(result.ok).toBe(false);
    });

    it("rejects a missing childPid", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "join" }));
      expect(result.ok).toBe(false);
    });
  });

  // Follow-up to #275 (gap #2, issue #259) — opencode's permission.replied.
  describe("notification_resolved", () => {
    it("accepts a well-formed notification_resolved message, carrying no fields of its own", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "notification_resolved" }));
      expect(result).toEqual({ ok: true, message: { kind: "notification_resolved" } });
    });

    it("ignores extra fields the sender might include", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "notification_resolved", extra: "ignored" }),
      );
      expect(result).toEqual({ ok: true, message: { kind: "notification_resolved" } });
    });
  });

  describe("extensibility: unknown kinds", () => {
    it("accepts an unrecognized kind verbatim rather than rejecting it", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "future_thing", someField: "someValue", n: 1 }),
      );
      expect(result).toEqual({
        ok: true,
        message: { kind: "future_thing", someField: "someValue", n: 1 },
      });
    });

    it("passes through arbitrary extra fields on an unknown kind unmodified", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "worktree", action: "create", branch: "feat/x" }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message).toEqual({ kind: "worktree", action: "create", branch: "feat/x" });
      }
    });
  });
});
