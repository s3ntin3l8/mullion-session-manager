import type { FastifyInstance } from "fastify";
import type { MuxChannel } from "./ssh-agent-mux.js";
import type { ConnectedAgentChannel } from "../plugins/agent-channel.js";
import {
  HostOutcomeUnknownError,
  HostRequestError,
  HostUnreachableError,
  isIdempotentRequest,
} from "./remote-host-errors.js";
import {
  AGENT_CHANNEL_MAX_HEAD_BYTES,
  AGENT_CHANNEL_MAX_RESPONSE_BYTES,
  AGENT_CHANNEL_REQUESTS_OPERATION,
  type ChannelRequestHead,
  type ChannelResponseHead,
} from "../shared/agent-channel.js";

// Issue #2451 — request/response operations over the outbound agent channel.
//
// One mux channel carries one HTTP-shaped exchange. The primary opens it and
// sends a head line (JSON + "\n": method, path, headers), then the raw body,
// then EOF; the agent answers with a head line ({status, headers}), the raw
// body and EOF. The agent does NOT interpret the request: it replays it into
// its own Fastify instance (`app.inject`), so every /internal/* route, its
// validation and its authorization are exactly the ones the inbound transport
// uses. The only difference is the credential: the channel itself was
// authenticated by the machine credential (#2568), so the replay presents a
// process-local token (`AGENT_CHANNEL_AUTH_HEADER`) instead of the bearer +
// signature the inbound path needs. Contract: docs/agent-channel.md.
//
// Nothing here ever retries or falls back to another transport: whether a
// failed exchange may be repeated is the caller's decision.

/** Set by the agent's replay and accepted by routes/internal.ts's auth gate. */
export const AGENT_CHANNEL_AUTH_HEADER = "x-mullion-channel-auth";

/** How long the agent waits for a tunnelled request to arrive in full. */
const REQUEST_RECEIVE_TIMEOUT_MS = 120_000;
const WRITE_CHUNK_BYTES = 32 * 1024;
const FORWARDED_HEADERS = new Set(["content-type", "accept"]);
const REPLAY_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

// --- transport errors ------------------------------------------------------

/** A tunnelled exchange that did not complete. The caller maps it onto the
 * RemoteHostClient error taxonomy (rejected / unreachable / unknown outcome). */
export class ChannelTransportError extends Error {
  constructor(
    message: string,
    /** "before-send": nothing reached the agent; "after-send": some or all of
     * the request did, so whether it ran is unknown. */
    readonly phase: "before-send" | "after-send",
    /** Set when the primary itself closed the channel because the host's
     * identity was revoked or its credential expired. */
    readonly terminal: "revoked" | "expired" | null = null,
  ) {
    super(message);
    this.name = "ChannelTransportError";
  }
}

// --- shared helpers ----------------------------------------------------------

/** Writes `data` honouring the channel's send window; rejects if it closes. */
function makeWriter(channel: MuxChannel): (data: Buffer) => Promise<void> {
  let waiter: { resolve: () => void; reject: (err: Error) => void } | null = null;
  channel.onDrain(() => {
    const w = waiter;
    waiter = null;
    w?.resolve();
  });
  channel.onClose(() => {
    const w = waiter;
    waiter = null;
    w?.reject(new Error("channel closed"));
  });
  return async (data) => {
    let offset = 0;
    while (offset < data.length) {
      if (channel.closed) throw new Error("channel closed");
      const n = Math.min(WRITE_CHUNK_BYTES, data.length - offset, channel.sendWindow);
      if (n <= 0) {
        await new Promise<void>((resolve, reject) => {
          waiter = { resolve, reject };
        });
        continue;
      }
      channel.send(data.subarray(offset, offset + n));
      offset += n;
    }
  };
}

/** Control characters, space, DEL and backslash: they would split or confuse the request line. */
function hasUnsafeChar(target: string): boolean {
  for (let i = 0; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f || c === 0x5c) return true;
  }
  return false;
}

/** True when the path (before any query) has a "." / ".." segment, also when
 * percent-encoded: the router would normalise it out of /internal/. */
function hasDotSegment(target: string): boolean {
  const pathname = target.split("?")[0]!;
  return pathname.split("/").some((segment) => {
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === "." || decoded === "..";
    } catch {
      return true;
    }
  });
}

/** Splits a stream of chunks into one "\n"-terminated head and the body bytes. */
class HeadAndBodyParser {
  private head: Buffer[] = [];
  private headBytes = 0;
  private bodyChunks: Buffer[] = [];
  bodyBytes = 0;
  headLine: string | null = null;

  /** Returns false when a limit was exceeded. */
  push(chunk: Buffer, maxBodyBytes: number): boolean {
    let rest = chunk;
    if (this.headLine === null) {
      const nl = chunk.indexOf(0x0a);
      const take = nl === -1 ? chunk : chunk.subarray(0, nl);
      this.headBytes += take.length;
      if (this.headBytes > AGENT_CHANNEL_MAX_HEAD_BYTES) return false;
      this.head.push(take);
      if (nl === -1) return true;
      this.headLine = Buffer.concat(this.head).toString("utf8");
      rest = chunk.subarray(nl + 1);
    }
    this.bodyBytes += rest.length;
    if (this.bodyBytes > maxBodyBytes) return false;
    if (rest.length > 0) this.bodyChunks.push(rest);
    return true;
  }

  body(): Buffer {
    return Buffer.concat(this.bodyChunks);
  }
}

// --- primary side ------------------------------------------------------------

export interface ChannelRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs: number;
}

export interface ChannelResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * Performs one request over `entry`'s mux. Throws ChannelTransportError for
 * every failure to complete the exchange; an HTTP status from the agent (even
 * a 5xx) is a completed exchange and is returned.
 */
export async function channelFetch(
  entry: ConnectedAgentChannel,
  req: ChannelRequest,
): Promise<ChannelResponse> {
  const fail = (message: string, phase: "before-send" | "after-send"): ChannelTransportError =>
    new ChannelTransportError(message, phase, entry.terminal);
  let sendStarted = false;
  let channel: MuxChannel | null = null;
  let timedOut = false;
  let abortOpen: ((err: ChannelTransportError) => void) | null = null;
  const timer = setTimeout(() => {
    timedOut = true;
    channel?.close();
    abortOpen?.(
      fail(`timed out after ${req.timeoutMs} ms`, sendStarted ? "after-send" : "before-send"),
    );
  }, req.timeoutMs);

  try {
    channel = await new Promise<MuxChannel>((resolve, reject) => {
      abortOpen = reject;
      entry.mux
        .openChannel()
        .then(resolve, (err: unknown) =>
          reject(fail(err instanceof Error ? err.message : String(err), "before-send")),
        );
    });
    abortOpen = null;
    if (timedOut) {
      channel.close();
      throw fail(`timed out after ${req.timeoutMs} ms`, "before-send");
    }
    const ch = channel;

    const parser = new HeadAndBodyParser();
    const response = new Promise<ChannelResponse>((resolve, reject) => {
      let settled = false;
      const settle = (err: ChannelTransportError | null, value?: ChannelResponse) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(value!);
      };
      ch.onData((chunk) => {
        ch.acknowledgeConsumed(chunk.length);
        if (!parser.push(chunk, AGENT_CHANNEL_MAX_RESPONSE_BYTES)) {
          settle(fail("response exceeds the channel limit", "after-send"));
          ch.close();
        }
      });
      ch.onEof(() => {
        if (parser.headLine === null) {
          return settle(fail("channel ended before a response head", "after-send"));
        }
        try {
          const head = JSON.parse(parser.headLine) as ChannelResponseHead;
          if (!Number.isInteger(head.status)) throw new Error("bad status");
          settle(null, { status: head.status, headers: head.headers ?? {}, body: parser.body() });
        } catch {
          settle(fail("malformed response head", "after-send"));
        }
      });
      ch.onClose(() => {
        settle(
          fail(
            timedOut
              ? `timed out after ${req.timeoutMs} ms`
              : entry.terminal
                ? `outbound channel closed: ${entry.terminal}`
                : "outbound channel lost before the response completed",
            "after-send",
          ),
        );
      });
    });
    // Keeps an unobserved rejection (a send failure wins the race) quiet.
    response.catch(() => undefined);

    sendStarted = true;
    const head: ChannelRequestHead = {
      method: req.method,
      path: req.path,
      headers: req.headers ?? {},
    };
    const write = makeWriter(ch);
    try {
      await write(Buffer.from(`${JSON.stringify(head)}\n`, "utf8"));
      if (req.body !== undefined && req.body.length > 0) {
        await write(typeof req.body === "string" ? Buffer.from(req.body, "utf8") : req.body);
      }
      ch.eof();
    } catch {
      ch.close();
      throw fail(
        timedOut ? `timed out after ${req.timeoutMs} ms` : "outbound channel lost while sending",
        "after-send",
      );
    }
    try {
      return await response;
    } finally {
      ch.close();
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Issue #2451 — RemoteHostClient.request() over the channel. Same taxonomy as
 * the inbound path: a 4xx is HostRequestError, a 5xx or a transport failure
 * HostUnreachableError. Differences that matter: the credential is the channel
 * itself (no bearer, no signature, no 401 retry), and a failure AFTER the
 * request began sending is never retried, here or on the inbound URL; for a
 * non-idempotent request it is reported as HostOutcomeUnknownError.
 */
export async function requestViaChannel<T>(
  hostId: string,
  channel: ConnectedAgentChannel,
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body;
  if (body !== undefined && body !== null && typeof body !== "string" && !Buffer.isBuffer(body)) {
    throw new Error("outbound channel requests carry string or Buffer bodies only");
  }
  let res: ChannelResponse;
  try {
    res = await channelFetch(channel, {
      method,
      path,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: body ?? undefined,
      timeoutMs,
    });
  } catch (err) {
    if (!(err instanceof ChannelTransportError)) throw new HostUnreachableError(hostId, err);
    // The primary ended the channel: identity revoked / credential expired.
    if (err.terminal) throw new HostRequestError(hostId, 401, err.message);
    if (err.phase === "after-send" && !isIdempotentRequest(method, path)) {
      throw new HostOutcomeUnknownError(hostId, err);
    }
    throw new HostUnreachableError(hostId, err);
  }
  if (res.status < 200 || res.status >= 300) {
    if (res.status >= 400 && res.status < 500) {
      throw new HostRequestError(hostId, res.status, res.body.toString("utf8"));
    }
    throw new HostUnreachableError(hostId, new Error(`HTTP ${res.status}`));
  }
  if (res.status === 204) return undefined as T;
  return JSON.parse(res.body.toString("utf8")) as T;
}

// --- agent side --------------------------------------------------------------

/**
 * Serves one peer-initiated channel: reads the request, replays it into this
 * agent's own Fastify instance and writes the response back. Anything that is
 * not a plain /internal/* request is answered 4xx without being replayed.
 */
export function serveChannelRequest(
  app: FastifyInstance,
  channel: MuxChannel,
  authToken: string,
): void {
  const parser = new HeadAndBodyParser();
  const write = makeWriter(channel);
  let dispatched = false;
  // A peer that opens a channel and never finishes its request must not hold
  // it (and a channel slot) open forever.
  const receiveDeadline = setTimeout(() => {
    if (!dispatched) channel.close();
  }, REQUEST_RECEIVE_TIMEOUT_MS);
  receiveDeadline.unref?.();
  channel.onClose(() => clearTimeout(receiveDeadline));

  const respond = async (status: number, headers: Record<string, string>, body: Buffer) => {
    try {
      const head: ChannelResponseHead = { status, headers };
      await write(Buffer.from(`${JSON.stringify(head)}\n`, "utf8"));
      await write(body);
      channel.eof();
    } catch {
      // The primary went away (timeout, disconnect): nothing to answer.
    }
  };
  const refuse = (status: number, message: string) =>
    respond(
      status,
      { "content-type": "application/json" },
      Buffer.from(JSON.stringify({ message })),
    );

  channel.onData((chunk) => {
    channel.acknowledgeConsumed(chunk.length);
    if (dispatched) return;
    if (!parser.push(chunk, AGENT_CHANNEL_MAX_RESPONSE_BYTES)) {
      dispatched = true;
      void refuse(413, "request too large").finally(() => channel.close());
    }
  });
  channel.onEof(() => {
    if (dispatched) return;
    dispatched = true;
    void (async () => {
      try {
        let head: ChannelRequestHead;
        try {
          head = JSON.parse(parser.headLine ?? "") as ChannelRequestHead;
        } catch {
          return await refuse(400, "malformed request head");
        }
        const method = String(head.method).toUpperCase();
        if (!REPLAY_METHODS.has(method)) return await refuse(405, "method not allowed");
        // Only the token-gated agent API; never a WebSocket route or anything
        // outside /internal/. Control characters would split the request line.
        if (
          typeof head.path !== "string" ||
          !head.path.startsWith("/internal/") ||
          head.path.startsWith("/internal/ws/") ||
          hasUnsafeChar(head.path) ||
          hasDotSegment(head.path)
        ) {
          return await refuse(400, "path not carried by the channel");
        }
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(head.headers ?? {})) {
          const key = name.toLowerCase();
          if (typeof value !== "string") continue;
          if (FORWARDED_HEADERS.has(key) || key.startsWith("x-mullion-")) headers[key] = value;
        }
        // The presented credential is ours, never the peer's.
        headers[AGENT_CHANNEL_AUTH_HEADER] = authToken;
        const body = parser.body();
        const res = await app.inject({
          method: method as "GET",
          url: head.path,
          headers,
          ...(body.length > 0 ? { payload: body } : {}),
        });
        const outHeaders: Record<string, string> = {};
        const contentType = res.headers["content-type"];
        if (typeof contentType === "string") outHeaders["content-type"] = contentType;
        await respond(res.statusCode, outHeaders, res.rawPayload);
      } catch (err) {
        app.log.warn({ err }, "[agent-channel] replayed request failed");
        await refuse(500, "agent failed to handle the request");
      } finally {
        channel.close();
      }
    })();
  });
}

// --- primary side: which hosts ride the channel ------------------------------

// Hosts whose channel has negotiated the request transport during this
// process's life. Once bound, a host's requests never fall back to the inbound
// URL when the channel is down: a mutation whose outcome is unknown must not be
// repeated on another transport (#2451). Cleared on revoke / delete / a
// handshake that no longer negotiates it.
const boundHosts = new WeakMap<FastifyInstance, Set<string>>();

export function bindChannelHost(app: FastifyInstance, hostId: string): void {
  let set = boundHosts.get(app);
  if (!set) boundHosts.set(app, (set = new Set()));
  set.add(hostId);
}

export function unbindChannelHost(app: FastifyInstance, hostId: string): void {
  boundHosts.get(app)?.delete(hostId);
}

export type HostTransport =
  | { kind: "channel"; channel: ConnectedAgentChannel }
  /** Negotiated the channel, which is down right now: fail, do not dial inbound. */
  | { kind: "channel-down" }
  | { kind: "inbound" };

/** Chosen from negotiated support, not from whether a socket happens to be open. */
export function resolveHostTransport(app: FastifyInstance, hostId: string): HostTransport {
  const channel = app.agentChannels.get(hostId);
  if (channel && channel.carriedOperations.includes(AGENT_CHANNEL_REQUESTS_OPERATION)) {
    return { kind: "channel", channel };
  }
  return boundHosts.get(app)?.has(hostId) ? { kind: "channel-down" } : { kind: "inbound" };
}
