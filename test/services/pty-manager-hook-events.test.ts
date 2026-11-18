// emitHookEvent (issue #176) — file_change, review_gate, todo, session_diff, pr_*, project sessions, git_branch/cwd_changed, permission_request and stop_failure.
//
// Split out of the former test/services/pty-manager.test.ts (issue #3277) —
// that file sat at the file-size ratchet's ceiling, so a change here could no
// longer land next to the tests it belongs with. The shared mock preamble and
// helpers live in test/helpers/pty-manager-harness.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  bundleSyncMock,
  cgroupInventoryMock,
  childProcessMock,
  createPtyManagerFixture,
  destroyPtyManagerFixture,
  nodePtyMock,
  resetPtyManagerMocks,
  waitForSpawn,
} from "../helpers/pty-manager-harness.js";
import path from "node:path";
import type { HookMessage } from "../../src/services/hook-protocol.js";

vi.mock("node-pty", () => nodePtyMock());
vi.mock("../../src/services/bundle-sync.js", () => bundleSyncMock());
vi.mock("node:child_process", async (importOriginal) => childProcessMock(await importOriginal()));
vi.mock("../../src/services/cgroup-inventory.js", () => cgroupInventoryMock());

const { PtyManager } = await import("../../src/services/pty-manager.js");

describe("PtyManager", () => {
  let sessionsDir: string;
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    // Every test starts from a clean slate: no fake PTYs, no `systemctl`
    // fixtures and no cgroup-inventory call log left over from a sibling.
    resetPtyManagerMocks();
    ({ sessionsDir, manager } = createPtyManagerFixture(PtyManager));
  });

  afterEach(() => {
    destroyPtyManagerFixture({ sessionsDir, manager });
  });

  describe("emitHookEvent (issue #176)", () => {
    it("file_change: emits a file_change event with path and action", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "file_change", path: "src/index.ts", action: "modify" });
      // The git-ignore check (issue: sidebar worktree display's Part B) is
      // async even for this non-repo cwd's fast path — flush the microtask
      // queue before asserting. See the "filters a git-ignored file_change
      // path" describe block below for the git-ignore behavior itself.
      await new Promise((resolve) => setImmediate(resolve));

      const events = session.getEvents();
      const event = events[events.length - 1];
      expect(event.kind).toBe("file_change");
      expect(event.payload).toEqual({ path: "src/index.ts", action: "modify", agentId: null });
    });

    it("review_gate (waiting): emits a review_gate event AND flips attention with the prompt attached", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().attention).toBe(false);

      session.emitHookEvent({
        kind: "review_gate",
        state: "waiting",
        prompt: "Run rm -rf /tmp/build?",
      });

      const events = session.getEvents();
      expect(events.map((e) => e.kind)).toEqual(["review_gate", "attention"]);
      // gateId is forwarder/server-generated (issue: correlate concurrent
      // permission gates) — assert its shape/presence, not an exact value.
      expect(events[0].payload).toMatchObject({
        state: "waiting",
        prompt: "Run rm -rf /tmp/build?",
        gateId: expect.any(String),
      });
      expect(events[1].payload).toEqual({
        attention: true,
        signal: "reviewGate",
        prompt: "Run rm -rf /tmp/build?",
      });
      expect(session.toInfo().attention).toBe(true);
      expect(session.toInfo().gates).toHaveLength(1);
    });

    it("review_gate (approved/denied): an anomalous decision arriving over the hook channel itself resolves the sole pending gate, no attention re-raise", async () => {
      // No shipped forwarder actually sends "approved"/"denied" this way
      // (see Session.resolveGate's own doc comment) — this exercises the
      // defensive fallback in hook-handlers.ts's "review_gate" case, which
      // delegates to the SAME resolveGate() the web-UI path uses.
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      session.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "x" });
      expect(session.toInfo().attention).toBe(true);

      session.emitHookEvent({ kind: "review_gate", state: "approved", prompt: "x" });

      const events = session.getEvents();
      expect(events.map((e) => e.kind)).toEqual([
        "review_gate",
        "attention",
        "review_gate",
        "attention",
      ]);
      expect(session.toInfo().gateState).toBe("approved");
      expect(session.toInfo().gates).toEqual([]);
      expect(session.toInfo().attention).toBe(false);
    });

    it("an unrecognized kind is a no-op (extensibility, not a Phase 5 case anymore)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      // "fork"/"join" used to be recognized-but-unsurfaced kinds reserved for
      // Phase 5; they were deleted as dead code (no adapter ever emitted
      // them — Claude Code subagents run in-process, no PID). Any kind this
      // file doesn't recognize is still accepted verbatim by the protocol
      // layer and still a no-op here, same as before.
      session.emitHookEvent({ kind: "some_future_kind", value: 1234 } as unknown as HookMessage);

      expect(session.getEvents()).toHaveLength(0);
    });

    it("PR 33a: a kind matching an Object.prototype member name is a no-op, not a crash", async () => {
      // HOOK_HANDLERS (hook-handlers.ts) dispatches via `Map.get`, not a
      // plain object-property lookup, specifically so a `kind` string that
      // happens to collide with an inherited Object.prototype member
      // (`"constructor"`, `"__proto__"`, `"toString"`, ...) can't walk the
      // prototype chain and get invoked as if it were a real handler.
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "constructor" } as unknown as HookMessage);
      session.emitHookEvent({ kind: "__proto__" } as unknown as HookMessage);
      session.emitHookEvent({ kind: "toString" } as unknown as HookMessage);

      expect(session.getEvents()).toHaveLength(0);
    });

    it("session_start: a no-op even when it reaches emitHookEvent directly (it normally bypasses it entirely)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "session_start" });

      expect(session.getEvents()).toHaveLength(0);
    });

    it("todo: emits a todo event carrying content/status/priority", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({
        kind: "todo",
        content: "Fix the bug",
        status: "pending",
        priority: "high",
      });

      const events = session.getEvents();
      const event = events[events.length - 1];
      expect(event.kind).toBe("todo");
      expect(event.payload).toEqual({
        content: "Fix the bug",
        status: "pending",
        priority: "high",
      });
    });

    // Sidebar now-line (frontend's lib/sessionNowLine.ts) — currentTodo is a
    // live SessionInfo field, not just an event: it's what the now-line reads
    // for "what is this session working on", since the event itself can fall
    // out of the events ring buffer (EVENTS_MAX) while the task is still
    // running.
    it("todo: sets currentTodo on pending/in_progress, and clears it unconditionally on a terminal status", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({
        kind: "todo",
        content: "Fix the bug",
        status: "pending",
        priority: "high",
      });
      expect(session.toInfo().currentTodo).toEqual({ content: "Fix the bug", status: "pending" });

      session.emitHookEvent({
        kind: "todo",
        content: "Fix the bug",
        status: "in_progress",
        priority: "high",
      });
      expect(session.toInfo().currentTodo).toEqual({
        content: "Fix the bug",
        status: "in_progress",
      });

      session.emitHookEvent({
        kind: "todo",
        content: "Fix the bug",
        status: "completed",
        priority: "high",
      });
      expect(session.toInfo().currentTodo).toBeNull();
    });

    it("todo: a terminal update clears currentTodo even when it names a different item (forwarder-core.mjs's own completion fallback can)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({
        kind: "todo",
        content: "Task A",
        status: "in_progress",
        priority: "high",
      });
      expect(session.toInfo().currentTodo?.content).toBe("Task A");

      // The last remaining todo in the call, not necessarily the one
      // currently tracked — same content-agnostic clear as
      // eventDescriptions.ts's own sessionContextMap.
      session.emitHookEvent({
        kind: "todo",
        content: "Task B",
        status: "completed",
        priority: "low",
      });
      expect(session.toInfo().currentTodo).toBeNull();
    });

    it("session_diff: emits a session_diff event carrying the file list", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({
        kind: "session_diff",
        files: [{ file: "src/index.ts", additions: 3, deletions: 1 }],
      });

      const events = session.getEvents();
      const event = events[events.length - 1];
      expect(event.kind).toBe("session_diff");
      expect(event.payload).toEqual({
        files: [{ file: "src/index.ts", additions: 3, deletions: 1 }],
      });
    });

    it("emitPrEvent records a pr_* event and refuses any other kind", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitPrEvent("pr_ci_failed", { number: 7 });
      const last = session.getEvents().at(-1);
      expect(last?.kind).toBe("pr_ci_failed");
      expect(last?.payload).toEqual({ number: 7 });

      expect(() => session.emitPrEvent("attention", {})).toThrow(/not a pr_\* kind/);
    });

    it("projectSessions lists a project's sessions with hook branch and probe dir", async () => {
      const on = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
        projectId: 5,
      });
      const other = manager.getOrCreate({
        id: "2",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
        projectId: 6,
      });
      await waitForSpawn(on);
      await waitForSpawn(other);
      on.emitHookEvent({ kind: "git_branch", branch: "feat/foo" });
      other.emitHookEvent({ kind: "git_branch", branch: "feat/foo" });

      expect(manager.projectSessions(5)).toEqual([
        { id: "1", cwd: "/tmp", liveBranch: "feat/foo" },
      ]);
      const third = manager.getOrCreate({
        id: "3",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
        projectId: 5,
      });
      await waitForSpawn(third);
      expect(manager.projectSessions(5)).toContainEqual({
        id: "3",
        cwd: "/tmp",
        liveBranch: null,
      });
      expect(manager.projectSessions(7)).toEqual([]);
    });

    it("repointProject re-keys a project's live sessions and leaves the others", async () => {
      const mk = async (id: string, projectId: number) => {
        const s = manager.getOrCreate({
          id,
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
          projectId,
        });
        await waitForSpawn(s);
      };
      await mk("1", 5);
      await mk("2", 5);
      await mk("3", 6);
      expect(manager.repointProject(5, 9)).toBe(2);
      expect(manager.projectSessions(5)).toEqual([]);
      expect(manager.projectSessions(9).map((s) => s.id)).toEqual(["1", "2"]);
      expect(manager.projectSessions(6).map((s) => s.id)).toEqual(["3"]);
    });

    it("git_branch: stores the branch in liveBranch and emits a status_change event", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().liveBranch).toBeNull();

      session.emitHookEvent({ kind: "git_branch", branch: "feat/foo" });
      expect(session.toInfo().liveBranch).toBe("feat/foo");

      const events = session.getEvents();
      expect(events.map((e) => e.kind)).toContain("status_change");
    });

    it("git_branch with worktree: also updates liveCwd to the worktree path", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.liveCwd).toBeNull();

      session.emitHookEvent({
        kind: "git_branch",
        branch: "feat/foo",
        worktree: "/tmp/.worktrees/foo",
      });
      expect(session.toInfo().liveBranch).toBe("feat/foo");
      expect(session.liveCwd).toBe("/tmp/.worktrees/foo");
    });

    it("cwd_changed: updates liveCwd and emits a status_change event", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.liveCwd).toBeNull();

      session.emitHookEvent({ kind: "cwd_changed", cwd: "/workspace/src" });
      expect(session.liveCwd).toBe("/workspace/src");

      const events = session.getEvents();
      expect(events.map((e) => e.kind)).toContain("status_change");
    });

    it("cwd_changed: records the Claude transcript path and pins it to the session's own project dir (issue #2268)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.getTranscriptSource()).toBeNull();

      session.emitHookEvent({
        kind: "cwd_changed",
        cwd: "/tmp",
        transcriptPath: "/home/u/.claude/projects/-tmp/s.jsonl",
      });
      const source = session.getTranscriptSource();
      expect(source?.format).toBe("claude-code");
      expect(source?.path).toBe("/home/u/.claude/projects/-tmp/s.jsonl");
      // The path is untrusted: it may only resolve inside this session's own
      // project directory, not anywhere in projects/ (other sessions' transcripts).
      expect(source?.roots.length).toBeGreaterThan(0);
      for (const root of source?.roots ?? []) {
        expect(root.endsWith(path.join("projects", "-tmp"))).toBe(true);
      }
    });

    it("cwd_changed: a long cwd that Claude hashes yields no source rather than the whole projects dir (issue #2268)", async () => {
      const longCwd = `/tmp/${"d".repeat(240)}`;
      const session = manager.getOrCreate({
        id: "1",
        cwd: longCwd,
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.transcriptSourceBlocker()).toBeNull(); // nothing reported yet
      session.emitHookEvent({ kind: "cwd_changed", cwd: longCwd, transcriptPath: "/x/s.jsonl" });
      expect(session.getTranscriptSource()).toBeNull();
      expect(session.transcriptSourceBlocker()).toContain("too long");
    });

    it("cwd_changed: a transcript path is ignored for a CLI that does not write one (issue #2268)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      session.emitHookEvent({ kind: "cwd_changed", cwd: "/tmp", transcriptPath: "/x/s.jsonl" });
      expect(session.getTranscriptSource()).toBeNull();
    });

    it("permission_request: sets permissionState to pending and emits a permission_request event", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().permissionState).toBe("idle");

      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "Run ls" });

      // permissionState updates synchronously — session status must stay
      // truthful immediately — but the permission_request/attention EVENT
      // pair is deferred (ATTENTION_SETTLE_MS) until it either confirms or
      // is cancelled by a fast auto-resolution. Advance past the window.
      expect(session.toInfo().permissionState).toBe("pending");
      session.tick(Date.now() + 2_000);
      const events = session.getEvents();
      const event = events[events.length - 2];
      expect(event.kind).toBe("permission_request");
      expect(event.payload).toEqual({ tool: "Bash", summary: "Run ls" });
    });

    it("stop_failure: sets errorState to api_error and emits a stop_failure event", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().errorState).toBe("idle");

      session.emitHookEvent({
        kind: "stop_failure",
        error: "API timeout",
        errorDetails: "rate limited",
      });

      // The stop_failure NotificationEvent itself is immediate; only the
      // trailing `attention` (apiError) ping is deferred — advance past its
      // settle window before checking for it.
      expect(session.toInfo().errorState).toBe("api_error");
      session.tick(Date.now() + 2_000);
      const events = session.getEvents();
      const event = events[events.length - 2];
      expect(event.kind).toBe("stop_failure");
      expect(event.payload).toEqual({ error: "API timeout", errorDetails: "rate limited" });
      expect(events[events.length - 1].kind).toBe("attention");
    });

    // Issue #1364 self-review finding — for Claude Code, Stop and
    // StopFailure are separate hook registrations, so a real stop_failure
    // never arrives alongside a "done" progress message for the same turn,
    // and lastTurnEndedAt is never set while one is live. agy breaks that:
    // mapAgyEvent's Stop case emits BOTH a `progress: done` (which always
    // latches lastTurnEndedAt) and the `stop_failure` for one error-terminated
    // turn, as two separate hook messages in that order (forwarder.mjs's
    // writeHandshakeAndMessages sends them as separate lines, array order).
    // Without stop_failure explicitly clearing it back, the session would
    // read as "finished" (not "in an ongoing error") the moment
    // staleErrorSeconds later TTLs errorState back to idle — silently
    // defeating the rate-limit grace window's whole reason for existing.
    it("stop_failure clears lastTurnEndedAt even when a same-turn progress:done just latched it (agy's Stop shape)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      // Mirrors mapAgyEvent's Stop case exactly: progress:done first, then
      // stop_failure, as two separate emitHookEvent calls (matching two
      // separate socket lines in production).
      session.emitHookEvent({ kind: "progress", phase: "done", backgroundTasks: [] });
      expect(session.toInfo().lastTurnEndedAt).not.toBeNull();

      session.emitHookEvent({
        kind: "stop_failure",
        error: "RESOURCE_EXHAUSTED (code 429): Individual quota reached.",
        errorType: "rate_limit",
      });

      expect(session.toInfo().errorState).toBe("api_error");
      // Real derivation, not hand-computed — same code path
      // isRateLimitGraceActive (task-rate-limit-grace.ts) reads.
      expect(session.toInfo().errorDetail).toBe("rate_limit");
      expect(session.toInfo().lastTurnEndedAt).toBeNull();
    });

    // Second self-review pass — clearing lastTurnEndedAt alone fixes STATUS
    // derivation but not the NOTIFICATION layer: the preceding progress:done
    // already scheduled a 3s-deferred "agentIdle" ping
    // (resolveDeferredTurnEnd, attention-tracker.ts) that drains purely off
    // its own dueAt, with no re-check of lastTurnEndedAt/errorState at drain
    // time. Without the stop_failure handler's own cancelDeferred("agentIdle")
    // call, the session would still emit a spurious "turn finished" ping on
    // top of the genuine "apiError" one, even though status derivation now
    // correctly says the turn isn't over.
    it("stop_failure cancels the already-scheduled agentIdle deferred ping from the same-turn progress:done (agy's Stop shape)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "progress", phase: "done", backgroundTasks: [] });
      session.emitHookEvent({
        kind: "stop_failure",
        error: "RESOURCE_EXHAUSTED (code 429): Individual quota reached.",
        errorType: "rate_limit",
      });

      // Advance well past agentIdle's own 3s settle window — if it wasn't
      // cancelled, it would confirm here.
      session.tick(Date.now() + 3_000);

      const agentIdleSignals = session
        .getEvents()
        .filter((e) => e.kind === "attention" && e.payload?.signal === "agentIdle");
      expect(agentIdleSignals).toHaveLength(0);
      // The apiError ping (this handler's own genuine deferred signal)
      // still fires normally — cancelling agentIdle must not swallow it.
      const apiErrorSignals = session
        .getEvents()
        .filter((e) => e.kind === "attention" && e.payload?.signal === "apiError");
      expect(apiErrorSignals).toHaveLength(1);
    });

    it("stop_failure with no preceding progress:done leaves lastTurnEndedAt at its already-null default (Claude Code's real shape, unaffected)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().lastTurnEndedAt).toBeNull();

      session.emitHookEvent({ kind: "stop_failure", error: "rate_limit", errorType: "rate_limit" });

      expect(session.toInfo().errorState).toBe("api_error");
      expect(session.toInfo().lastTurnEndedAt).toBeNull();
    });
  });
});
