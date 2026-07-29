// Phase 4 (#134, PR6) — the `mullion` CLI's arg parsing, command table, and
// output formatting. Imported (not spawned) so it counts toward the
// coverage floor — see src/cli/mullion.mjs's own header comment for why
// that split exists. Every command handler here is a plain async function
// taking `(client, args, opts)`; raw-mode stdin/SIGWINCH/signal wiring for
// `session exec` is injected via an `io` object rather than reaching for
// `process` directly, so it's exercisable with fakes in tests too — the
// real process-level wiring lives in mullion.mjs.

import fs from "node:fs";
import net from "node:net";
import { MullionSocketError } from "./client.mjs";

export class CliUsageError extends Error {}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

/**
 * Scans `tokens` for `--name value` / `--name=value` / `--name` (boolean)
 * pairs matching `spec` (a map of flag name -> "string"|"number"|"boolean"|
 * "array"). In non-strict mode, an unrecognized `--flag` is left in `rest`
 * untouched (used for the first, global-flags-only pass over the whole
 * argv, where the command hasn't been identified yet and so its own flags
 * are still unknown); in strict mode it throws. Positional (non-flag)
 * tokens are always left in `rest`, in their original relative order.
 */
export function extractFlags(tokens, spec, { strict = true } = {}) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith("--")) {
      rest.push(tok);
      continue;
    }
    let name = tok.slice(2);
    let inline;
    const eq = name.indexOf("=");
    if (eq !== -1) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    const kind = spec[name];
    if (!kind) {
      if (strict) throw new CliUsageError(`unknown flag --${name}`);
      rest.push(tok);
      continue;
    }
    if (kind === "boolean") {
      flags[name] = inline === undefined ? true : inline !== "false";
      continue;
    }
    let raw = inline;
    if (raw === undefined) {
      raw = tokens[++i];
      if (raw === undefined) throw new CliUsageError(`--${name} requires a value`);
    }
    if (kind === "number") {
      const num = Number(raw);
      if (Number.isNaN(num)) throw new CliUsageError(`--${name} must be a number`);
      flags[name] = num;
    } else if (kind === "array") {
      flags[name] = flags[name] ? [...flags[name], raw] : [raw];
    } else {
      flags[name] = raw;
    }
  }
  return { flags, rest };
}

export const GLOBAL_FLAG_SPEC = {
  json: "boolean",
  session: "string",
  socket: "string",
  quiet: "boolean",
};

/** First parsing pass: pulls the four global flags out of the raw argv
 * (they may appear anywhere — before, between, or after the command path),
 * leaving every other token, including flags the command hasn't been
 * identified yet to validate, in `rest`. */
export function parseGlobalFlags(argv) {
  const { flags, rest } = extractFlags(argv, GLOBAL_FLAG_SPEC, { strict: false });
  return {
    json: flags.json === true,
    quiet: flags.quiet === true,
    session: flags.session,
    socket: flags.socket,
    rest,
  };
}

// ---------------------------------------------------------------------------
// Command resolution
// ---------------------------------------------------------------------------

const TOP_LEVEL_ALIASES = {
  ps: ["session", "list"],
  kill: ["session", "kill"],
  logs: ["session", "logs"],
  exec: ["session", "exec"],
};

const STANDALONE_COMMANDS = new Set(["notify", "mcp", "config"]);
const NOUNS = new Set(["session", "browser", "project", "preview", "dock", "events"]);

/** Resolves the leading tokens of a (post-global-flag-extraction) argv into
 * `{noun, verb, args}`, expanding the `ps`/`kill`/`logs`/`exec` top-level
 * aliases first. Returns `{error}` instead when the command path itself is
 * invalid — an unknown noun, or a noun requiring a verb that wasn't given —
 * distinct from a downstream handler's own argument-validation errors. */
export function resolveCommand(rest) {
  const [first, ...tail] = rest;
  if (first === undefined) return { error: "no command given — see 'mullion --help'" };
  if (Object.prototype.hasOwnProperty.call(TOP_LEVEL_ALIASES, first)) {
    const [noun, verb] = TOP_LEVEL_ALIASES[first];
    return { noun, verb, args: tail };
  }
  if (STANDALONE_COMMANDS.has(first)) return { noun: first, verb: null, args: tail };
  if (NOUNS.has(first)) {
    const [verb, ...args] = tail;
    if (verb === undefined) return { error: `'${first}' requires a subcommand` };
    return { noun: first, verb, args };
  }
  return { error: `unknown command: ${first}` };
}

// ---------------------------------------------------------------------------
// Browser subcommand — table-driven so every action shares one parser/
// dispatcher/formatter rather than 19 hand-written branches (#379's deferred
// surface, see the plan doc — every action gets real coverage here, table
// entries and all).
// ---------------------------------------------------------------------------

// RefOrSelector actions (browser-automation.ts) — whether a --ref/--selector
// target is required, optional, or not applicable at all.
const NO_TARGET = "none";
const REQUIRED_TARGET = "required";
const OPTIONAL_TARGET = "optional";

export const BROWSER_ACTIONS = {
  navigate: {
    positional: [{ name: "url", required: true }],
    flags: { "wait-until": "string" },
    target: NO_TARGET,
  },
  snapshot: { target: NO_TARGET },
  click: { target: REQUIRED_TARGET },
  fill: { positional: [{ name: "value", required: true }], target: REQUIRED_TARGET },
  press: { positional: [{ name: "value", required: true }], target: REQUIRED_TARGET },
  type: { positional: [{ name: "value", required: true }], target: REQUIRED_TARGET },
  select: {
    positional: [{ name: "value", required: true, variadic: true }],
    target: REQUIRED_TARGET,
  },
  check: { target: REQUIRED_TARGET },
  uncheck: { target: REQUIRED_TARGET },
  wait: { positional: [{ name: "value", required: false }], target: OPTIONAL_TARGET },
  dialog: {
    positional: [{ name: "value", required: true, enum: ["accept", "dismiss"] }],
    flags: { text: "string" },
    target: NO_TARGET,
  },
  hover: { target: REQUIRED_TARGET },
  scroll: {
    positional: [{ name: "value", required: false, enum: ["top", "bottom"] }],
    flags: { x: "number", y: "number" },
    target: OPTIONAL_TARGET,
  },
  get: { target: REQUIRED_TARGET },
  eval: { positional: [{ name: "script", required: true }], target: NO_TARGET },
  screenshot: { flags: { out: "string" }, target: NO_TARGET },
  console: { target: NO_TARGET },
  errors: { target: NO_TARGET },
  find: {
    positional: [{ name: "value", required: true }],
    flags: { by: "string", name: "string", limit: "number" },
    target: NO_TARGET,
    isFind: true,
  },
};

const FIND_BY_VALUES = ["text", "role", "label", "placeholder", "testid"];

/**
 * Parses one `mullion browser <action> ...` invocation's own args (already
 * past the action name) into the request body `executeBrowserAction`/
 * `executeBrowserFind` expect, per BROWSER_ACTIONS' table. Throws
 * CliUsageError for anything the server-side ajv schema would also reject
 * (missing required value, invalid enum, out-of-range `limit`) — failing
 * fast client-side rather than round-tripping a 400, per the plan.
 */
export function parseBrowserArgs(action, args) {
  const spec = BROWSER_ACTIONS[action];
  if (!spec) throw new CliUsageError(`unknown browser action: ${action}`);

  const flagSpec = { ref: "string", selector: "string", ...(spec.flags ?? {}) };
  const { flags, rest } = extractFlags(args, flagSpec);

  if (flags.ref !== undefined && flags.selector !== undefined) {
    throw new CliUsageError("--ref and --selector are mutually exclusive");
  }

  const positionalSpecs = spec.positional ?? [];
  const values = {};
  let cursor = 0;
  for (const posSpec of positionalSpecs) {
    if (posSpec.variadic) {
      const collected = rest.slice(cursor);
      if (posSpec.required && collected.length === 0) {
        throw new CliUsageError(`'${posSpec.name}' requires at least one value`);
      }
      values[posSpec.name] = collected;
      cursor = rest.length;
      continue;
    }
    const raw = rest[cursor];
    if (raw === undefined) {
      if (posSpec.required) throw new CliUsageError(`'${posSpec.name}' is required`);
      continue;
    }
    if (posSpec.enum && !posSpec.enum.includes(raw)) {
      throw new CliUsageError(`'${posSpec.name}' must be one of: ${posSpec.enum.join(", ")}`);
    }
    values[posSpec.name] = raw;
    cursor++;
  }
  if (cursor < rest.length) {
    throw new CliUsageError(`unexpected argument: ${rest[cursor]}`);
  }

  if (spec.target === REQUIRED_TARGET && flags.ref === undefined && flags.selector === undefined) {
    throw new CliUsageError(`'${action}' requires --ref or --selector`);
  }

  if (spec.isFind) {
    if (flags.by === undefined) throw new CliUsageError("'find' requires --by");
    if (!FIND_BY_VALUES.includes(flags.by)) {
      throw new CliUsageError(`--by must be one of: ${FIND_BY_VALUES.join(", ")}`);
    }
    if (flags.limit !== undefined && (flags.limit < 1 || flags.limit > 50)) {
      throw new CliUsageError("--limit must be between 1 and 50");
    }
    const body = { by: flags.by, value: values.value };
    if (flags.name !== undefined) body.name = flags.name;
    if (flags.limit !== undefined) body.limit = flags.limit;
    return { body, cliFlags: {} };
  }

  const body = { action };
  if (flags.ref !== undefined) body.ref = flags.ref;
  if (flags.selector !== undefined) body.selector = flags.selector;

  switch (action) {
    case "navigate":
      body.url = values.url;
      if (flags["wait-until"] !== undefined) body.wait_until = flags["wait-until"];
      break;
    case "fill":
    case "press":
    case "type":
      body.value = values.value;
      break;
    case "select":
      body.value = values.value.length === 1 ? values.value[0] : values.value;
      break;
    case "wait":
      if (values.value !== undefined) body.value = values.value;
      break;
    case "dialog":
      body.value = values.value;
      if (flags.text !== undefined) body.text = flags.text;
      break;
    case "scroll":
      if (values.value !== undefined) body.value = values.value;
      if (flags.x !== undefined) body.x = flags.x;
      if (flags.y !== undefined) body.y = flags.y;
      break;
    case "eval":
      body.script = values.script;
      break;
    default:
      break;
  }
  const cliFlags = {};
  if (flags.out !== undefined) cliFlags.out = flags.out;
  return { body, cliFlags };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

export function formatRefTable(elements) {
  if (!elements || elements.length === 0) return "(no elements)";
  const columns = ["ref", "role", "name"];
  const rows = elements.map((e) => columns.map((c) => String(e[c] ?? "")));
  const widths = columns.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [line(columns), ...rows.map(line)].join("\n");
}

/** Refs are invalidated by the next navigation or snapshot/find call
 * (browser-automation.ts) — every non-JSON render of a ref table exists so
 * an agent can copy one straight into its next command; state this loudly
 * here since it's the single most likely footgun (plan doc). */
export const REF_INVALIDATION_NOTE =
  "(refs are invalidated by the next navigate/snapshot/find call)";

export function formatBrowserResult(action, result) {
  if (action === "find") {
    return `${result.matchCount} match(es)\n\n${formatRefTable(result.elements)}\n\n${REF_INVALIDATION_NOTE}`;
  }
  if (action === "console") {
    const logs = result.logs ?? [];
    if (logs.length === 0) return "(no console output)";
    return logs.map((l) => `[${l.type}] ${l.text}`).join("\n");
  }
  if (action === "errors") {
    const errors = result.errors ?? [];
    if (errors.length === 0) return "(no errors)";
    return errors.map((e) => e.stack ?? e.message).join("\n---\n");
  }
  if (action === "eval") {
    return typeof result.result === "string" ? result.result : JSON.stringify(result.result);
  }
  if (action === "get") {
    return JSON.stringify(
      { text: result.text, value: result.value, checked: result.checked },
      null,
      2,
    );
  }
  const tree = result.snapshot?.tree ?? "";
  const table = formatRefTable(result.snapshot?.elements ?? []);
  return `${tree}\n\n${table}\n\n${REF_INVALIDATION_NOTE}`;
}

/** Enriches the server's flat "not permitted for this connection's scope"
 * 403 with what actually went wrong and how to fix it — the scope trap a
 * session-scoped connection (every session's own MULLION_HOOK_TOKEN) hits
 * on any full-scope-only op (sessions.list/create/kill, projects.list/dock,
 * previews.*, agents.list). A bare "403 forbidden" here would send an agent
 * running inside a session down a debugging rabbit hole for something
 * that's actually just "this op needs an operator credential." */
export function formatError(err, client) {
  if (err instanceof MullionSocketError) {
    if (err.status === 403 && /scope/.test(err.message)) {
      const via = client?.tokenSource ?? "no token";
      return (
        `${err.message} (connected via ${via}). ` +
        "This command needs full scope — set MULLION_AUTH_TOKEN, or run it " +
        "from outside a session (session env only ever carries MULLION_HOOK_TOKEN)."
      );
    }
    return `${err.message}${err.status ? ` (status ${err.status})` : ""}`;
  }
  return err.message ?? String(err);
}

// ---------------------------------------------------------------------------
// notify — bypasses the control socket entirely, writes directly to the hook
// socket (MULLION_HOOK_SOCKET/MULLION_HOOK_TOKEN), the channel
// src/hooks/forwarder.mjs already speaks. Deliberate deviation from #190:
// no --session support, since hook-socket auth pins the connection to
// whichever session's token is presented — there is no "notify a different
// session" over this channel.
// ---------------------------------------------------------------------------

const NOTIFY_TIMEOUT_MS = 5_000;

export function sendHookNotification({ hookSocketPath, hookToken, title, body }) {
  return new Promise((resolve, reject) => {
    if (!hookSocketPath || !hookToken) {
      reject(
        new Error(
          "MULLION_HOOK_SOCKET/MULLION_HOOK_TOKEN are not set — 'mullion notify' only works from inside a Mullion session",
        ),
      );
      return;
    }
    const socket = net.createConnection(hookSocketPath);
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error("timed out sending notification")),
      NOTIFY_TIMEOUT_MS,
    );
    socket.once("error", (err) => finish(err));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ token: hookToken })}\n`);
      socket.write(`${JSON.stringify({ kind: "notification", title, body })}\n`);
      // Fire-and-forget, same posture as forwarder.mjs's ordinary hooks —
      // hooks.ts never replies to a notification message, so there is
      // nothing to wait for beyond the write landing on the wire.
      finish(null);
    });
  });
}

// ---------------------------------------------------------------------------
// session exec — the raw-mode/SIGWINCH plumbing is injected as `io` so this
// stays unit-testable with fakes; mullion.mjs wires `io` to the real
// process.stdin/stdout/signals. See that file's header for why exec's OS
// wiring itself lives there instead.
// ---------------------------------------------------------------------------

export async function runSessionExec(client, { projectId, command, cols, rows, killOnExit }, io) {
  const session = await client.request("sessions.create", { projectId, command });
  const sessionId = session.id;
  const stream = await client.openStream("sessions.attach", { sessionId, cols, rows });

  let exited = false;
  const onFrame = (msg) => {
    if (msg.type === "data" && typeof msg.b64 === "string") {
      io.stdout.write(Buffer.from(msg.b64, "base64"));
    } else if (msg.type === "exited") {
      exited = true;
    }
  };
  const onStdinData = (chunk) => {
    stream.send("sessions.input", { b64: Buffer.from(chunk).toString("base64") });
  };
  const onResize = () => {
    const size = io.getSize();
    stream.send("sessions.resize", { cols: size.cols, rows: size.rows });
  };

  stream.on("frame", onFrame);
  io.stdin.on("data", onStdinData);
  const removeResize = io.onResize(onResize);
  io.setRawMode?.(true);

  await new Promise((resolve) => {
    stream.on("close", resolve);
    io.onInterrupt(() => {
      if (!exited) {
        stream.close("sessions.detach");
        if (killOnExit) {
          client.request("sessions.kill", { sessionId }).catch(() => {});
        }
      }
      resolve();
    });
  });

  io.stdin.removeListener("data", onStdinData);
  removeResize();
  io.setRawMode?.(false);
  return { sessionId, exited };
}

export async function runEventsTail(client, io) {
  const stream = await client.openStream("events.subscribe", {});
  stream.on("frame", (msg) => {
    if (msg.type === "event") io.stdout.write(`${JSON.stringify(msg.event)}\n`);
  });
  await new Promise((resolve) => {
    stream.on("close", resolve);
    io.onInterrupt(() => {
      stream.close("events.unsubscribe");
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Command table
// ---------------------------------------------------------------------------

const SESSION_LIST_SPEC = { project: "string", kind: "string" };
const SESSION_CREATE_SPEC = {
  project: "string",
  command: "string",
  name: "string",
  cwd: "string",
  kind: "string",
  "skip-permissions": "boolean",
};

function withSessionId(body, opts) {
  return opts.session !== undefined ? { ...body, sessionId: opts.session } : body;
}

function requireOne(args, label) {
  const value = args[0];
  if (value === undefined) throw new CliUsageError(`${label} is required`);
  return value;
}

const sessionCommands = {
  async list(client, args) {
    const { flags } = extractFlags(args, SESSION_LIST_SPEC);
    const body = {};
    if (flags.project !== undefined) body.projectId = flags.project;
    if (flags.kind !== undefined) body.kind = flags.kind;
    const result = await client.request("sessions.list", body);
    return { json: result };
  },
  async get(client, args, opts) {
    const id = args[0] ?? opts.session;
    const result = await client.request("sessions.get", id !== undefined ? { sessionId: id } : {});
    return { json: result };
  },
  async create(client, args) {
    const { flags } = extractFlags(args, SESSION_CREATE_SPEC);
    if (flags.project === undefined) throw new CliUsageError("--project is required");
    if (flags.command === undefined) throw new CliUsageError("--command is required");
    const body = { projectId: flags.project, command: flags.command };
    if (flags.name !== undefined) body.name = flags.name;
    if (flags.cwd !== undefined) body.cwd = flags.cwd;
    if (flags.kind !== undefined) body.kind = flags.kind;
    if (flags["skip-permissions"] === true) body.skipPermissions = true;
    const result = await client.request("sessions.create", body);
    return { json: result };
  },
  async kill(client, args, opts) {
    const id = requireOne([args[0] ?? opts.session], "session id");
    const result = await client.request("sessions.kill", { sessionId: id });
    return { json: result };
  },
  async rename(client, args, opts) {
    // Two positionals (id, name) normally; with --session supplying the id,
    // the sole remaining positional is the name.
    let id;
    let name;
    if (args.length >= 2) {
      [id, name] = args;
    } else {
      id = opts.session;
      name = args[0];
    }
    if (id === undefined) throw new CliUsageError("session id is required");
    if (name === undefined) throw new CliUsageError("name is required");
    const result = await client.request("sessions.rename", { sessionId: id, name });
    return { json: result };
  },
  async logs(client, args, opts, io) {
    const id = args[0] ?? opts.session;
    if (id === undefined) throw new CliUsageError("session id is required");
    const result = await client.request("sessions.scrollback", { sessionId: id });
    io.stdout.write(Buffer.from(result.b64, "base64"));
    return { streamed: true };
  },
  async exec(client, args, opts, io) {
    const { flags, rest } = extractFlags(args, {
      project: "string",
      "kill-on-exit": "boolean",
    });
    if (flags.project === undefined) throw new CliUsageError("--project is required");
    const command = rest.join(" ");
    if (command.length === 0) throw new CliUsageError("a command is required");
    const size = io.getSize();
    await runSessionExec(
      client,
      {
        projectId: flags.project,
        command,
        cols: size.cols,
        rows: size.rows,
        killOnExit: flags["kill-on-exit"] === true,
      },
      io,
    );
    return { streamed: true };
  },
};

const browserCommands = {};
for (const action of Object.keys(BROWSER_ACTIONS)) {
  browserCommands[action] = async (client, args, opts) => {
    const { body, cliFlags } = parseBrowserArgs(action, args);
    const op = body.by !== undefined ? "browser.find" : "browser.action";
    const result = await client.request(op, withSessionId(body, opts));
    if (action === "screenshot") return { screenshot: result.screenshot, outPath: cliFlags.out };
    return { json: result, text: formatBrowserResult(action, result) };
  };
}

const projectCommands = {
  async list(client) {
    const result = await client.request("projects.list", {});
    return { json: result };
  },
  // projectId is optional here (unlike project dock below): session scope
  // defaults to the connection's own pinned session's project when
  // omitted — see control-socket.ts's resolveTargetProjectId.
  async actions(client, args) {
    const body = args[0] !== undefined ? { projectId: args[0] } : {};
    const result = await client.request("projects.actions", body);
    return { json: result };
  },
  async dock(client, args) {
    const projectId = requireOne(args, "project id");
    const result = await client.request("projects.dock", { projectId });
    return { json: result };
  },
};

const previewCommands = {
  async create(client, args) {
    const { flags } = extractFlags(args, { project: "string", url: "string" });
    if (flags.project === undefined && flags.url === undefined) {
      throw new CliUsageError("one of --project or --url is required");
    }
    if (flags.project !== undefined && flags.url !== undefined) {
      throw new CliUsageError("--project and --url are mutually exclusive");
    }
    const body =
      flags.project !== undefined
        ? { kind: "project", projectId: flags.project }
        : { kind: "external", url: flags.url };
    const result = await client.request("previews.create", body);
    return { json: result };
  },
  async get(client, args) {
    const slug = requireOne(args, "slug");
    const result = await client.request("previews.get", { slug });
    return { json: result };
  },
  async delete(client, args) {
    const slug = requireOne(args, "slug");
    const result = await client.request("previews.delete", { slug });
    return { json: result };
  },
};

const dockCommands = {
  async list(client) {
    const result = await client.request("sessions.list", { kind: "dock" });
    return { json: result };
  },
  async start(client, args) {
    const projectId = requireOne(args, "project id");
    const dockId = args[1];
    if (dockId === undefined) throw new CliUsageError("dock control id is required");
    const controls = await client.request("projects.dock", { projectId });
    const control = controls.find((c) => c.id === dockId);
    if (!control) throw new CliUsageError(`no dock control '${dockId}' for project ${projectId}`);
    const body = { projectId, command: control.command, kind: "dock", name: control.title };
    if (control.cwd !== undefined) body.cwd = control.cwd;
    if (control.worktreeRefresh !== undefined) body.worktreeRefresh = control.worktreeRefresh;
    const result = await client.request("sessions.create", body);
    return { json: result };
  },
  async stop(client, args) {
    const sessionId = requireOne(args, "session id");
    const result = await client.request("sessions.kill", { sessionId });
    return { json: result };
  },
};

const eventsCommands = {
  async tail(client, _args, _opts, io) {
    await runEventsTail(client, io);
    return { streamed: true };
  },
};

async function runNotify(client, args, opts, io) {
  const { flags } = extractFlags(args, { message: "string", title: "string" });
  if (flags.message === undefined) throw new CliUsageError("--message is required");
  await sendHookNotification({
    hookSocketPath: io.env.MULLION_HOOK_SOCKET,
    hookToken: io.env.MULLION_HOOK_TOKEN,
    title: flags.title ?? "mullion",
    body: flags.message,
  });
  return { text: "notification sent" };
}

async function runConfig(client, _args, _opts, _io) {
  const info = {
    socketPath: client.socketPath,
    tokenSource: client.tokenSource,
  };
  try {
    await client.request("ping", {});
    info.reachable = true;
    try {
      await client.request("sessions.list", {});
      info.scope = "full";
    } catch (err) {
      info.scope = err instanceof MullionSocketError && err.status === 403 ? "session" : "unknown";
    }
  } catch (err) {
    info.reachable = false;
    info.error = err.message;
  }
  const text = [
    `socket:  ${info.socketPath}`,
    `token:   ${info.tokenSource ?? "(none)"}`,
    `reachable: ${info.reachable}`,
    info.scope ? `scope:   ${info.scope}` : info.error ? `error:   ${info.error}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return { json: info, text };
}

export const COMMANDS = {
  session: sessionCommands,
  browser: browserCommands,
  project: projectCommands,
  preview: previewCommands,
  dock: dockCommands,
  events: eventsCommands,
  notify: runNotify,
  config: runConfig,
};

export const USAGE = `Usage: mullion <command> [args] [flags]

Commands:
  session list|get|create|kill|rename|logs|exec
  browser navigate|click|fill|type|press|select|check|uncheck|hover|
          scroll|wait|dialog|get|eval|snapshot|screenshot|find|console|errors
  project list|actions|dock
  preview create|get|delete
  dock start|stop|list
  events tail
  notify --message <text> [--title <t>]
  mcp
  config

Aliases: ps -> session list, kill -> session kill, logs -> session logs, exec -> session exec

Global flags: --json --session <id> --socket <path> --quiet

See docs/cli.md for the full reference, including the browser subcommand's
--ref/--selector targeting and the ref-invalidation note.
`;

/**
 * Runs one parsed CLI invocation end to end: resolves the command, runs its
 * handler, prints the result. Returns a process exit code — never throws
 * (every error path is caught and turned into a stderr message + non-zero
 * code) so mullion.mjs's own `main()` is a one-line `process.exit(await
 * runCommand(...))`.
 */
export async function runCommand(argv, { client, io }) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    io.stdout.write(USAGE);
    return 0;
  }
  const { rest, ...globalOpts } = parseGlobalFlags(argv);
  const resolved = resolveCommand(rest);
  if (resolved.error) {
    io.stderr.write(`${resolved.error}\n`);
    return 2;
  }

  const target = resolved.verb ? COMMANDS[resolved.noun]?.[resolved.verb] : COMMANDS[resolved.noun];
  if (!target) {
    const label = resolved.verb ? `${resolved.noun} ${resolved.verb}` : resolved.noun;
    io.stderr.write(`unknown command: mullion ${label}\n`);
    return 2;
  }

  try {
    const outcome = await target(client, resolved.args, globalOpts, io);
    if (outcome?.streamed) return 0;
    if (outcome?.screenshot !== undefined) {
      if (globalOpts.json) {
        io.stdout.write(`${JSON.stringify({ screenshot: outcome.screenshot })}\n`);
      } else if (outcome.outPath) {
        fs.writeFileSync(outcome.outPath, Buffer.from(outcome.screenshot, "base64"));
      } else {
        io.stdout.write(Buffer.from(outcome.screenshot, "base64"));
      }
      return 0;
    }
    if (globalOpts.json) {
      io.stdout.write(`${JSON.stringify(outcome?.json ?? outcome, null, 2)}\n`);
    } else {
      const text = outcome?.text ?? JSON.stringify(outcome?.json ?? outcome, null, 2);
      if (!globalOpts.quiet) io.stdout.write(`${text}\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof CliUsageError) {
      io.stderr.write(`${err.message}\n`);
      return 2;
    }
    io.stderr.write(`${formatError(err, client)}\n`);
    return 1;
  } finally {
    client.close?.();
  }
}
