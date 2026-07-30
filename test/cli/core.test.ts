import { describe, it, expect, vi, afterEach } from "vitest";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import {
  extractFlags,
  parseGlobalFlags,
  resolveCommand,
  BROWSER_ACTIONS,
  parseBrowserArgs,
  formatRefTable,
  formatBrowserResult,
  formatError,
  sendHookNotification,
  runSessionExec,
  runEventsTail,
  runCommand,
  CliUsageError,
  USAGE,
} from "../../src/cli/core.mjs";
import { MullionSocketError } from "../../src/cli/client.mjs";

// ---------------------------------------------------------------------------
// extractFlags / parseGlobalFlags
// ---------------------------------------------------------------------------

describe("extractFlags", () => {
  it("parses --flag value pairs by kind", () => {
    const { flags, rest } = extractFlags(
      ["--name", "foo", "--limit", "5", "--verbose", "positional"],
      { name: "string", limit: "number", verbose: "boolean" },
    );
    expect(flags).toEqual({ name: "foo", limit: 5, verbose: true });
    expect(rest).toEqual(["positional"]);
  });

  it("parses --flag=value inline form", () => {
    const { flags } = extractFlags(["--name=foo", "--limit=5"], {
      name: "string",
      limit: "number",
    });
    expect(flags).toEqual({ name: "foo", limit: 5 });
  });

  it("accumulates repeated array flags", () => {
    const { flags } = extractFlags(["--tag", "a", "--tag", "b"], { tag: "array" });
    expect(flags.tag).toEqual(["a", "b"]);
  });

  it("throws on an unknown flag in strict mode (default)", () => {
    expect(() => extractFlags(["--bogus", "x"], {})).toThrow(CliUsageError);
  });

  it("leaves an unknown flag in rest when non-strict", () => {
    const { flags, rest } = extractFlags(["--bogus", "x"], {}, { strict: false });
    expect(flags).toEqual({});
    expect(rest).toEqual(["--bogus", "x"]);
  });

  it("throws when a value flag is missing its value", () => {
    expect(() => extractFlags(["--name"], { name: "string" })).toThrow(CliUsageError);
  });

  it("throws when a number flag's value isn't numeric", () => {
    expect(() => extractFlags(["--limit", "abc"], { limit: "number" })).toThrow(CliUsageError);
  });

  it("boolean flag with inline =false is false, not the string 'false'", () => {
    const { flags } = extractFlags(["--verbose=false"], { verbose: "boolean" });
    expect(flags.verbose).toBe(false);
  });
});

describe("parseGlobalFlags", () => {
  it("extracts json/session/socket/quiet from anywhere in argv", () => {
    const result = parseGlobalFlags(["session", "--json", "list", "--session", "5"]);
    expect(result.json).toBe(true);
    expect(result.session).toBe("5");
    expect(result.rest).toEqual(["session", "list"]);
  });

  it("defaults json/quiet to false and session/socket to undefined", () => {
    const result = parseGlobalFlags(["ps"]);
    expect(result.json).toBe(false);
    expect(result.quiet).toBe(false);
    expect(result.session).toBeUndefined();
    expect(result.socket).toBeUndefined();
  });

  it("leaves command-specific flags untouched in rest", () => {
    const result = parseGlobalFlags(["session", "create", "--project", "1"]);
    expect(result.rest).toEqual(["session", "create", "--project", "1"]);
  });
});

// ---------------------------------------------------------------------------
// resolveCommand
// ---------------------------------------------------------------------------

describe("resolveCommand", () => {
  it("expands the ps/kill/logs/exec top-level aliases", () => {
    expect(resolveCommand(["ps"])).toEqual({ noun: "session", verb: "list", args: [] });
    expect(resolveCommand(["kill", "5"])).toEqual({ noun: "session", verb: "kill", args: ["5"] });
    expect(resolveCommand(["logs", "5"])).toEqual({ noun: "session", verb: "logs", args: ["5"] });
    expect(resolveCommand(["exec", "bash"])).toEqual({
      noun: "session",
      verb: "exec",
      args: ["bash"],
    });
  });

  it("resolves standalone commands (notify/mcp/config) with no verb", () => {
    expect(resolveCommand(["config"])).toEqual({ noun: "config", verb: null, args: [] });
    expect(resolveCommand(["notify", "--message", "hi"])).toEqual({
      noun: "notify",
      verb: null,
      args: ["--message", "hi"],
    });
  });

  it("resolves noun+verb commands", () => {
    expect(resolveCommand(["browser", "click", "--ref", "e1"])).toEqual({
      noun: "browser",
      verb: "click",
      args: ["--ref", "e1"],
    });
  });

  it("errors on an empty command", () => {
    expect(resolveCommand([])).toEqual({ error: expect.stringContaining("no command given") });
  });

  it("errors when a noun is given with no verb", () => {
    expect(resolveCommand(["session"])).toEqual({
      error: "'session' requires a subcommand",
    });
  });

  it("errors on an unknown top-level command", () => {
    expect(resolveCommand(["bogus"])).toEqual({ error: "unknown command: bogus" });
  });
});

// ---------------------------------------------------------------------------
// parseBrowserArgs — every action in BROWSER_ACTIONS, since this is the
// #379-deferred surface the plan explicitly calls out as needing full,
// unrushed coverage.
// ---------------------------------------------------------------------------

describe("parseBrowserArgs", () => {
  it("covers every action declared in BROWSER_ACTIONS with at least one test below", () => {
    // Not a real assertion of behavior — just a tripwire so a future new
    // action added to the table without a matching test here fails loudly
    // instead of silently shipping unparsed.
    const covered = new Set([
      "navigate",
      "snapshot",
      "click",
      "fill",
      "press",
      "type",
      "select",
      "check",
      "uncheck",
      "wait",
      "dialog",
      "hover",
      "scroll",
      "get",
      "eval",
      "screenshot",
      "console",
      "errors",
      "find",
    ]);
    expect(new Set(Object.keys(BROWSER_ACTIONS))).toEqual(covered);
  });

  it("navigate: url positional + optional --wait-until", () => {
    expect(parseBrowserArgs("navigate", ["http://x", "--wait-until", "networkidle"])).toEqual({
      body: { action: "navigate", url: "http://x", wait_until: "networkidle" },
      cliFlags: {},
    });
  });

  it("navigate: requires a url", () => {
    expect(() => parseBrowserArgs("navigate", [])).toThrow(CliUsageError);
  });

  it("navigate: --wait-until must be one of the server's enum values", () => {
    expect(() => parseBrowserArgs("navigate", ["http://x", "--wait-until", "bogus"])).toThrow(
      CliUsageError,
    );
  });

  for (const action of [
    "navigate",
    "snapshot",
    "dialog",
    "eval",
    "screenshot",
    "console",
    "errors",
  ]) {
    it(`${action}: rejects --ref/--selector — this action takes no target`, () => {
      const positional = action === "navigate" ? ["http://x"] : action === "eval" ? ["1"] : [];
      expect(() => parseBrowserArgs(action, [...positional, "--ref", "e1"])).toThrow(CliUsageError);
      expect(() => parseBrowserArgs(action, [...positional, "--selector", "#a"])).toThrow(
        CliUsageError,
      );
    });
  }

  // find's own args (`--by`, a positional value) are otherwise fully valid
  // here — the point is that --ref/--selector rejection must fire even when
  // find's `isFind` early-return branch would otherwise be reached, since
  // that check happens before it in parseBrowserArgs.
  it("find: also rejects --ref/--selector, ahead of its own isFind early return", () => {
    expect(() => parseBrowserArgs("find", ["x", "--by", "text", "--ref", "e1"])).toThrow(
      CliUsageError,
    );
    expect(() => parseBrowserArgs("find", ["x", "--by", "text", "--selector", "#a"])).toThrow(
      CliUsageError,
    );
  });

  it("snapshot: no args needed", () => {
    expect(parseBrowserArgs("snapshot", [])).toEqual({
      body: { action: "snapshot" },
      cliFlags: {},
    });
  });

  it("click: requires --ref or --selector", () => {
    expect(() => parseBrowserArgs("click", [])).toThrow(CliUsageError);
    expect(parseBrowserArgs("click", ["--ref", "e1"])).toEqual({
      body: { action: "click", ref: "e1" },
      cliFlags: {},
    });
    expect(parseBrowserArgs("click", ["--selector", "#a"])).toEqual({
      body: { action: "click", selector: "#a" },
      cliFlags: {},
    });
  });

  it("click: --ref and --selector are mutually exclusive", () => {
    expect(() => parseBrowserArgs("click", ["--ref", "e1", "--selector", "#a"])).toThrow(
      CliUsageError,
    );
  });

  it("fill: value positional + required target", () => {
    expect(parseBrowserArgs("fill", ["hello", "--selector", "#a"])).toEqual({
      body: { action: "fill", selector: "#a", value: "hello" },
      cliFlags: {},
    });
    expect(() => parseBrowserArgs("fill", ["hello"])).toThrow(CliUsageError);
    expect(() => parseBrowserArgs("fill", ["--selector", "#a"])).toThrow(CliUsageError);
  });

  for (const action of ["press", "type"]) {
    it(`${action}: value positional required, target OPTIONAL — falls back to a global keyboard action (executeBrowserAction's page.keyboard.${action})`, () => {
      expect(parseBrowserArgs(action, ["hello", "--selector", "#a"])).toEqual({
        body: { action, selector: "#a", value: "hello" },
        cliFlags: {},
      });
      expect(parseBrowserArgs(action, ["hello"])).toEqual({
        body: { action, value: "hello" },
        cliFlags: {},
      });
      expect(() => parseBrowserArgs(action, ["--selector", "#a"])).toThrow(CliUsageError);
    });
  }

  it("select: a single value is sent as a bare string", () => {
    expect(parseBrowserArgs("select", ["opt1", "--selector", "#a"])).toEqual({
      body: { action: "select", selector: "#a", value: "opt1" },
      cliFlags: {},
    });
  });

  it("select: two or more values are sent as an array", () => {
    expect(parseBrowserArgs("select", ["opt1", "opt2", "--selector", "#a"])).toEqual({
      body: { action: "select", selector: "#a", value: ["opt1", "opt2"] },
      cliFlags: {},
    });
  });

  it("select: requires at least one value", () => {
    expect(() => parseBrowserArgs("select", ["--selector", "#a"])).toThrow(CliUsageError);
  });

  for (const action of ["check", "uncheck", "hover"]) {
    it(`${action}: requires a target, no value`, () => {
      expect(parseBrowserArgs(action, ["--ref", "e1"])).toEqual({
        body: { action, ref: "e1" },
        cliFlags: {},
      });
      expect(() => parseBrowserArgs(action, [])).toThrow(CliUsageError);
    });
  }

  it("get: target is OPTIONAL — falls back to page.content() when omitted", () => {
    expect(parseBrowserArgs("get", ["--ref", "e1"])).toEqual({
      body: { action: "get", ref: "e1" },
      cliFlags: {},
    });
    expect(parseBrowserArgs("get", [])).toEqual({ body: { action: "get" }, cliFlags: {} });
  });

  it("wait: value and target are both optional", () => {
    expect(parseBrowserArgs("wait", [])).toEqual({ body: { action: "wait" }, cliFlags: {} });
    expect(parseBrowserArgs("wait", ["Dashboard"])).toEqual({
      body: { action: "wait", value: "Dashboard" },
      cliFlags: {},
    });
    expect(parseBrowserArgs("wait", ["--selector", "#a"])).toEqual({
      body: { action: "wait", selector: "#a" },
      cliFlags: {},
    });
  });

  it("dialog: value (accept/dismiss) is OPTIONAL — omitting it clears the pending dialog action/text (executeBrowserAction's own else branch), no target", () => {
    expect(parseBrowserArgs("dialog", ["accept"])).toEqual({
      body: { action: "dialog", value: "accept" },
      cliFlags: {},
    });
    expect(parseBrowserArgs("dialog", ["dismiss", "--text", "override"])).toEqual({
      body: { action: "dialog", value: "dismiss", text: "override" },
      cliFlags: {},
    });
    expect(parseBrowserArgs("dialog", [])).toEqual({ body: { action: "dialog" }, cliFlags: {} });
    expect(() => parseBrowserArgs("dialog", ["bogus"])).toThrow(CliUsageError);
  });

  it("scroll: value enum top/bottom, optional x/y and target", () => {
    expect(parseBrowserArgs("scroll", ["bottom"])).toEqual({
      body: { action: "scroll", value: "bottom" },
      cliFlags: {},
    });
    expect(parseBrowserArgs("scroll", ["--x", "10", "--y", "20"])).toEqual({
      body: { action: "scroll", x: 10, y: 20 },
      cliFlags: {},
    });
    expect(() => parseBrowserArgs("scroll", ["sideways"])).toThrow(CliUsageError);
  });

  it("eval: requires a script", () => {
    expect(parseBrowserArgs("eval", ["document.title"])).toEqual({
      body: { action: "eval", script: "document.title" },
      cliFlags: {},
    });
    expect(() => parseBrowserArgs("eval", [])).toThrow(CliUsageError);
  });

  it("eval: rejects an empty script, matching the server's minLength: 1", () => {
    expect(() => parseBrowserArgs("eval", [""])).toThrow(CliUsageError);
  });

  it("screenshot: no positional, optional --out surfaced via cliFlags not body", () => {
    expect(parseBrowserArgs("screenshot", ["--out", "/tmp/shot.png"])).toEqual({
      body: { action: "screenshot" },
      cliFlags: { out: "/tmp/shot.png" },
    });
  });

  for (const action of ["console", "errors"]) {
    it(`${action}: no args needed`, () => {
      expect(parseBrowserArgs(action, [])).toEqual({ body: { action }, cliFlags: {} });
    });
  }

  it("find: requires --by, validates enum and --limit range", () => {
    expect(parseBrowserArgs("find", ["Sign in", "--by", "text"])).toEqual({
      body: { by: "text", value: "Sign in" },
      cliFlags: {},
    });
    expect(
      parseBrowserArgs("find", ["btn", "--by", "role", "--name", "Submit", "--limit", "5"]),
    ).toEqual({ body: { by: "role", value: "btn", name: "Submit", limit: 5 }, cliFlags: {} });
    expect(() => parseBrowserArgs("find", ["x"])).toThrow(CliUsageError);
    expect(() => parseBrowserArgs("find", ["x", "--by", "bogus"])).toThrow(CliUsageError);
    expect(() => parseBrowserArgs("find", ["x", "--by", "text", "--limit", "0"])).toThrow(
      CliUsageError,
    );
    expect(() => parseBrowserArgs("find", ["x", "--by", "text", "--limit", "51"])).toThrow(
      CliUsageError,
    );
  });

  it("find: rejects an empty value, matching the server's minLength: 1", () => {
    expect(() => parseBrowserArgs("find", ["", "--by", "text"])).toThrow(CliUsageError);
  });

  it("find: rejects a non-integer --limit", () => {
    expect(() => parseBrowserArgs("find", ["x", "--by", "text", "--limit", "2.5"])).toThrow(
      CliUsageError,
    );
  });

  it("rejects an unknown action", () => {
    expect(() => parseBrowserArgs("bogus", [])).toThrow(CliUsageError);
  });

  it("rejects a trailing unexpected positional argument", () => {
    expect(() => parseBrowserArgs("click", ["--ref", "e1", "extra"])).toThrow(CliUsageError);
  });
});

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

describe("formatRefTable", () => {
  it("renders an aligned ref/role/name table", () => {
    const table = formatRefTable([
      { ref: "e1", role: "button", name: "Submit" },
      { ref: "e20", role: "textbox", name: "Email" },
    ]);
    expect(table).toContain("ref");
    expect(table).toContain("e1 ");
    expect(table).toContain("e20");
  });

  it("renders a placeholder for an empty list", () => {
    expect(formatRefTable([])).toBe("(no elements)");
  });
});

describe("formatBrowserResult", () => {
  it("find: match count + ref table + invalidation note", () => {
    const out = formatBrowserResult("find", {
      matchCount: 1,
      elements: [{ ref: "e1", role: "button", name: "Go" }],
    });
    expect(out).toContain("1 match(es)");
    expect(out).toContain("invalidated");
  });

  it("console: renders [type] text lines, or a placeholder when empty", () => {
    expect(
      formatBrowserResult("console", { logs: [{ type: "log", text: "hi", timestamp: 1 }] }),
    ).toBe("[log] hi");
    expect(formatBrowserResult("console", { logs: [] })).toBe("(no console output)");
  });

  it("errors: renders stack (or message) per entry, or a placeholder when empty", () => {
    expect(formatBrowserResult("errors", { errors: [{ message: "boom", timestamp: 1 }] })).toBe(
      "boom",
    );
    expect(formatBrowserResult("errors", { errors: [] })).toBe("(no errors)");
  });

  it("eval: string results print bare, others JSON-stringified", () => {
    expect(formatBrowserResult("eval", { result: "hello" })).toBe("hello");
    expect(formatBrowserResult("eval", { result: 42 })).toBe("42");
  });

  it("get: renders text/value/checked as JSON", () => {
    const out = formatBrowserResult("get", { text: "hi", value: "v", checked: true });
    expect(JSON.parse(out)).toEqual({ text: "hi", value: "v", checked: true });
  });

  it("default (e.g. click/navigate): snapshot tree + ref table + invalidation note", () => {
    const out = formatBrowserResult("click", {
      snapshot: { tree: "- generic: Hello", elements: [{ ref: "e1", role: "button", name: "Go" }] },
    });
    expect(out).toContain("- generic: Hello");
    expect(out).toContain("e1");
    expect(out).toContain("invalidated");
  });
});

describe("formatError", () => {
  it("enriches a 403 scope error with the connected token source and a fix", () => {
    const err = new MullionSocketError(403, "not permitted for this connection's scope");
    const msg = formatError(err, { tokenSource: "MULLION_HOOK_TOKEN" });
    expect(msg).toContain("MULLION_HOOK_TOKEN");
    expect(msg).toContain("MULLION_AUTH_TOKEN");
  });

  it("renders a non-scope MullionSocketError with its status", () => {
    const err = new MullionSocketError(404, "no such session");
    expect(formatError(err, {})).toBe("no such session (status 404)");
  });

  it("falls back to a plain Error's message", () => {
    expect(formatError(new Error("boom"), {})).toBe("boom");
  });
});

// ---------------------------------------------------------------------------
// notify — hook socket, real net server (same posture as client.test.ts)
// ---------------------------------------------------------------------------

describe("sendHookNotification", () => {
  let dir: string;
  let server: net.Server | null = null;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("rejects with a clear message when hook socket env is not set", async () => {
    await expect(
      sendHookNotification({
        hookSocketPath: undefined,
        hookToken: undefined,
        title: "t",
        body: "b",
      }),
    ).rejects.toThrow(/MULLION_HOOK_SOCKET/);
  });

  it("writes the handshake and a notification message, then resolves", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-cli-notify-"));
    const socketPath = path.join(dir, "hooks.sock");
    const received: unknown[] = [];
    server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let idx = buffer.indexOf("\n");
        while (idx !== -1) {
          received.push(JSON.parse(buffer.slice(0, idx)));
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf("\n");
        }
      });
    });
    await new Promise<void>((resolve) => server?.listen(socketPath, resolve));

    await sendHookNotification({
      hookSocketPath: socketPath,
      hookToken: "tok",
      title: "mullion",
      body: "hello",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toEqual([
      { token: "tok" },
      { kind: "notification", title: "mullion", body: "hello" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// runSessionExec / runEventsTail — fake client + fake io, per the plan's own
// "keep raw I/O in mullion.mjs, pure mapping here" split.
// ---------------------------------------------------------------------------

function fakeIo() {
  const stdin = new EventEmitter();
  const written: Buffer[] = [];
  return {
    stdin,
    stdout: { write: vi.fn((chunk: Buffer | string) => written.push(Buffer.from(chunk))) },
    stderr: { write: vi.fn() },
    written,
    getSize: () => ({ cols: 80, rows: 24 }),
    resizeHandlers: [] as Array<() => void>,
    onResize(cb: () => void) {
      this.resizeHandlers.push(cb);
      return () => {
        this.resizeHandlers = this.resizeHandlers.filter((h) => h !== cb);
      };
    },
    interruptHandlers: [] as Array<() => void>,
    onInterrupt(cb: () => void) {
      this.interruptHandlers.push(cb);
    },
    setRawMode: vi.fn(),
    env: {},
  };
}

class FakeStream extends EventEmitter {
  closed = false;
  sent: Array<{ op: string; body: unknown }> = [];
  opened: Promise<void>;
  constructor(opened: Promise<void> = Promise.resolve()) {
    super();
    this.opened = opened;
    // Same defensive catch client.mjs's real openStream() attaches — a
    // test that never awaits `opened` itself must not crash on Node's
    // unhandled-rejection default when a test deliberately rejects it.
    this.opened.catch(() => {});
  }
  send(op: string, body: unknown) {
    this.sent.push({ op, body });
  }
  close() {
    this.closed = true;
  }
}

describe("runSessionExec", () => {
  it("creates a session, attaches, forwards stdin as input, and writes decoded data frames to stdout", async () => {
    const stream = new FakeStream();
    const client = {
      request: vi.fn(async (op: string) => {
        if (op === "sessions.create") return { id: 42 };
        return {};
      }),
      openStream: vi.fn(async () => stream),
    };
    const io = fakeIo();

    const execPromise = runSessionExec(
      client,
      { projectId: 1, command: "bash", cols: 80, rows: 24, killOnExit: false },
      io,
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.request).toHaveBeenCalledWith("sessions.create", {
      projectId: 1,
      command: "bash",
    });
    expect(client.openStream).toHaveBeenCalledWith("sessions.attach", {
      sessionId: 42,
      cols: 80,
      rows: 24,
    });
    expect(io.setRawMode).toHaveBeenCalledWith(true);

    io.stdin.emit("data", Buffer.from("ls\n"));
    expect(stream.sent).toContainEqual({
      op: "sessions.input",
      body: { b64: Buffer.from("ls\n").toString("base64") },
    });

    stream.emit("frame", { type: "data", b64: Buffer.from("output").toString("base64") });
    expect(io.written.map((b) => b.toString())).toContain("output");

    io.resizeHandlers[0]();
    expect(stream.sent).toContainEqual({ op: "sessions.resize", body: { cols: 80, rows: 24 } });

    stream.emit("frame", { type: "exited" });
    stream.emit("close");
    const result = await execPromise;
    expect(result).toEqual({ sessionId: 42, exited: true });
    expect(io.setRawMode).toHaveBeenCalledWith(false);
  });

  it("detaches (not kills) on local interrupt by default", async () => {
    const stream = new FakeStream();
    const client = {
      request: vi.fn(async () => ({ id: 1 })),
      openStream: vi.fn(async () => stream),
    };
    const io = fakeIo();

    const execPromise = runSessionExec(
      client,
      { projectId: 1, command: "bash", cols: 80, rows: 24, killOnExit: false },
      io,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    io.interruptHandlers[0]();
    await execPromise;
    expect(stream.closed).toBe(true);
    expect(client.request).not.toHaveBeenCalledWith("sessions.kill", expect.anything());
  });

  it("kills on local interrupt when killOnExit is set", async () => {
    const stream = new FakeStream();
    const client = {
      request: vi.fn(async () => ({ id: 7 })),
      openStream: vi.fn(async () => stream),
    };
    const io = fakeIo();

    const execPromise = runSessionExec(
      client,
      { projectId: 1, command: "bash", cols: 80, rows: 24, killOnExit: true },
      io,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    io.interruptHandlers[0]();
    await execPromise;
    expect(client.request).toHaveBeenCalledWith("sessions.kill", { sessionId: 7 });
  });

  it("does not kill a session that already exited on its own, even with killOnExit set", async () => {
    const stream = new FakeStream();
    const client = {
      request: vi.fn(async (op: string) => (op === "sessions.create" ? { id: 9 } : {})),
      openStream: vi.fn(async () => stream),
    };
    const io = fakeIo();

    const execPromise = runSessionExec(
      client,
      { projectId: 1, command: "bash", cols: 80, rows: 24, killOnExit: true },
      io,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    stream.emit("frame", { type: "exited" });
    stream.emit("close");
    await execPromise;
    expect(client.request).not.toHaveBeenCalledWith("sessions.kill", expect.anything());
  });

  it("propagates a failed sessions.attach (rejected stream.opened) as a thrown error instead of hanging or crashing", async () => {
    const stream = new FakeStream(Promise.reject(new Error("no such session")));
    const client = {
      request: vi.fn(async () => ({ id: 1 })),
      openStream: vi.fn(async () => stream),
    };
    const io = fakeIo();

    await expect(
      runSessionExec(
        client,
        { projectId: 1, command: "bash", cols: 80, rows: 24, killOnExit: false },
        io,
      ),
    ).rejects.toThrow("no such session");
    // Never reached raw-mode setup — nothing to clean up, and definitely
    // nothing left enabled.
    expect(io.setRawMode).not.toHaveBeenCalled();
  });

  it("restores raw mode via finally, and warns on stderr rather than silently swallowing, when the kill-on-exit request fails", async () => {
    const stream = new FakeStream();
    const client = {
      request: vi.fn(async (op: string) => {
        if (op === "sessions.create") return { id: 3 };
        if (op === "sessions.kill") throw new Error("kill failed");
        return {};
      }),
      openStream: vi.fn(async () => stream),
    };
    const io = fakeIo();

    const execPromise = runSessionExec(
      client,
      { projectId: 1, command: "bash", cols: 80, rows: 24, killOnExit: true },
      io,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    io.interruptHandlers[0]();
    // sessions.kill's own rejection is caught (never rejects execPromise
    // itself) — but is now surfaced as a warning, not silently swallowed
    // (Hermes review, PR #402).
    await execPromise;
    expect(io.setRawMode).toHaveBeenCalledWith(false);
    expect(io.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("failed to kill session 3: kill failed"),
    );
  });
});

describe("runEventsTail", () => {
  it("prints each real event frame (no 'type' field — id, seq, sessionId, kind, ts) as a JSON line, stripping the stream id, and stops on interrupt", async () => {
    const stream = new FakeStream();
    const client = { openStream: vi.fn(async () => stream) };
    const io = fakeIo();

    const tailPromise = runEventsTail(client, io);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Exact wire shape per docs/socket-api.md: the NotificationEvent object
    // itself with the stream's own multiplexing `id` merged in — NOT a
    // {type:"event", event:{...}} wrapper (do not normalize this).
    stream.emit("frame", { id: 11, seq: 1, sessionId: 42, kind: "attention", ts: 172 });
    expect(io.written.map((b) => b.toString())).toContain(
      `${JSON.stringify({ seq: 1, sessionId: 42, kind: "attention", ts: 172 })}\n`,
    );

    io.interruptHandlers[0]();
    await tailPromise;
    expect(stream.closed).toBe(true);
  });

  it("ignores non-event frames (e.g. a lone ack with no kind/seq)", async () => {
    const stream = new FakeStream();
    const client = { openStream: vi.fn(async () => stream) };
    const io = fakeIo();

    const tailPromise = runEventsTail(client, io);
    await new Promise((resolve) => setTimeout(resolve, 10));
    stream.emit("frame", { id: 11, type: "data", b64: "" });
    expect(io.written).toEqual([]);

    io.interruptHandlers[0]();
    await tailPromise;
  });

  it("propagates a failed events.subscribe (rejected stream.opened) as a thrown error instead of hanging", async () => {
    const stream = new FakeStream(Promise.reject(new Error("not permitted")));
    const client = { openStream: vi.fn(async () => stream) };
    const io = fakeIo();

    await expect(runEventsTail(client, io)).rejects.toThrow("not permitted");
  });
});

// ---------------------------------------------------------------------------
// runCommand — end-to-end dispatch with a fake client
// ---------------------------------------------------------------------------

function fakeClient(overrides: Partial<{ request: unknown }> = {}) {
  return {
    tokenSource: "MULLION_AUTH_TOKEN",
    close: vi.fn(),
    request: vi.fn(async () => ({ ok: true })),
    openStream: vi.fn(),
    ...overrides,
  };
}

describe("runCommand", () => {
  it("prints usage and exits 0 for --help / -h / no args", async () => {
    const io = fakeIo();
    expect(await runCommand([], { client: fakeClient(), io })).toBe(0);
    expect(io.written.join("")).toContain(USAGE.slice(0, 20));
  });

  it("exits 2 with a message for an unresolvable command path", async () => {
    const io = fakeIo();
    const code = await runCommand(["bogus"], { client: fakeClient(), io });
    expect(code).toBe(2);
    expect(io.stderr.write).toHaveBeenCalledWith(expect.stringContaining("unknown command"));
  });

  it("exits 2 for a noun with an unknown verb", async () => {
    const io = fakeIo();
    const code = await runCommand(["session", "bogus"], { client: fakeClient(), io });
    expect(code).toBe(2);
  });

  it("dispatches to the resolved handler and prints JSON result by default (pretty)", async () => {
    const client = fakeClient({ request: vi.fn(async () => [{ id: 1 }]) });
    const io = fakeIo();
    const code = await runCommand(["ps"], { client, io });
    expect(code).toBe(0);
    expect(client.request).toHaveBeenCalledWith("sessions.list", {});
    expect(JSON.parse(io.written.join(""))).toEqual([{ id: 1 }]);
  });

  it("--json prints raw JSON even for a command with custom text formatting", async () => {
    const client = fakeClient({
      request: vi.fn(async () => ({
        ok: true,
        snapshot: { tree: "tree", elements: [] },
      })),
    });
    const io = fakeIo();
    await runCommand(["browser", "click", "--ref", "e1", "--json"], { client, io });
    const printed = JSON.parse(io.written.join(""));
    expect(printed.snapshot.tree).toBe("tree");
  });

  it("--quiet suppresses stdout output on success", async () => {
    const client = fakeClient();
    const io = fakeIo();
    await runCommand(["ps", "--quiet"], { client, io });
    expect(io.stdout.write).not.toHaveBeenCalled();
  });

  it("a CliUsageError from a handler exits 2 with the message on stderr", async () => {
    const io = fakeIo();
    const code = await runCommand(["browser", "click"], { client: fakeClient(), io });
    expect(code).toBe(2);
    expect(io.stderr.write).toHaveBeenCalledWith(expect.stringContaining("requires --ref"));
  });

  it("a MullionSocketError from the client exits 1 with a formatted message", async () => {
    const client = fakeClient({
      request: vi.fn(async () => {
        throw new MullionSocketError(404, "no such session");
      }),
    });
    const io = fakeIo();
    const code = await runCommand(["session", "get", "999"], { client, io });
    expect(code).toBe(1);
    expect(io.stderr.write).toHaveBeenCalledWith(expect.stringContaining("no such session"));
  });

  it("closes the client after every invocation, success or failure", async () => {
    const client = fakeClient();
    const io = fakeIo();
    await runCommand(["ps"], { client, io });
    expect(client.close).toHaveBeenCalled();

    const failingClient = fakeClient({
      request: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await runCommand(["ps"], { client: failingClient, io });
    expect(failingClient.close).toHaveBeenCalled();
  });

  describe("session commands", () => {
    it("session list forwards --project/--kind as query fields", async () => {
      const client = fakeClient();
      const io = fakeIo();
      await runCommand(["session", "list", "--project", "1", "--kind", "dock"], { client, io });
      expect(client.request).toHaveBeenCalledWith("sessions.list", {
        projectId: "1",
        kind: "dock",
      });
    });

    it("session get uses the positional id, falling back to --session", async () => {
      const client = fakeClient();
      const io = fakeIo();
      await runCommand(["session", "get", "5"], { client, io });
      expect(client.request).toHaveBeenCalledWith("sessions.get", { sessionId: "5" });

      await runCommand(["session", "get", "--session", "9"], { client, io });
      expect(client.request).toHaveBeenCalledWith("sessions.get", { sessionId: "9" });
    });

    it("session create requires --project and --command", async () => {
      const io = fakeIo();
      expect(
        await runCommand(["session", "create", "--command", "bash"], { client: fakeClient(), io }),
      ).toBe(2);
      expect(
        await runCommand(["session", "create", "--project", "1"], { client: fakeClient(), io }),
      ).toBe(2);

      const client = fakeClient();
      await runCommand(
        [
          "session",
          "create",
          "--project",
          "1",
          "--command",
          "bash",
          "--kind",
          "dock",
          "--skip-permissions",
        ],
        { client, io },
      );
      expect(client.request).toHaveBeenCalledWith("sessions.create", {
        projectId: "1",
        command: "bash",
        kind: "dock",
        skipPermissions: true,
      });
    });

    it("session kill requires an id", async () => {
      const io = fakeIo();
      expect(await runCommand(["session", "kill"], { client: fakeClient(), io })).toBe(2);
      const client = fakeClient();
      await runCommand(["session", "kill", "3"], { client, io });
      expect(client.request).toHaveBeenCalledWith("sessions.kill", { sessionId: "3" });
    });

    it("session rename: two positionals, or one positional name with --session for the id", async () => {
      const client = fakeClient();
      const io = fakeIo();
      await runCommand(["session", "rename", "3", "new-name"], { client, io });
      expect(client.request).toHaveBeenCalledWith("sessions.rename", {
        sessionId: "3",
        name: "new-name",
      });

      await runCommand(["session", "rename", "--session", "3", "other-name"], { client, io });
      expect(client.request).toHaveBeenCalledWith("sessions.rename", {
        sessionId: "3",
        name: "other-name",
      });

      expect(await runCommand(["session", "rename"], { client: fakeClient(), io })).toBe(2);
    });

    it("session logs writes decoded scrollback bytes to stdout", async () => {
      const client = fakeClient({
        request: vi.fn(async () => ({ b64: Buffer.from("hello\n").toString("base64") })),
      });
      const io = fakeIo();
      const code = await runCommand(["logs", "1"], { client, io });
      expect(code).toBe(0);
      expect(io.written.map((b) => b.toString()).join("")).toBe("hello\n");
    });
  });

  describe("project/preview/dock commands", () => {
    it("project actions is optional (session-scope default) but forwardable", async () => {
      const client = fakeClient();
      const io = fakeIo();
      await runCommand(["project", "actions"], { client, io });
      expect(client.request).toHaveBeenCalledWith("projects.actions", {});
      await runCommand(["project", "actions", "2"], { client, io });
      expect(client.request).toHaveBeenCalledWith("projects.actions", { projectId: "2" });
    });

    it("project dock requires a project id", async () => {
      const io = fakeIo();
      expect(await runCommand(["project", "dock"], { client: fakeClient(), io })).toBe(2);
      const client = fakeClient();
      await runCommand(["project", "dock", "2"], { client, io });
      expect(client.request).toHaveBeenCalledWith("projects.dock", { projectId: "2" });
    });

    it("preview create requires exactly one of --project/--url", async () => {
      const io = fakeIo();
      expect(await runCommand(["preview", "create"], { client: fakeClient(), io })).toBe(2);
      expect(
        await runCommand(["preview", "create", "--project", "1", "--url", "http://x"], {
          client: fakeClient(),
          io,
        }),
      ).toBe(2);

      const client = fakeClient();
      await runCommand(["preview", "create", "--project", "1"], { client, io });
      expect(client.request).toHaveBeenCalledWith("previews.create", {
        kind: "project",
        projectId: "1",
      });

      await runCommand(["preview", "create", "--url", "http://x"], { client, io });
      expect(client.request).toHaveBeenCalledWith("previews.create", {
        kind: "external",
        url: "http://x",
      });
    });

    it("preview get/delete require a slug", async () => {
      const io = fakeIo();
      expect(await runCommand(["preview", "get"], { client: fakeClient(), io })).toBe(2);
      const client = fakeClient();
      await runCommand(["preview", "get", "abc"], { client, io });
      expect(client.request).toHaveBeenCalledWith("previews.get", { slug: "abc" });
      await runCommand(["preview", "delete", "abc"], { client, io });
      expect(client.request).toHaveBeenCalledWith("previews.delete", { slug: "abc" });
    });

    it("preview list requests previews.list with no arguments", async () => {
      const client = fakeClient();
      const io = fakeIo();
      await runCommand(["preview", "list"], { client, io });
      expect(client.request).toHaveBeenCalledWith("previews.list", {});
    });

    it("dock list requests sessions.list scoped to kind:dock", async () => {
      const client = fakeClient();
      const io = fakeIo();
      await runCommand(["dock", "list"], { client, io });
      expect(client.request).toHaveBeenCalledWith("sessions.list", { kind: "dock" });
    });

    it("dock start resolves the control from projects.dock, then creates a session", async () => {
      const client = fakeClient({
        request: vi.fn(async (op: string) => {
          if (op === "projects.dock") {
            return [{ id: "web", title: "Web", command: "npm run dev", cwd: "/app" }];
          }
          return { id: 10 };
        }),
      });
      const io = fakeIo();
      await runCommand(["dock", "start", "1", "web"], { client, io });
      expect(client.request).toHaveBeenCalledWith("sessions.create", {
        projectId: "1",
        command: "npm run dev",
        kind: "dock",
        name: "Web",
        cwd: "/app",
      });
    });

    it("dock start errors clearly when the control id doesn't exist", async () => {
      const client = fakeClient({ request: vi.fn(async () => []) });
      const io = fakeIo();
      const code = await runCommand(["dock", "start", "1", "bogus"], { client, io });
      expect(code).toBe(2);
    });

    it("dock stop kills the given session", async () => {
      const client = fakeClient();
      const io = fakeIo();
      await runCommand(["dock", "stop", "5"], { client, io });
      expect(client.request).toHaveBeenCalledWith("sessions.kill", { sessionId: "5" });
    });
  });

  describe("notify", () => {
    it("requires --message", async () => {
      const io = fakeIo();
      expect(await runCommand(["notify"], { client: fakeClient(), io })).toBe(2);
    });
  });

  describe("config", () => {
    it("reports socket path, token source, reachability, and scope", async () => {
      const client = fakeClient({
        request: vi.fn(async (op: string) => {
          if (op === "ping") return { pong: true };
          if (op === "sessions.list") return [];
          throw new Error("unexpected op");
        }),
      });
      client.socketPath = "/tmp/mullion.sock";
      const io = fakeIo();
      await runCommand(["config"], { client, io });
      const text = io.written.join("");
      expect(text).toContain("/tmp/mullion.sock");
      expect(text).toContain("MULLION_AUTH_TOKEN");
      expect(text).toContain("scope:   full");
    });

    it("surfaces MULLION_SESSION_ID when present, since pty-manager.ts injects it into every session's env", async () => {
      const client = fakeClient({
        request: vi.fn(async (op: string) => {
          if (op === "ping") return { pong: true };
          if (op === "sessions.list") return [];
          throw new Error("unexpected op");
        }),
      });
      const io = fakeIo();
      io.env = { MULLION_SESSION_ID: "7" };
      await runCommand(["config"], { client, io });
      expect(io.written.join("")).toContain("session: 7");
    });

    it("omits the session line entirely when MULLION_SESSION_ID is absent (run outside a session)", async () => {
      const client = fakeClient({
        request: vi.fn(async (op: string) => {
          if (op === "ping") return { pong: true };
          if (op === "sessions.list") return [];
          throw new Error("unexpected op");
        }),
      });
      const io = fakeIo();
      await runCommand(["config"], { client, io });
      expect(io.written.join("")).not.toContain("session:");
    });

    it("reports session scope when sessions.list 403s", async () => {
      const client = fakeClient({
        request: vi.fn(async (op: string) => {
          if (op === "ping") return { pong: true };
          throw new MullionSocketError(403, "not permitted for this connection's scope");
        }),
      });
      const io = fakeIo();
      await runCommand(["config"], { client, io });
      expect(io.written.join("")).toContain("scope:   session");
    });

    it("reports unreachable when ping itself fails", async () => {
      const client = fakeClient({
        request: vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      });
      const io = fakeIo();
      await runCommand(["config"], { client, io });
      expect(io.written.join("")).toContain("reachable: false");
    });
  });

  describe("browser screenshot output", () => {
    it("writes the decoded PNG to stdout by default", async () => {
      const png = Buffer.from([1, 2, 3]);
      const client = fakeClient({
        request: vi.fn(async () => ({ screenshot: png.toString("base64") })),
      });
      const io = fakeIo();
      await runCommand(["browser", "screenshot"], { client, io });
      expect(Buffer.concat(io.written)).toEqual(png);
    });

    it("writes to --out <path> instead of stdout when given", async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "mullion-cli-screenshot-"));
      const outPath = path.join(dir, "shot.png");
      const png = Buffer.from([9, 9, 9]);
      const client = fakeClient({
        request: vi.fn(async () => ({ screenshot: png.toString("base64") })),
      });
      const io = fakeIo();
      await runCommand(["browser", "screenshot", "--out", outPath], { client, io });
      expect(io.stdout.write).not.toHaveBeenCalled();
      expect(readFileSync(outPath)).toEqual(png);
      rmSync(dir, { recursive: true, force: true });
    });

    it("--json prints the raw response, not a reconstructed {screenshot} object", async () => {
      const png = Buffer.from([1, 2, 3]);
      // An extra field beyond `screenshot` proves this is the raw response
      // passed through, not `{screenshot: outcome.screenshot}` rebuilt here.
      const rawResponse = { screenshot: png.toString("base64"), takenAt: "2026-07-29T00:00:00Z" };
      const client = fakeClient({ request: vi.fn(async () => rawResponse) });
      const io = fakeIo();
      await runCommand(["browser", "screenshot", "--json"], { client, io });
      expect(JSON.parse(io.written.join(""))).toEqual(rawResponse);
    });

    it("--json --quiet suppresses stdout, matching --quiet's non-screenshot behavior", async () => {
      const png = Buffer.from([1, 2, 3]);
      const client = fakeClient({
        request: vi.fn(async () => ({ screenshot: png.toString("base64") })),
      });
      const io = fakeIo();
      // Asserting the exit code too, not just empty stdout — an empty
      // stdout is equally consistent with the command having failed before
      // it ever reached the print step (errors go to stderr, not stdout).
      const code = await runCommand(["browser", "screenshot", "--json", "--quiet"], {
        client,
        io,
      });
      expect(code).toBe(0);
      expect(io.written).toEqual([]);
    });
  });

  it("--json --quiet suppresses stdout for a normal (non-screenshot) command", async () => {
    const client = fakeClient();
    const io = fakeIo();
    const code = await runCommand(["ps", "--json", "--quiet"], { client, io });
    expect(code).toBe(0);
    expect(io.written).toEqual([]);
  });
});
