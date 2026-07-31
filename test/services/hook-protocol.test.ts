import { describe, it, expect } from "vitest";
import { parseHookMessage, KNOWN_BROWSER_ACTIONS } from "../../src/services/hook-protocol.js";
import { agentActionSchema } from "../../src/routes/browser-automation.js";

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

    // Phase 5 (Track A) — agent-attribution envelope.
    it("accepts a file_change with agentId and agentType", () => {
      const result = parseHookMessage(
        JSON.stringify({
          kind: "file_change",
          path: "src/index.ts",
          action: "modify",
          agentId: "subagent-test-id-1",
          agentType: "Explore",
        }),
      );
      expect(result).toEqual({
        ok: true,
        message: {
          kind: "file_change",
          path: "src/index.ts",
          action: "modify",
          agentId: "subagent-test-id-1",
          agentType: "Explore",
        },
      });
    });

    // The hook channel is untrusted input (docs/roadmap.md's Security &
    // trust decision) — a malformed OPTIONAL attribution field must degrade
    // gracefully (dropped) rather than take the whole otherwise-legitimate
    // message down with it. Matches StopFailureHookMessage's
    // errorDetails/errorType convention elsewhere in this file.
    it("drops (does not reject) an empty-string agentType", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "file_change", path: "x", action: "modify", agentType: "" }),
      );
      expect(result).toEqual({
        ok: true,
        message: { kind: "file_change", path: "x", action: "modify" },
      });
    });

    // Per Hermes review feedback on #414 — parseAgentEnvelope validates
    // agentId/agentType independently, so a hook carrying only one of the
    // two (not both together, as every other envelope test above does) is
    // a real, valid case worth locking in explicitly.
    it("accepts a file_change with agentId alone (no agentType)", () => {
      const result = parseHookMessage(
        JSON.stringify({
          kind: "file_change",
          path: "src/index.ts",
          action: "modify",
          agentId: "subagent-test-id-1",
        }),
      );
      expect(result).toEqual({
        ok: true,
        message: {
          kind: "file_change",
          path: "src/index.ts",
          action: "modify",
          agentId: "subagent-test-id-1",
        },
      });
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

  // Phase 5 planning found these were dead: declared, validated, but never
  // emitted by any adapter (Claude Code subagents run in-process, no PID —
  // see docs/roadmap.md's Phase 5 section). Deleted as unreachable rather
  // than kept as reserved kinds; the protocol's own extensibility rule means
  // nothing is lost by removing them — an unrecognized kind is accepted
  // verbatim, not rejected, so a hypothetical future producer could still
  // send one without a parser change.
  describe("fork/join (removed — now unrecognized kinds)", () => {
    it.each(["fork", "join"] as const)("accepts %s verbatim as an unknown kind", (kind) => {
      const result = parseHookMessage(JSON.stringify({ kind, childPid: 1234 }));
      expect(result).toEqual({ ok: true, message: { kind, childPid: 1234 } });
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

  describe("permission_request", () => {
    it("accepts a well-formed permission_request", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "permission_request", tool: "Bash", summary: "npm install" }),
      );
      expect(result).toEqual({
        ok: true,
        message: { kind: "permission_request", tool: "Bash", summary: "npm install" },
      });
    });

    it("rejects a permission_request missing tool", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "permission_request", summary: "x" }));
      expect(result.ok).toBe(false);
    });

    it("rejects a permission_request with a non-string summary", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "permission_request", tool: "Bash", summary: 123 }),
      );
      expect(result.ok).toBe(false);
    });
  });

  // Fix: status-clearing-semantics — the forward-progress signal that
  // releases a permission/plan pending on a specific tool (see
  // ToolDoneHookMessage's doc comment).
  describe("tool_done", () => {
    it("accepts a well-formed tool_done", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "tool_done", tool: "Bash" }));
      expect(result).toEqual({ ok: true, message: { kind: "tool_done", tool: "Bash" } });
    });

    it("rejects a tool_done missing tool", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "tool_done" }));
      expect(result.ok).toBe(false);
    });

    it("rejects a tool_done with a non-string tool", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "tool_done", tool: 123 }));
      expect(result.ok).toBe(false);
    });
  });

  describe("stop_failure", () => {
    it("accepts a well-formed stop_failure with just error", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "stop_failure", error: "rate_limit" }),
      );
      expect(result).toEqual({ ok: true, message: { kind: "stop_failure", error: "rate_limit" } });
    });

    it("accepts a stop_failure with error details", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "stop_failure", error: "rate_limit", errorDetails: "429 Too Many" }),
      );
      expect(result).toEqual({
        ok: true,
        message: { kind: "stop_failure", error: "rate_limit", errorDetails: "429 Too Many" },
      });
    });

    it("rejects a stop_failure missing error", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "stop_failure" }));
      expect(result.ok).toBe(false);
    });

    it("rejects a stop_failure with a non-string error", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "stop_failure", error: 123 }));
      expect(result.ok).toBe(false);
    });

    it("accepts a stop_failure with an errorType", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "stop_failure", error: "rate_limit", errorType: "rate_limit" }),
      );
      expect(result).toEqual({
        ok: true,
        message: { kind: "stop_failure", error: "rate_limit", errorType: "rate_limit" },
      });
    });

    it("accepts a stop_failure without errorDetails (optional)", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "stop_failure", error: "overloaded" }),
      );
      expect(result).toEqual({ ok: true, message: { kind: "stop_failure", error: "overloaded" } });
    });
  });

  describe("tool_failure", () => {
    it("accepts a well-formed tool_failure", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "tool_failure", tool: "Bash", error: "exit code 1" }),
      );
      expect(result).toEqual({
        ok: true,
        message: { kind: "tool_failure", tool: "Bash", error: "exit code 1" },
      });
    });

    it("accepts a tool_failure with a summary", () => {
      const result = parseHookMessage(
        JSON.stringify({
          kind: "tool_failure",
          tool: "Write",
          error: "permission denied",
          summary: "src/config.json",
        }),
      );
      expect(result).toEqual({
        ok: true,
        message: {
          kind: "tool_failure",
          tool: "Write",
          error: "permission denied",
          summary: "src/config.json",
        },
      });
    });

    it("rejects a tool_failure missing tool", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "tool_failure", error: "x" }));
      expect(result.ok).toBe(false);
    });

    it("rejects a tool_failure with a non-string error", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "tool_failure", tool: "Bash", error: 42 }),
      );
      expect(result.ok).toBe(false);
    });

    // Phase 5 (Track A) — agent-attribution envelope.
    it("accepts a tool_failure with agentId and agentType", () => {
      const result = parseHookMessage(
        JSON.stringify({
          kind: "tool_failure",
          tool: "Bash",
          error: "exit code 1",
          agentId: "subagent-test-id-1",
          agentType: "Explore",
        }),
      );
      expect(result).toEqual({
        ok: true,
        message: {
          kind: "tool_failure",
          tool: "Bash",
          error: "exit code 1",
          agentId: "subagent-test-id-1",
          agentType: "Explore",
        },
      });
    });

    it("drops (does not reject) a non-string agentId", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "tool_failure", tool: "Bash", error: "x", agentId: 123 }),
      );
      expect(result).toEqual({
        ok: true,
        message: { kind: "tool_failure", tool: "Bash", error: "x" },
      });
    });
  });

  describe("session_end", () => {
    it("accepts a well-formed session_end", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "session_end", reason: "clear" }));
      expect(result).toEqual({ ok: true, message: { kind: "session_end", reason: "clear" } });
    });

    it("rejects a session_end missing reason", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "session_end" }));
      expect(result.ok).toBe(false);
    });

    it("rejects a session_end with a non-string reason", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "session_end", reason: 123 }));
      expect(result.ok).toBe(false);
    });

    it("accepts a session_end with an exitCode", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "session_end", reason: "crashed", exitCode: 1 }),
      );
      expect(result).toEqual({
        ok: true,
        message: { kind: "session_end", reason: "crashed", exitCode: 1 },
      });
    });

    it("rejects a session_end with a non-numeric exitCode", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "session_end", reason: "crashed", exitCode: "1" }),
      );
      expect(result.ok).toBe(false);
    });

    it("rejects a session_end with a non-integer exitCode (Hermes review, PR #316 — Unix exit codes are integers 0-255)", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "session_end", reason: "crashed", exitCode: 1.5 }),
      );
      expect(result.ok).toBe(false);
    });
  });

  describe("plan_ready", () => {
    it("accepts a well-formed plan_ready", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "plan_ready", plan: "## Refactor\n1. Extract module" }),
      );
      expect(result).toEqual({
        ok: true,
        message: { kind: "plan_ready", plan: "## Refactor\n1. Extract module" },
      });
    });

    it("accepts a plan_ready with filePath and summary", () => {
      const result = parseHookMessage(
        JSON.stringify({
          kind: "plan_ready",
          plan: "## Refactor",
          filePath: "/tmp/plan.md",
          summary: "Refactor auth module",
        }),
      );
      expect(result).toEqual({
        ok: true,
        message: {
          kind: "plan_ready",
          plan: "## Refactor",
          filePath: "/tmp/plan.md",
          summary: "Refactor auth module",
        },
      });
    });

    it("rejects a plan_ready missing plan", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "plan_ready" }));
      expect(result.ok).toBe(false);
    });

    it("rejects a plan_ready with a non-string plan", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "plan_ready", plan: 42 }));
      expect(result.ok).toBe(false);
    });

    it("rejects a plan_ready with a non-string filePath when present", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "plan_ready", plan: "x", filePath: 42 }),
      );
      expect(result.ok).toBe(false);
    });
  });

  describe("progress — enriched with lastAssistantMessage", () => {
    it("accepts progress with lastAssistantMessage", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "progress", phase: "done", lastAssistantMessage: "Done!" }),
      );
      expect(result).toEqual({
        ok: true,
        message: { kind: "progress", phase: "done", lastAssistantMessage: "Done!" },
      });
    });

    it("rejects lastAssistantMessage when it's not a string", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "progress", phase: "done", lastAssistantMessage: 123 }),
      );
      expect(result.ok).toBe(false);
    });

    it("rejects backgroundTasks when it's not an array", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "progress", phase: "done", backgroundTasks: "not-an-array" }),
      );
      expect(result.ok).toBe(false);
    });

    it("accepts progress with optional backgroundTasks array", () => {
      const result = parseHookMessage(
        JSON.stringify({
          kind: "progress",
          phase: "done",
          backgroundTasks: [
            { id: "t1", type: "shell", status: "running", description: "tail logs" },
          ],
        }),
      );
      expect(result).toEqual({
        ok: true,
        message: {
          kind: "progress",
          phase: "done",
          backgroundTasks: [
            { id: "t1", type: "shell", status: "running", description: "tail logs" },
          ],
        },
      });
    });

    it("rejects backgroundTasks with a non-object element (issue #428)", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "progress", phase: "done", backgroundTasks: ["not-an-object"] }),
      );
      expect(result.ok).toBe(false);
    });

    it("accepts a backgroundTasks element carrying agent_type/command (issue #428)", () => {
      const result = parseHookMessage(
        JSON.stringify({
          kind: "progress",
          phase: "done",
          backgroundTasks: [
            {
              id: "t1",
              type: "subagent",
              status: "running",
              description: "Explore agent",
              agent_type: "Explore",
            },
          ],
        }),
      );
      expect(result).toEqual({
        ok: true,
        message: {
          kind: "progress",
          phase: "done",
          backgroundTasks: [
            {
              id: "t1",
              type: "subagent",
              status: "running",
              description: "Explore agent",
              agent_type: "Explore",
            },
          ],
        },
      });
    });

    it("accepts progress with optional detail string (issue #321)", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "progress", phase: "generating", detail: "retry attempt 2" }),
      );
      expect(result).toEqual({
        ok: true,
        message: { kind: "progress", phase: "generating", detail: "retry attempt 2" },
      });
    });

    it("rejects detail when it's not a string", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "progress", phase: "generating", detail: 123 }),
      );
      expect(result.ok).toBe(false);
    });
  });

  describe("session_start — enriched with source", () => {
    it("accepts session_start with source", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "session_start", source: "resume" }));
      expect(result).toEqual({ ok: true, message: { kind: "session_start", source: "resume" } });
    });

    it("rejects session_start with non-string source", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "session_start", source: 123 }));
      expect(result.ok).toBe(false);
    });

    it("still accepts a bare session_start without source", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "session_start" }));
      expect(result).toEqual({ ok: true, message: { kind: "session_start" } });
    });
  });

  describe("git_branch", () => {
    it("accepts a well-formed git_branch with branch only", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "git_branch", branch: "feat/foo" }));
      expect(result).toEqual({ ok: true, message: { kind: "git_branch", branch: "feat/foo" } });
    });

    it("accepts a git_branch with branch and worktree", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "git_branch", branch: "feat/foo", worktree: "/tmp/wt" }),
      );
      expect(result).toEqual({
        ok: true,
        message: { kind: "git_branch", branch: "feat/foo", worktree: "/tmp/wt" },
      });
    });

    it("rejects a git_branch with a missing branch", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "git_branch" }));
      expect(result.ok).toBe(false);
    });

    it("rejects a git_branch with an empty branch", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "git_branch", branch: "" }));
      expect(result.ok).toBe(false);
    });

    it("rejects a git_branch with a non-string branch", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "git_branch", branch: 123 }));
      expect(result.ok).toBe(false);
    });
  });

  describe("cwd_changed", () => {
    it("accepts a well-formed cwd_changed", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "cwd_changed", cwd: "/workspace/src" }),
      );
      expect(result).toEqual({ ok: true, message: { kind: "cwd_changed", cwd: "/workspace/src" } });
    });

    it("rejects a cwd_changed with a missing cwd", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "cwd_changed" }));
      expect(result.ok).toBe(false);
    });

    it("rejects a cwd_changed with an empty cwd", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "cwd_changed", cwd: "" }));
      expect(result.ok).toBe(false);
    });
  });

  describe("turn_start", () => {
    it("accepts a turn_start with no fields", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "turn_start" }));
      expect(result).toEqual({ ok: true, message: { kind: "turn_start" } });
    });
  });

  describe("compact", () => {
    it("accepts a well-formed compact with state only", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "compact", state: "started" }));
      expect(result).toEqual({ ok: true, message: { kind: "compact", state: "started" } });
    });

    it("accepts a compact with an optional trigger", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "compact", state: "finished", trigger: "auto" }),
      );
      expect(result).toEqual({
        ok: true,
        message: { kind: "compact", state: "finished", trigger: "auto" },
      });
    });

    it("rejects a compact with an invalid state", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "compact", state: "bogus" }));
      expect(result.ok).toBe(false);
    });

    it("rejects a compact with an invalid trigger", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "compact", state: "started", trigger: "bogus" }),
      );
      expect(result.ok).toBe(false);
    });
  });

  describe("subagent", () => {
    it("accepts a well-formed subagent with state only", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "subagent", state: "started" }));
      expect(result).toEqual({ ok: true, message: { kind: "subagent", state: "started" } });
    });

    it("accepts a subagent with an optional agentType", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "subagent", state: "finished", agentType: "Explore" }),
      );
      expect(result).toEqual({
        ok: true,
        message: { kind: "subagent", state: "finished", agentType: "Explore" },
      });
    });

    it("rejects a subagent with an invalid state", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "subagent", state: "bogus" }));
      expect(result.ok).toBe(false);
    });

    // Phase 5 (Track A) — agent-attribution envelope.
    it("accepts a subagent with agentId and summary", () => {
      const result = parseHookMessage(
        JSON.stringify({
          kind: "subagent",
          state: "finished",
          agentType: "Explore",
          agentId: "subagent-test-id-1",
          summary: "Found the config file.",
        }),
      );
      expect(result).toEqual({
        ok: true,
        message: {
          kind: "subagent",
          state: "finished",
          agentType: "Explore",
          agentId: "subagent-test-id-1",
          summary: "Found the config file.",
        },
      });
    });

    it("rejects a subagent with a non-string summary", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "subagent", state: "finished", summary: 123 }),
      );
      expect(result.ok).toBe(false);
    });

    // Issue #428 — SubagentStop is the drain signal for a background
    // subagent's own outstanding work (see mapClaudeCodeSubagentStop in
    // forwarder-core.mjs, which forwards Claude Code's SubagentStop
    // `background_tasks` field the same way mapClaudeCodeStop already does).
    it("accepts a subagent finished message with backgroundTasks", () => {
      const result = parseHookMessage(
        JSON.stringify({
          kind: "subagent",
          state: "finished",
          agentId: "subagent-test-id-1",
          backgroundTasks: [
            { id: "t1", type: "subagent", status: "completed", description: "Explore agent" },
          ],
        }),
      );
      expect(result).toEqual({
        ok: true,
        message: {
          kind: "subagent",
          state: "finished",
          agentId: "subagent-test-id-1",
          backgroundTasks: [
            { id: "t1", type: "subagent", status: "completed", description: "Explore agent" },
          ],
        },
      });
    });

    it("rejects a subagent backgroundTasks with a non-object element", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "subagent", state: "finished", backgroundTasks: [42] }),
      );
      expect(result.ok).toBe(false);
    });

    it("drops (does not reject) an oversized agentId", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "subagent", state: "started", agentId: "x".repeat(200) }),
      );
      expect(result).toEqual({
        ok: true,
        message: { kind: "subagent", state: "started" },
      });
    });
  });

  describe("elicitation", () => {
    it("accepts a well-formed elicitation with state only", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "elicitation", state: "started" }));
      expect(result).toEqual({ ok: true, message: { kind: "elicitation", state: "started" } });
    });

    it("accepts an elicitation with an optional server", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "elicitation", state: "started", server: "my-mcp-server" }),
      );
      expect(result).toEqual({
        ok: true,
        message: { kind: "elicitation", state: "started", server: "my-mcp-server" },
      });
    });

    it("rejects an elicitation with an invalid state", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "elicitation", state: "bogus" }));
      expect(result.ok).toBe(false);
    });
  });

  describe("question", () => {
    it("accepts a well-formed question with state only", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "question", state: "started" }));
      expect(result).toEqual({ ok: true, message: { kind: "question", state: "started" } });
    });

    it("accepts a question with optional header, summary, and tool", () => {
      const result = parseHookMessage(
        JSON.stringify({
          kind: "question",
          state: "started",
          header: "Mode",
          summary: "Which mode?",
          tool: { messageID: "m1", callID: "c1" },
        }),
      );
      expect(result).toEqual({
        ok: true,
        message: {
          kind: "question",
          state: "started",
          header: "Mode",
          summary: "Which mode?",
          tool: { messageID: "m1", callID: "c1" },
        },
      });
    });

    it("rejects a question with an invalid state", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "question", state: "bogus" }));
      expect(result.ok).toBe(false);
    });

    it("rejects a question with header as a non-string", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "question", state: "started", header: 42 }),
      );
      expect(result.ok).toBe(false);
    });

    it("rejects a question with tool missing messageID", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "question", state: "started", tool: { callID: "c1" } }),
      );
      expect(result.ok).toBe(false);
    });

    it("accepts a finished question", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "question", state: "finished" }));
      expect(result).toEqual({ ok: true, message: { kind: "question", state: "finished" } });
    });
  });

  describe("todo", () => {
    it("accepts a well-formed todo", () => {
      const result = parseHookMessage(
        JSON.stringify({
          kind: "todo",
          content: "Implement auth",
          status: "in_progress",
          priority: "high",
        }),
      );
      expect(result).toEqual({
        ok: true,
        message: {
          kind: "todo",
          content: "Implement auth",
          status: "in_progress",
          priority: "high",
        },
      });
    });

    it("defaults priority to medium when absent", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "todo", content: "Fix bug", status: "pending" }),
      );
      expect(result).toEqual({
        ok: true,
        message: { kind: "todo", content: "Fix bug", status: "pending", priority: "medium" },
      });
    });

    it("rejects a todo with missing content", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "todo", status: "pending" }));
      expect(result.ok).toBe(false);
    });

    it("rejects a todo with an invalid status", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "todo", content: "Fix", status: "bogus" }),
      );
      expect(result.ok).toBe(false);
    });

    it("clamps an unknown priority to medium", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "todo", content: "Fix", status: "pending", priority: "critical" }),
      );
      expect(result).toEqual({
        ok: true,
        message: { kind: "todo", content: "Fix", status: "pending", priority: "medium" },
      });
    });
  });

  describe("session_diff", () => {
    it("accepts a well-formed session_diff", () => {
      const result = parseHookMessage(
        JSON.stringify({
          kind: "session_diff",
          files: [{ file: "/repo/a.ts", additions: 10, deletions: 2, patch: "diff --git" }],
        }),
      );
      expect(result).toEqual({
        ok: true,
        message: {
          kind: "session_diff",
          files: [{ file: "/repo/a.ts", additions: 10, deletions: 2, patch: "diff --git" }],
        },
      });
    });

    it("accepts session_diff with optional patch absent", () => {
      const result = parseHookMessage(
        JSON.stringify({
          kind: "session_diff",
          files: [{ file: "/repo/b.ts", additions: 5, deletions: 1 }],
        }),
      );
      expect(result).toEqual({
        ok: true,
        message: {
          kind: "session_diff",
          files: [{ file: "/repo/b.ts", additions: 5, deletions: 1 }],
        },
      });
    });

    it("rejects session_diff with an empty files array", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "session_diff", files: [] }));
      expect(result.ok).toBe(false);
    });

    it("rejects session_diff with a missing files field", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "session_diff" }));
      expect(result.ok).toBe(false);
    });

    it("rejects session_diff with a file entry missing file", () => {
      const result = parseHookMessage(
        JSON.stringify({ kind: "session_diff", files: [{ additions: 1, deletions: 0 }] }),
      );
      expect(result.ok).toBe(false);
    });

    it("filters out malformed file entries and rejects when none remain", () => {
      const result = parseHookMessage(
        JSON.stringify({
          kind: "session_diff",
          files: [
            { file: "/repo/a.ts", additions: 10, deletions: 2 },
            { file: "", additions: 1, deletions: 0 },
            { additions: 3, deletions: 1 },
          ],
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message).toEqual({
          kind: "session_diff",
          files: [{ file: "/repo/a.ts", additions: 10, deletions: 2 }],
        });
      }
    });
  });

  describe("permission_resolved", () => {
    it("accepts a permission_resolved with no fields", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "permission_resolved" }));
      expect(result).toEqual({ ok: true, message: { kind: "permission_resolved" } });
    });
  });

  describe("plan_resolved", () => {
    it("accepts a plan_resolved with no fields", () => {
      const result = parseHookMessage(JSON.stringify({ kind: "plan_resolved" }));
      expect(result).toEqual({ ok: true, message: { kind: "plan_resolved" } });
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

// Tripwire against KNOWN_BROWSER_ACTIONS drifting out of sync with the other
// action-list sources again (this exact class of bug is what the "fill" /
// "snapshot" / "eval" / "screenshot" hook-socket gap was — see hook-protocol.ts's
// KNOWN_BROWSER_ACTIONS comment). This only checks against agentActionSchema
// (this file already imports both, per that comment's pointer); it does not
// check BROWSER_ACTIONS (src/cli/core.mjs, which has its own separate
// tripwire in test/cli/core.test.ts) or the use_browser MCP tool's enum
// (src/mcp/tools.mjs, which has no such tripwire yet) — a drift limited to
// just one of those two would not be caught here.
describe("KNOWN_BROWSER_ACTIONS parity with agentActionSchema", () => {
  it("equals agentActionSchema's action enum plus 'find' (dispatched via a separate findElementsSchema/handler path, not part of that enum)", () => {
    const restActions = new Set(agentActionSchema.body.properties.action.enum);
    restActions.add("find");
    expect(KNOWN_BROWSER_ACTIONS).toEqual(restActions);
  });
});
