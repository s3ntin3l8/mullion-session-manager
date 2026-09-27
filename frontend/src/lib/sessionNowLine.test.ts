import { describe, expect, it } from "vitest";
import type { NotificationEvent } from "../api/index.js";
import { makeSession } from "../test/fixtures.js";
import { deriveNowLine } from "./sessionNowLine.js";

function fileChangeEvent(seq: number, path: string): NotificationEvent {
  return { seq, sessionId: 1, kind: "file_change", ts: seq, payload: { path, action: "modify" } };
}

function titleEvent(seq: number, title: string): NotificationEvent {
  return { seq, sessionId: 1, kind: "title_change", ts: seq, payload: { title } };
}

describe("deriveNowLine", () => {
  it("returns null for an exited session, regardless of leftover state", () => {
    const session = makeSession({
      sessionStatus: "exited",
      sessionStatusSeverity: "gone",
      lastAssistantMessage: "leftover",
      currentTodo: { content: "old task", status: "in_progress" },
    });
    expect(deriveNowLine(session, [], "claude code")).toBeNull();
  });

  describe("attention tones (blocked/failed/needs_input)", () => {
    it("prefixes the matching attention event's text with a warning glyph", () => {
      const session = makeSession({
        sessionStatus: "awaiting_plan",
        sessionStatusSeverity: "blocked",
      });
      const events: NotificationEvent[] = [
        { seq: 1, sessionId: 1, kind: "plan_ready", ts: 1, payload: {} },
      ];
      const line = deriveNowLine(session, events, "claude code");
      expect(line).toEqual({ tone: "attention", text: "⚠ Plan ready for review", suffix: null });
    });

    it("falls back to the status label when no event describes the attention", () => {
      const session = makeSession({
        sessionStatus: "awaiting_permission",
        sessionStatusSeverity: "blocked",
        sessionStatusDetail: null,
      });
      const line = deriveNowLine(session, [], "claude code");
      expect(line).toEqual({ tone: "attention", text: "⚠ Needs permission", suffix: null });
    });

    it("substitutes the running context (todo) for a content-free (generic) attention event", () => {
      const session = makeSession({
        sessionStatus: "needs_input",
        sessionStatusSeverity: "waiting",
        currentTodo: { content: "Fix the flaky test", status: "in_progress" },
      });
      const events: NotificationEvent[] = [
        {
          seq: 1,
          sessionId: 1,
          kind: "attention",
          ts: 1,
          payload: { attention: true, signal: "bell" },
        },
      ];
      const line = deriveNowLine(session, events, "claude code");
      expect(line).toEqual({
        tone: "attention",
        text: "⚠ ▸ Fix the flaky test",
        suffix: null,
      });
    });

    it("keeps a content-free attention event's own text when there's no running context either", () => {
      const session = makeSession({
        sessionStatus: "needs_input",
        sessionStatusSeverity: "waiting",
      });
      const events: NotificationEvent[] = [
        {
          seq: 1,
          sessionId: 1,
          kind: "attention",
          ts: 1,
          payload: { attention: true, signal: "bell" },
        },
      ];
      const line = deriveNowLine(session, events, "claude code");
      expect(line).toEqual({ tone: "attention", text: "⚠ Bell", suffix: null });
    });

    // A "finished" status is severity "done", which the backend's own
    // ATTENTION_SEVERITIES set also lumps in with blocked/failed/waiting —
    // but STATUS_PRESENTATION gives it its own "finished" tone precisely so
    // surfaces like this one can tell it apart. deriveNowLine keys off that
    // tone table, not the severity, which is what keeps a merely-finished
    // turn out of the "needs a look right now" bucket.
    it("does not treat a finished (done-severity) status as attention-worthy", () => {
      const session = makeSession({
        sessionStatus: "finished",
        sessionStatusSeverity: "done",
        lastAssistantMessage: "All done.",
      });
      const line = deriveNowLine(session, [], "claude code");
      expect(line?.tone).toBe("idle");
    });
  });

  describe("working tone", () => {
    it("shows the in-progress todo over any file-change context", () => {
      const session = makeSession({
        sessionStatus: "working",
        currentTodo: { content: "Wire swipe gesture into nav", status: "in_progress" },
      });
      const events = [fileChangeEvent(1, "src/a.ts")];
      const line = deriveNowLine(session, events, "claude code");
      expect(line).toEqual({
        tone: "working",
        text: "▸ Wire swipe gesture into nav",
        suffix: null,
      });
    });

    it("falls back to the last file touched when there's no todo", () => {
      const session = makeSession({ sessionStatus: "working" });
      const events = [fileChangeEvent(1, "src/a.ts"), fileChangeEvent(2, "src/b.ts")];
      const line = deriveNowLine(session, events, "claude code");
      expect(line?.text).toBe("edited src/b.ts");
    });

    it("appends an agent-count suffix, using subagentCount (the live count) even when the identity list is empty", () => {
      // OpenCode reports no per-agent identity (SubagentInfo.agentId), only
      // the running count — subagentCount is what stays authoritative either
      // way (pty-manager.ts increments/decrements it directly).
      const session = makeSession({
        sessionStatus: "working",
        subagentCount: 2,
        subagents: [],
        currentTodo: { content: "Refactor the hook", status: "in_progress" },
      });
      const line = deriveNowLine(session, [], "claude code");
      expect(line?.suffix).toBe("2 agents");
    });

    it("appends a background-task-count suffix alongside the agent count", () => {
      const session = makeSession({
        sessionStatus: "working",
        subagentCount: 1,
        outstandingBackgroundTasks: [
          { id: "t1", type: "shell", status: "running", description: "tail logs" },
        ],
        currentTodo: { content: "Refactor the hook", status: "in_progress" },
      });
      const line = deriveNowLine(session, [], "claude code");
      expect(line?.suffix).toBe("1 agent · 1 bg");
    });

    it("shows an agent-running summary when there's no context at all", () => {
      const session = makeSession({ sessionStatus: "working", subagentCount: 3 });
      const line = deriveNowLine(session, [], "claude code");
      expect(line?.text).toBe("◐ 3 agents running");
    });

    it("never falls back to the terminal title for a hooked session", () => {
      const session = makeSession({
        sessionStatus: "working",
        hookEmits: ["progress"],
        lastTitle: "✳ my-session",
      });
      const events = [titleEvent(1, "✳ my-session")];
      expect(deriveNowLine(session, events, "my-session")).toBeNull();
    });

    it("falls back to a glyph-stripped terminal title for a hookless session", () => {
      const session = makeSession({ sessionStatus: "working", hookEmits: [] });
      const events = [titleEvent(1, "✳ running the build")];
      const line = deriveNowLine(session, events, "my-session");
      expect(line?.text).toBe("running the build");
    });

    it("skips a hookless title that just repeats the row's own label", () => {
      const session = makeSession({ sessionStatus: "working", hookEmits: [] });
      const events = [titleEvent(1, "my-session")];
      expect(deriveNowLine(session, events, "my-session")).toBeNull();
    });
  });

  describe("idle/finished tone", () => {
    it("quotes the first meaningful line of the last assistant message", () => {
      const session = makeSession({
        sessionStatus: "finished",
        sessionStatusSeverity: "done",
        lastAssistantMessage: "All tests pass; PR #1437 opened.",
        lastTurnEndedAt: Date.now() - 60_000,
      });
      const line = deriveNowLine(session, [], "claude code");
      expect(line?.tone).toBe("idle");
      expect(line?.text).toBe('"All tests pass; PR #1437 opened."');
      expect(line?.suffix).toMatch(/ago$/);
    });

    it("strips a leading heading marker rather than skipping the whole line", () => {
      const session = makeSession({
        sessionStatus: "idle",
        lastAssistantMessage: "## Summary\n\nEverything passed.",
      });
      const line = deriveNowLine(session, [], "claude code");
      expect(line?.text).toBe('"Summary"');
    });

    it("skips a leading code fence and blank lines, then strips a list marker", () => {
      const session = makeSession({
        sessionStatus: "idle",
        lastAssistantMessage: "```\nsome code\n```\n\n- Fixed the bug\n- Added a test",
      });
      const line = deriveNowLine(session, [], "claude code");
      expect(line?.text).toBe('"Fixed the bug"');
    });

    it("falls back to the running context when there's no last message", () => {
      const session = makeSession({
        sessionStatus: "idle",
        lastAssistantMessage: null,
        currentTodo: { content: "Ship it", status: "pending" },
      });
      const line = deriveNowLine(session, [], "claude code");
      expect(line).toEqual({ tone: "idle", text: "▸ Ship it", suffix: null });
    });

    it("returns null when there's neither a last message nor any context", () => {
      const session = makeSession({ sessionStatus: "idle", lastAssistantMessage: null });
      expect(deriveNowLine(session, [], "claude code")).toBeNull();
    });
  });
});
