// Phase 4 (#185) — the wire-protocol parser for the general-purpose control
// socket (src/plugins/control-socket.ts). A pure parser with no I/O, same
// "socket listener and its own test suite share exactly one validator"
// reasoning as src/services/hook-protocol.ts (the hook socket's own
// counterpart) — but a different, deliberately generic shape: every
// client→server line here is a `{id, op, body?}` request/command envelope
// (docs/socket-api.md), not a `kind`-discriminated event.
//
// Unlike hook-protocol.ts's per-`kind` payload validators, this layer
// validates only the envelope. Each op's own `body` shape is validated by
// whatever handles that op — for REST-mapped ops (control-socket.ts's OPS
// table) that's the injected route's own ajv schema; a malformed body simply
// comes back as the route's normal 400, not a protocol-level parse error
// here. That keeps this file from re-deriving (and risking drift from) every
// route's schema.

export interface ControlMessage {
  id: number;
  op: string;
  body?: Record<string, unknown>;
}

// The error variant carries `id` (recovered from whatever of the line
// actually parsed, or null if even that much failed) so a caller can reply
// with a correlatable error without re-parsing the same line a second time
// just to recover it — see control-socket.ts's malformed-message handling.
export type ParseControlMessageResult =
  { ok: true; message: ControlMessage } | { ok: false; error: string; id: number | null };

export function parseControlMessage(line: string): ParseControlMessageResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, error: "malformed JSON", id: null };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "message must be a JSON object", id: null };
  }
  const payload = parsed as Record<string, unknown>;
  const recoveredId = Number.isFinite(payload.id) ? (payload.id as number) : null;

  if (typeof payload.id !== "number" || !Number.isFinite(payload.id)) {
    return { ok: false, error: "message must have a numeric 'id' field", id: recoveredId };
  }
  if (typeof payload.op !== "string" || payload.op.length === 0) {
    return { ok: false, error: "message must have a non-empty string 'op' field", id: recoveredId };
  }
  if (
    payload.body !== undefined &&
    (typeof payload.body !== "object" || payload.body === null || Array.isArray(payload.body))
  ) {
    return { ok: false, error: "'body', when present, must be a JSON object", id: recoveredId };
  }

  return {
    ok: true,
    message: {
      id: payload.id,
      op: payload.op,
      body: payload.body as Record<string, unknown> | undefined,
    },
  };
}

/** Parses the mandatory line-1 handshake — `{"token": "..."}` or `{}` when
 * no token is presented (accepted only when auth is disabled — see
 * control-socket.ts's handleConnection). Distinct from parseControlMessage
 * since the handshake has no `id`/`op` envelope at all. */
export interface ControlHandshake {
  token: string | null;
}

export function parseControlHandshake(line: string): ControlHandshake | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const token = (parsed as { token?: unknown }).token;
  return { token: typeof token === "string" && token.length > 0 ? token : null };
}
