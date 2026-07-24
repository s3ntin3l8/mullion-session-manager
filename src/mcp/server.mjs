#!/usr/bin/env node
// Issue #271 — `mullion mcp`, a minimal stdio MCP server exposing
// `promote_to_worktree` as its first tool (see tools.mjs's own doc comment
// for why this is the extension point issue #134's later CLI-backed tools
// register onto). Deliberately plain JavaScript, spawned directly by
// whatever launches it (the claude-code hook adapter's generated MCP
// config) rather than imported by Mullion's server process — same
// dev/prod-parity reasoning as src/hooks/forwarder.mjs's own header
// comment (no dist/ build step to go stale, runs identically under `tsx`
// and compiled).
//
// Hand-rolled JSON-RPC 2.0 over stdio rather than @modelcontextprotocol/sdk:
// this server exposes exactly one tool today, and the wire protocol
// (newline-delimited JSON-RPC, `initialize`/`tools/list`/`tools/call`) is
// small enough to implement directly without taking on a new dependency
// this environment can't runtime-verify against a real MCP client. If #134
// grows this into a multi-tool, HTTP-transport server, revisit adopting the
// SDK then — TOOLS' registry shape (tools.mjs) was chosen to make that
// migration a transport swap, not a tool-by-tool rewrite.
//
// Protocol notes (verified against modelcontextprotocol.io/specification):
// - Transport: newline-delimited JSON-RPC 2.0, one message per line.
//   stdout carries ONLY protocol messages — all logging goes to stderr.
// - `initialize` -> `{protocolVersion, capabilities, serverInfo}`, followed
//   by the client's `notifications/initialized` (no response expected).
// - `tools/list` -> `{tools: [{name, description, inputSchema}]}`.
// - `tools/call` -> `{name, arguments}` in, `{content: [{type:"text",
//   text}], isError?}` out — a thrown handler error becomes `isError: true`
//   with the error message as the text content, never a JSON-RPC-level
//   error (that's reserved for protocol-level problems: unknown method,
//   malformed request).

import { MullionClient } from "./client.mjs";
import { TOOLS } from "./tools.mjs";

const PROTOCOL_VERSION = "2025-11-25";
const SERVER_INFO = { name: "mullion", version: "0.1.0" };

const client = new MullionClient();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleToolsCall(id, params) {
  const tool = TOOLS.find((t) => t.name === params?.name);
  if (!tool) {
    respond(id, {
      content: [{ type: "text", text: `Unknown tool: ${params?.name}` }],
      isError: true,
    });
    return;
  }
  try {
    const text = await tool.handler(params?.arguments ?? {}, client);
    respond(id, { content: [{ type: "text", text }], isError: false });
  } catch (err) {
    respond(id, {
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    });
  }
}

async function handleMessage(message) {
  const { id, method, params } = message;
  // A message with no `id` is a notification — no response is ever sent,
  // regardless of method (per the JSON-RPC 2.0 spec this transport follows).
  const isNotification = id === undefined;

  switch (method) {
    case "initialize":
      if (!isNotification) {
        respond(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      }
      return;
    case "notifications/initialized":
      // Nothing to do — this server has no per-client state to set up.
      return;
    case "tools/list":
      if (!isNotification) {
        respond(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      }
      return;
    case "tools/call":
      if (!isNotification) await handleToolsCall(id, params);
      return;
    default:
      // Unsupported methods (resources/*, prompts/*, ...) — this server
      // declares no capability for them, so a spec-compliant client won't
      // call them; a "Method not found" error is the safe response if one
      // does, and notifications for unknown methods are silently ignored
      // per the spec (never a response, since there's no `id` to reply to).
      if (!isNotification) respondError(id, -32601, `Method not found: ${method}`);
      return;
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex = buffer.indexOf("\n");
  while (newlineIndex !== -1) {
    const line = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);
    newlineIndex = buffer.indexOf("\n");
    if (line.trim() === "") continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // Malformed JSON with no way to recover an `id` to reply to —
      // logged to stderr (never stdout, which is protocol-only) and
      // otherwise ignored, same fail-safe posture as forwarder.mjs.
      process.stderr.write(`mullion-mcp: malformed message, ignoring: ${line}\n`);
      continue;
    }
    void handleMessage(message).catch((err) => {
      process.stderr.write(
        `mullion-mcp: unhandled error: ${err instanceof Error ? err.stack : err}\n`,
      );
    });
  }
});

process.stdin.on("end", () => process.exit(0));
