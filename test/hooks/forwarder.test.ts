import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Integration-style test for the actual forwarder.mjs subprocess entry
// point (issue #174) — the thin stdin/socket shim that forwarder-core.test.ts
// can't reach (that file only exercises the pure mapping functions in-
// process). Mirrors test/plugins/hooks.test.ts's "real socket, real client"
// posture: a real net.createServer Unix socket stands in for hooksPlugin's
// listener, and a real `node forwarder.mjs` child process stands in for
// what an agent's hook runner actually invokes — see the plan's
// "Testability of the forwarder" note for why this split (pure core +
// thin, separately-covered shim) is how forwarder.mjs stays inside CI's
// coverage floor without an exclude.

const FORWARDER_PATH = fileURLToPath(new URL("../../src/hooks/forwarder.mjs", import.meta.url));

function listen(socketPath: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

// Attaches the 'data' listener the INSTANT a connection arrives (inside the
// synchronous 'connection' handler), not after — a net.Socket stays paused
// (not flowing, not consuming its underlying fd) until something puts it in
// flowing mode, and the forwarder's `socket.end()` half-close only completes
// (triggering 'close' on the forwarder's own end, which is what lets the
// child process actually exit) once the server side has drained and echoed
// the close back. Awaiting the forwarder's exit code BEFORE calling this
// would deadlock: the child never exits because nothing here has started
// reading yet, but nothing here starts reading until the (never-arriving)
// exit resolves.
// Hermes review, PR #466 — resolving only on reaching `count` meant a
// regression that sends fewer lines than expected (e.g. a dropped sibling)
// hung this promise until vitest's own test timeout instead of failing
// fast with a useful message. Reject on an early `close`/`error` too, same
// "the connection ended before we got what we expected" signal either way.
function collectLines(server: net.Server, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    server.once("connection", (socket) => {
      let buffer = "";
      let settled = false;
      const lines: string[] = [];
      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        reject(
          new Error(`collectLines: connection ${reason} after ${lines.length}/${count} lines`),
        );
      };
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let idx = buffer.indexOf("\n");
        while (idx !== -1) {
          lines.push(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf("\n");
          if (lines.length === count) {
            settled = true;
            resolve(lines);
            return;
          }
        }
      });
      socket.once("close", () => fail("closed"));
      socket.once("error", (err) => fail(`errored (${err.message})`));
    });
  });
}

/** Runs the real forwarder.mjs as a child process with the given argv/env,
 * writing `stdin` and waiting for it to exit. */
function runForwarder(
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin: string,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FORWARDER_PATH, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

/** Same as runForwarder, but captures stdout — for agy's Stop contract
 * (issue #253), which expects a JSON decision object on stdout even for a
 * purely observational hook. */
function runForwarderCapturingStdout(
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin: string,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FORWARDER_PATH, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe("forwarder.mjs (issue #174)", () => {
  let dir: string;
  let server: net.Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("handshakes and forwards a mapped Notification message", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
    const socketPath = path.join(dir, "hooks.sock");
    server = await listen(socketPath);

    const linesPromise = collectLines(server, 2);
    const exitCode = await runForwarder(
      ["claude-code", "Notification"],
      { MULLION_HOOK_SOCKET: socketPath, MULLION_HOOK_TOKEN: "tok-123" },
      JSON.stringify({ message: "Waiting for review" }),
    );
    expect(exitCode).toBe(0);

    const [handshakeLine, messageLine] = await linesPromise;
    expect(JSON.parse(handshakeLine)).toEqual({ token: "tok-123" });
    expect(JSON.parse(messageLine)).toEqual({
      kind: "notification",
      title: "Claude Code",
      body: "Waiting for review",
    });
  });

  it("connects nothing when the mapped event has no message (PostToolUse with no tool_name at all)", async () => {
    // Fix: status-clearing-semantics — mapClaudeCodePostToolUse now always
    // produces a bare `tool_done` for ANY named tool (see that function's own
    // comment), so a plain "Bash: ls" call — the previous fixture here — no
    // longer maps to nothing. The one remaining genuinely message-less
    // PostToolUse case is a payload missing tool_name entirely.
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
    const socketPath = path.join(dir, "hooks.sock");
    server = await listen(socketPath);
    let sawConnection = false;
    server.on("connection", () => {
      sawConnection = true;
    });

    const exitCode = await runForwarder(
      ["claude-code", "PostToolUse"],
      { MULLION_HOOK_SOCKET: socketPath, MULLION_HOOK_TOKEN: "tok-123" },
      JSON.stringify({ tool_input: { command: "ls" } }),
    );
    expect(exitCode).toBe(0);
    expect(sawConnection).toBe(false);
  });

  it("connects and sends a bare tool_done for an unmatched PostToolUse tool that carries no file_change/git_branch of its own", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
    const socketPath = path.join(dir, "hooks.sock");
    server = await listen(socketPath);

    const linesPromise = collectLines(server, 2);
    const exitCode = await runForwarder(
      ["claude-code", "PostToolUse"],
      { MULLION_HOOK_SOCKET: socketPath, MULLION_HOOK_TOKEN: "tok-123" },
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
    );
    expect(exitCode).toBe(0);

    const [handshakeLine, messageLine] = await linesPromise;
    expect(JSON.parse(handshakeLine)).toEqual({ token: "tok-123" });
    expect(JSON.parse(messageLine)).toEqual({ kind: "tool_done", tool: "Bash" });
  });

  it("exits cleanly with no socket configured at all", async () => {
    const exitCode = await runForwarder(
      ["claude-code", "Stop"],
      { MULLION_HOOK_SOCKET: "", MULLION_HOOK_TOKEN: "" },
      "{}",
    );
    expect(exitCode).toBe(0);
  });

  it("exits cleanly (never throws) when the socket path doesn't exist", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
    const exitCode = await runForwarder(
      ["claude-code", "Stop"],
      { MULLION_HOOK_SOCKET: path.join(dir, "no-such.sock"), MULLION_HOOK_TOKEN: "tok" },
      "{}",
    );
    expect(exitCode).toBe(0);
  });

  it("sends one line per file for a Codex apply_patch call touching multiple files (issue #252)", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
    const socketPath = path.join(dir, "hooks.sock");
    server = await listen(socketPath);

    const linesPromise = collectLines(server, 3);
    const exitCode = await runForwarder(
      ["codex", "PostToolUse"],
      { MULLION_HOOK_SOCKET: socketPath, MULLION_HOOK_TOKEN: "tok-123" },
      JSON.stringify({
        tool_name: "apply_patch",
        tool_input: {
          command: "*** Begin Patch\n*** Add File: a.ts\n+x\n*** Delete File: b.ts\n*** End Patch",
        },
      }),
    );
    expect(exitCode).toBe(0);

    const [handshakeLine, firstFile, secondFile] = await linesPromise;
    expect(JSON.parse(handshakeLine)).toEqual({ token: "tok-123" });
    expect(JSON.parse(firstFile)).toEqual({ kind: "file_change", path: "a.ts", action: "create" });
    expect(JSON.parse(secondFile)).toEqual({ kind: "file_change", path: "b.ts", action: "delete" });
  });

  it("always prints an empty JSON object to stdout — agy's Stop hooks run synchronously and expect a decision (issue #253)", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
    const socketPath = path.join(dir, "hooks.sock");
    server = await listen(socketPath);
    const linesPromise = collectLines(server, 2);

    const { code, stdout } = await runForwarderCapturingStdout(
      ["agy", "Stop"],
      { MULLION_HOOK_SOCKET: socketPath, MULLION_HOOK_TOKEN: "tok-123" },
      "{}",
    );
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("{}");

    const [, messageLine] = await linesPromise;
    expect(JSON.parse(messageLine)).toEqual({ kind: "progress", phase: "done" });
  });

  it("still prints an empty JSON object to stdout even with no socket configured at all", async () => {
    const { code, stdout } = await runForwarderCapturingStdout(
      ["agy", "Stop"],
      { MULLION_HOOK_SOCKET: "", MULLION_HOOK_TOKEN: "" },
      "{}",
    );
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("{}");
  });

  describe("agy review gate (issue #264)", () => {
    it("blocks on a reply and prints agy's decision dialect when MULLION_REVIEW_GATE_ENABLED is true", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
      const socketPath = path.join(dir, "hooks.sock");
      server = await listen(socketPath);

      // Issue #462 — this payload's `Cwd` means mapAgyPreToolUse ALSO
      // produces a piggybacked cwd_changed sibling ahead of the review_gate
      // (same as the "strips review_gate..." test below, just with the gate
      // enabled instead of stripped) — so the blocking message is line 3,
      // not line 2. Before the fix this test replied on line 2 and never
      // observed whether the sibling was sent at all, which is exactly how
      // the drop went unnoticed: it silently disappeared.
      // Kind-aware, not a hardcoded line count — replies as soon as it sees
      // the review_gate message itself, whatever position it lands at, so
      // this doesn't rot the same way a bare `lines === N` check would if a
      // future change adds or removes a sibling ahead of it.
      const linesPromise = collectLines(server, 3);
      server.once("connection", (socket) => {
        let buffer = "";
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          let idx = buffer.indexOf("\n");
          while (idx !== -1) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            idx = buffer.indexOf("\n");
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              continue;
            }
            if ((parsed as { kind?: string })?.kind === "review_gate") {
              socket.write(`${JSON.stringify({ decision: "approved" })}\n`);
            }
          }
        });
      });

      const { code, stdout } = await runForwarderCapturingStdout(
        ["agy", "PreToolUse"],
        {
          MULLION_HOOK_SOCKET: socketPath,
          MULLION_HOOK_TOKEN: "tok-123",
          MULLION_REVIEW_GATE_ENABLED: "true",
        },
        JSON.stringify({
          toolCall: { name: "run_command", args: { CommandLine: "npm test", Cwd: "/repo" } },
        }),
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({ decision: "allow" });

      const [handshakeLine, cwdLine, gateLine] = await linesPromise;
      expect(JSON.parse(handshakeLine)).toEqual({ token: "tok-123" });
      expect(JSON.parse(cwdLine)).toEqual({ kind: "cwd_changed", cwd: "/repo" });
      expect(JSON.parse(gateLine)).toMatchObject({ kind: "review_gate", state: "waiting" });
    });

    // Independent review, PR #466 — locks in the fail-closed degradation
    // path: if a reply EVER arrives before the real gate reply (today this
    // can't happen — see REPLY_ELICITING_KINDS and forwarder-core.mjs's
    // empty-branch fixes — but this proves the client-side behavior is safe
    // regardless of what upstream cause produced an early reply), runGate
    // reads it as the FIRST data event and treats anything without
    // `decision: "approved"` as denied, rather than hanging, throwing, or
    // misreading it as approval.
    it("fails closed (denied) rather than approving when a reply arrives before the real gate decision", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
      const socketPath = path.join(dir, "hooks.sock");
      server = await listen(socketPath);

      server.once("connection", (socket) => {
        let buffer = "";
        let dataEvents = 0;
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          dataEvents++;
          // Simulate hooks.ts replying {error} to an early, unrecognized
          // line (its real behavior for anything parseHookMessage
          // rejects) BEFORE the real review_gate line has even been fully
          // buffered — the worst case for "first reply line wins".
          if (dataEvents === 1 && buffer.includes("\n")) {
            socket.write(`${JSON.stringify({ error: "simulated validation failure" })}\n`);
          }
        });
      });

      const { code, stdout } = await runForwarderCapturingStdout(
        ["agy", "PreToolUse"],
        {
          MULLION_HOOK_SOCKET: socketPath,
          MULLION_HOOK_TOKEN: "tok-123",
          MULLION_REVIEW_GATE_ENABLED: "true",
        },
        JSON.stringify({
          toolCall: { name: "run_command", args: { CommandLine: "npm test", Cwd: "/repo" } },
        }),
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({ decision: "deny" });
    });

    it("strips review_gate messages and sends observational ones fire-and-forget when MULLION_REVIEW_GATE_ENABLED is missing", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
      const socketPath = path.join(dir, "hooks.sock");
      server = await listen(socketPath);

      const linesPromise = collectLines(server, 3);
      const { code, stdout } = await runForwarderCapturingStdout(
        ["agy", "PreToolUse"],
        { MULLION_HOOK_SOCKET: socketPath, MULLION_HOOK_TOKEN: "tok-123" },
        JSON.stringify({
          toolCall: {
            name: "run_command",
            args: {
              CommandLine: "git worktree add -b feat/wt /tmp/wt main",
              Cwd: "/repo",
            },
          },
        }),
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({ decision: "allow" });

      const [handshakeLine, cwdLine, gitBranchLine] = await linesPromise;
      expect(JSON.parse(handshakeLine)).toEqual({ token: "tok-123" });
      // cwd_changed is sent BEFORE git_branch — see mapAgyPreToolUse's own
      // ordering comment: a git_branch message carrying `worktree` also
      // sets `_liveCwd` itself, so sending the stale pre-command `Cwd`
      // after it would silently overwrite the correct worktree path.
      expect(JSON.parse(cwdLine)).toEqual({ kind: "cwd_changed", cwd: "/repo" });
      expect(JSON.parse(gitBranchLine)).toEqual({
        kind: "git_branch",
        branch: "feat/wt",
        worktree: "/tmp/wt",
      });
    });

    it("resolves a relative worktree path to absolute using Cwd for agy PreToolUse", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
      const socketPath = path.join(dir, "hooks.sock");
      server = await listen(socketPath);

      const linesPromise = collectLines(server, 3);
      const { code, stdout } = await runForwarderCapturingStdout(
        ["agy", "PreToolUse"],
        { MULLION_HOOK_SOCKET: socketPath, MULLION_HOOK_TOKEN: "tok-123" },
        JSON.stringify({
          toolCall: {
            name: "run_command",
            args: {
              CommandLine: "git worktree add -b feat/wt .worktrees/feat/wt main",
              Cwd: "/repo",
            },
          },
        }),
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({ decision: "allow" });

      const [handshakeLine, cwdLine, gitBranchLine] = await linesPromise;
      expect(JSON.parse(handshakeLine)).toEqual({ token: "tok-123" });
      expect(JSON.parse(cwdLine)).toEqual({ kind: "cwd_changed", cwd: "/repo" });
      expect(JSON.parse(gitBranchLine)).toEqual({
        kind: "git_branch",
        branch: "feat/wt",
        worktree: "/repo/.worktrees/feat/wt",
      });
    });

    it("skips cwd resolution for agy PreToolUse when a cd precedes the worktree add", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
      const socketPath = path.join(dir, "hooks.sock");
      server = await listen(socketPath);

      const linesPromise = collectLines(server, 3);
      const { code } = await runForwarderCapturingStdout(
        ["agy", "PreToolUse"],
        { MULLION_HOOK_SOCKET: socketPath, MULLION_HOOK_TOKEN: "tok-cd" },
        JSON.stringify({
          toolCall: {
            name: "run_command",
            args: {
              CommandLine: "cd /other/dir && git worktree add -b feat/wt .worktrees/feat/wt main",
              Cwd: "/repo",
            },
          },
        }),
      );
      expect(code).toBe(0);

      const [handshakeLine, cwdLine, gitBranchLine] = await linesPromise;
      expect(JSON.parse(handshakeLine)).toEqual({ token: "tok-cd" });
      expect(JSON.parse(cwdLine)).toEqual({ kind: "cwd_changed", cwd: "/repo" });
      // worktree path is the raw relative path (not resolved against
      // /repo) because `cd /other/dir` changed the working directory
      // before the worktree add, making the starting Cwd unreliable.
      expect(JSON.parse(gitBranchLine)).toEqual({
        kind: "git_branch",
        branch: "feat/wt",
        worktree: ".worktrees/feat/wt",
      });
    });

    it("resolves relative worktree path against git -C target for agy PreToolUse", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
      const socketPath = path.join(dir, "hooks.sock");
      server = await listen(socketPath);

      const linesPromise = collectLines(server, 3);
      const { code } = await runForwarderCapturingStdout(
        ["agy", "PreToolUse"],
        { MULLION_HOOK_SOCKET: socketPath, MULLION_HOOK_TOKEN: "tok-C" },
        JSON.stringify({
          toolCall: {
            name: "run_command",
            args: {
              CommandLine: "git -C /other/dir worktree add -b feat/wt .worktrees/feat/wt main",
              Cwd: "/repo",
            },
          },
        }),
      );
      expect(code).toBe(0);

      const [handshakeLine, cwdLine, gitBranchLine] = await linesPromise;
      expect(JSON.parse(handshakeLine)).toEqual({ token: "tok-C" });
      expect(JSON.parse(cwdLine)).toEqual({ kind: "cwd_changed", cwd: "/repo" });
      expect(JSON.parse(gitBranchLine)).toEqual({
        kind: "git_branch",
        branch: "feat/wt",
        worktree: "/other/dir/.worktrees/feat/wt",
      });
    });

    it("strips review_gate messages when MULLION_REVIEW_GATE_ENABLED is false", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
      const socketPath = path.join(dir, "hooks.sock");
      server = await listen(socketPath);

      const linesPromise = collectLines(server, 2);
      const { code, stdout } = await runForwarderCapturingStdout(
        ["agy", "PreToolUse"],
        {
          MULLION_HOOK_SOCKET: socketPath,
          MULLION_HOOK_TOKEN: "tok-123",
          MULLION_REVIEW_GATE_ENABLED: "false",
        },
        JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "npm test", Cwd: "/repo/src" },
          },
        }),
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({ decision: "allow" });

      const [handshakeLine, cwdLine] = await linesPromise;
      expect(JSON.parse(handshakeLine)).toEqual({ token: "tok-123" });
      expect(JSON.parse(cwdLine)).toEqual({ kind: "cwd_changed", cwd: "/repo/src" });
    });

    it("strips review_gate and exits cleanly with no socket when MULLION_REVIEW_GATE_ENABLED is missing", async () => {
      const { code, stdout } = await runForwarderCapturingStdout(
        ["agy", "PreToolUse"],
        { MULLION_HOOK_SOCKET: "", MULLION_HOOK_TOKEN: "" },
        JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "npm test", Cwd: "/repo" },
          },
        }),
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({ decision: "allow" });
    });
  });

  describe("review gate (issue #178)", () => {
    it("blocks on a reply and prints Claude Code's decision dialect to stdout, never the generic {}", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
      const socketPath = path.join(dir, "hooks.sock");
      server = await listen(socketPath);

      server.once("connection", (socket) => {
        let buffer = "";
        let lines = 0;
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          while (buffer.includes("\n")) {
            const idx = buffer.indexOf("\n");
            buffer = buffer.slice(idx + 1);
            lines++;
            // Line 1 is the handshake, line 2 is the review_gate:waiting
            // message — reply only once both have arrived.
            if (lines === 2) {
              socket.write(`${JSON.stringify({ decision: "approved" })}\n`);
            }
          }
        });
      });

      const { code, stdout } = await runForwarderCapturingStdout(
        ["claude-code", "PreToolUse"],
        {
          MULLION_HOOK_SOCKET: socketPath,
          MULLION_HOOK_TOKEN: "tok-123",
          MULLION_REVIEW_GATE_ENABLED: "true",
        },
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /tmp/x" } }),
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "Approved via Mullion",
        },
      });
    });

    it("relays a deny decision with its reason", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
      const socketPath = path.join(dir, "hooks.sock");
      server = await listen(socketPath);

      server.once("connection", (socket) => {
        let buffer = "";
        let lines = 0;
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          while (buffer.includes("\n")) {
            const idx = buffer.indexOf("\n");
            buffer = buffer.slice(idx + 1);
            lines++;
            if (lines === 2) {
              socket.write(`${JSON.stringify({ decision: "denied", reason: "looks unsafe" })}\n`);
            }
          }
        });
      });

      const { code, stdout } = await runForwarderCapturingStdout(
        ["claude-code", "PreToolUse"],
        {
          MULLION_HOOK_SOCKET: socketPath,
          MULLION_HOOK_TOKEN: "tok-123",
          MULLION_REVIEW_GATE_ENABLED: "true",
        },
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "curl evil.example" } }),
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "looks unsafe",
        },
      });
    });

    it("fails closed (deny) when the connection closes before any reply arrives", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
      const socketPath = path.join(dir, "hooks.sock");
      server = await listen(socketPath);

      // Never replies — just destroys the connection once the gate message
      // has arrived, simulating a crashed/killed Mullion server.
      server.once("connection", (socket) => {
        let buffer = "";
        let lines = 0;
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          while (buffer.includes("\n")) {
            const idx = buffer.indexOf("\n");
            buffer = buffer.slice(idx + 1);
            lines++;
            if (lines === 2) socket.destroy();
          }
        });
      });

      const { code, stdout } = await runForwarderCapturingStdout(
        ["claude-code", "PreToolUse"],
        {
          MULLION_HOOK_SOCKET: socketPath,
          MULLION_HOOK_TOKEN: "tok-123",
          MULLION_REVIEW_GATE_ENABLED: "true",
        },
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toMatchObject({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
      });
    });

    it("fails closed (deny) on a reply that isn't valid JSON", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
      const socketPath = path.join(dir, "hooks.sock");
      server = await listen(socketPath);

      server.once("connection", (socket) => {
        let buffer = "";
        let lines = 0;
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          while (buffer.includes("\n")) {
            const idx = buffer.indexOf("\n");
            buffer = buffer.slice(idx + 1);
            lines++;
            if (lines === 2) socket.write("not json at all\n");
          }
        });
      });

      const { code, stdout } = await runForwarderCapturingStdout(
        ["claude-code", "PreToolUse"],
        {
          MULLION_HOOK_SOCKET: socketPath,
          MULLION_HOOK_TOKEN: "tok-123",
          MULLION_REVIEW_GATE_ENABLED: "true",
        },
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toMatchObject({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
      });
    });

    it("fails closed (deny) when no socket is configured at all — never silently allows", async () => {
      const { code, stdout } = await runForwarderCapturingStdout(
        ["claude-code", "PreToolUse"],
        { MULLION_HOOK_SOCKET: "", MULLION_HOOK_TOKEN: "" },
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
      );
      expect(code).toBe(0);
      // No socket configured means forward() never even reaches the gate
      // branch — this is the ordinary "hooks disabled" no-op path, so it
      // prints the generic {} like any other non-gate hook, not a deny
      // decision (there was never a real gate to fail closed on).
      expect(stdout.trim()).toBe("{}");
    });
  });

  describe("session_start (issue #271)", () => {
    it("blocks on a reply and prints the SessionStart additionalContext dialect to stdout", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
      const socketPath = path.join(dir, "hooks.sock");
      server = await listen(socketPath);

      server.once("connection", (socket) => {
        let buffer = "";
        let lines = 0;
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          while (buffer.includes("\n")) {
            const idx = buffer.indexOf("\n");
            buffer = buffer.slice(idx + 1);
            lines++;
            // Line 1 is the handshake, line 2 is the session_start message.
            if (lines === 2) {
              socket.write(`${JSON.stringify({ additionalContext: "resume the refactor" })}\n`);
            }
          }
        });
      });

      const { code, stdout } = await runForwarderCapturingStdout(
        ["claude-code", "SessionStart"],
        { MULLION_HOOK_SOCKET: socketPath, MULLION_HOOK_TOKEN: "tok-123" },
        "{}",
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: "resume the refactor",
        },
      });
    });

    // Issue #462 — a SessionStart payload carrying `cwd` makes
    // mapClaudeCodeEvent piggyback a cwd_changed message ahead of the
    // session_start message itself (see that function's own ordering
    // comment). Before the fix, forward() found only the session_start
    // message and handed it alone to runSessionStart, silently dropping the
    // piggybacked cwd_changed — liveCwd then started stale every session
    // until some later event happened to carry `cwd` again. This directly
    // exercises the fix: both messages must arrive, cwd_changed first.
    it("still sends a piggybacked cwd_changed sibling ahead of the session_start message", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
      const socketPath = path.join(dir, "hooks.sock");
      server = await listen(socketPath);

      // Kind-aware, not a hardcoded line count — see the matching comment on
      // the agy review-gate test above.
      const linesPromise = collectLines(server, 3);
      server.once("connection", (socket) => {
        let buffer = "";
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          let idx = buffer.indexOf("\n");
          while (idx !== -1) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            idx = buffer.indexOf("\n");
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              continue;
            }
            if ((parsed as { kind?: string })?.kind === "session_start") {
              socket.write(`${JSON.stringify({ additionalContext: "resume the refactor" })}\n`);
            }
          }
        });
      });

      const { code, stdout } = await runForwarderCapturingStdout(
        ["claude-code", "SessionStart"],
        { MULLION_HOOK_SOCKET: socketPath, MULLION_HOOK_TOKEN: "tok-123" },
        JSON.stringify({ cwd: "/repo", source: "startup" }),
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: "resume the refactor",
        },
      });

      const [handshakeLine, cwdLine, sessionStartLine] = await linesPromise;
      expect(JSON.parse(handshakeLine)).toEqual({ token: "tok-123" });
      expect(JSON.parse(cwdLine)).toEqual({ kind: "cwd_changed", cwd: "/repo" });
      expect(JSON.parse(sessionStartLine)).toEqual({ kind: "session_start", source: "startup" });
    });

    it("prints the generic {} — not an empty SessionStart block — when nothing was stashed", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
      const socketPath = path.join(dir, "hooks.sock");
      server = await listen(socketPath);

      server.once("connection", (socket) => {
        let buffer = "";
        let lines = 0;
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          while (buffer.includes("\n")) {
            const idx = buffer.indexOf("\n");
            buffer = buffer.slice(idx + 1);
            lines++;
            if (lines === 2) socket.write(`${JSON.stringify({ additionalContext: "" })}\n`);
          }
        });
      });

      const { code, stdout } = await runForwarderCapturingStdout(
        ["claude-code", "SessionStart"],
        { MULLION_HOOK_SOCKET: socketPath, MULLION_HOOK_TOKEN: "tok-123" },
        "{}",
      );
      expect(code).toBe(0);
      expect(stdout.trim()).toBe("{}");
    });

    it("resolves to an empty additionalContext (never hangs) when the connection closes before any reply arrives", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
      const socketPath = path.join(dir, "hooks.sock");
      server = await listen(socketPath);

      server.once("connection", (socket) => {
        let buffer = "";
        let lines = 0;
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          while (buffer.includes("\n")) {
            const idx = buffer.indexOf("\n");
            buffer = buffer.slice(idx + 1);
            lines++;
            if (lines === 2) socket.destroy();
          }
        });
      });

      const { code, stdout } = await runForwarderCapturingStdout(
        ["claude-code", "SessionStart"],
        { MULLION_HOOK_SOCKET: socketPath, MULLION_HOOK_TOKEN: "tok-123" },
        "{}",
      );
      expect(code).toBe(0);
      expect(stdout.trim()).toBe("{}");
    });

    it("still prints {} when no socket is configured at all", async () => {
      const { code, stdout } = await runForwarderCapturingStdout(
        ["claude-code", "SessionStart"],
        { MULLION_HOOK_SOCKET: "", MULLION_HOOK_TOKEN: "" },
        "{}",
      );
      expect(code).toBe(0);
      expect(stdout.trim()).toBe("{}");
    });

    // Issue #437a — codex now shares claude-code's SessionStart dialect
    // end-to-end, not just at the formatSessionStartOutput unit level.
    it("codex: prints the same SessionStart additionalContext dialect as claude-code", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
      const socketPath = path.join(dir, "hooks.sock");
      server = await listen(socketPath);

      server.once("connection", (socket) => {
        let buffer = "";
        let lines = 0;
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          while (buffer.includes("\n")) {
            const idx = buffer.indexOf("\n");
            buffer = buffer.slice(idx + 1);
            lines++;
            if (lines === 2) {
              socket.write(`${JSON.stringify({ additionalContext: "resume the refactor" })}\n`);
            }
          }
        });
      });

      const { code, stdout } = await runForwarderCapturingStdout(
        ["codex", "SessionStart"],
        { MULLION_HOOK_SOCKET: socketPath, MULLION_HOOK_TOKEN: "tok-123" },
        "{}",
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: "resume the refactor",
        },
      });
    });

    // Issue #437b — agy's own injectSteps/ephemeralMessage dialect, exercised
    // end-to-end (stdin -> socket round trip -> stdout), not just at the
    // formatSessionStartOutput unit level.
    it("agy: prints the injectSteps/ephemeralMessage SessionStart dialect", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
      const socketPath = path.join(dir, "hooks.sock");
      server = await listen(socketPath);

      server.once("connection", (socket) => {
        let buffer = "";
        let lines = 0;
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          while (buffer.includes("\n")) {
            const idx = buffer.indexOf("\n");
            buffer = buffer.slice(idx + 1);
            lines++;
            if (lines === 2) {
              socket.write(`${JSON.stringify({ additionalContext: "resume the refactor" })}\n`);
            }
          }
        });
      });

      const { code, stdout } = await runForwarderCapturingStdout(
        ["agy", "SessionStart"],
        { MULLION_HOOK_SOCKET: socketPath, MULLION_HOOK_TOKEN: "tok-123" },
        "{}",
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({
        injectSteps: [{ ephemeralMessage: "resume the refactor" }],
      });
    });
  });
});
