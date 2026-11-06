import type { FastifyInstance } from "fastify";
import { type MuxChannel, MuxBusyError } from "./ssh-agent-mux.js";
import type { ConnectedAgentChannel } from "../plugins/agent-channel.js";
import {
  HostBusyError,
  HostOutcomeUnknownError,
  HostRequestError,
  HostUnreachableError,
  isIdempotentRequest,
} from "./remote-host-errors.js";
import {
  AGENT_CHANNEL_DEFAULT_MAX_REQUEST_BYTES,
  AGENT_CHANNEL_DEFAULT_MAX_RESPONSE_BYTES,
  AGENT_CHANNEL_MAX_HEAD_BYTES,
  AGENT_CHANNEL_MAX_RESPONSE_BYTES,
  AGENT_CHANNEL_MIN_EXCHANGE_MS,
  AGENT_CHANNEL_REQUESTS_OPERATION,
  AGENT_CHANNEL_SLOT_WAIT_MS,
  type ChannelRequestHead,
  type ChannelResponseHead,
} from "../shared/agent-channel.js";

export { AGENT_CHANNEL_MAX_CHANNELS } from "../shared/agent-channel.js";

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

/** Receives a channel's inbound bytes / half-close from whoever owns its listeners. */
export interface ChannelSink {
  data(chunk: Buffer): void;
  eof(): void;
}

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

/** Thrown when the channel concurrency cap is reached and no slot opens in time. */
export class ChannelBusyError extends Error {
  readonly busy = true as const;
  readonly isBusy = true as const;
  constructor(message = "outbound channel concurrency cap reached") {
    super(message);
    this.name = "ChannelBusyError";
  }
}

export function isUploadPath(path: string): boolean {
  const p = path.split("?")[0]!;
  return (
    p === "/internal/uploads" ||
    p === "/internal/project-files/upload" ||
    p === "/internal/project-files/write"
  );
}

export function isDownloadPath(path: string): boolean {
  const p = path.split("?")[0]!;
  return p === "/internal/project-files/download";
}

export function maxRequestBodyBytesForPath(path: string): number {
  if (isUploadPath(path)) return AGENT_CHANNEL_MAX_RESPONSE_BYTES;
  return AGENT_CHANNEL_DEFAULT_MAX_REQUEST_BYTES;
}

export function maxResponseBodyBytesForPath(path: string): number {
  if (isDownloadPath(path)) return AGENT_CHANNEL_MAX_RESPONSE_BYTES;
  return AGENT_CHANNEL_DEFAULT_MAX_RESPONSE_BYTES;
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

/**
 * Decodes path segments and checks for undecodable, double-encoded, ws, and dot-segment paths.
 * Returns null if the path is invalid, malformed or prohibited.
 */
export function validateAndDecodePath(target: string): string | null {
  const pathname = target.split("?")[0]!;
  const segments = pathname.split("/");
  const decodedSegments: string[] = [];
  for (const seg of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return null;
    }
    // Reject double-encoded segments (e.g. %2577 -> %77 or %25 -> %)
    if (decoded.includes("%")) {
      return null;
    }
    if (decoded === "." || decoded === "..") {
      return null;
    }
    decodedSegments.push(decoded);
  }
  const decodedPath = decodedSegments.join("/");
  if (!decodedPath.startsWith("/internal/")) return null;
  if (decodedPath.startsWith("/internal/ws/")) return null;
  if (hasUnsafeChar(target) || hasUnsafeChar(decodedPath)) return null;
  return decodedPath;
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
  maxResponseBytes?: number;
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
  let waitingForSlot = false;
  let abortOpen: ((err: Error) => void) | null = null;
  const timer = setTimeout(() => {
    timedOut = true;
    channel?.close();
    if (waitingForSlot) {
      abortOpen?.(
        new ChannelBusyError(`timed out after ${req.timeoutMs} ms waiting for free channel slot`),
      );
    } else {
      abortOpen?.(
        fail(`timed out after ${req.timeoutMs} ms`, sendStarted ? "after-send" : "before-send"),
      );
    }
  }, req.timeoutMs);

  const slotWaitTimeoutMs = Math.min(
    AGENT_CHANNEL_SLOT_WAIT_MS,
    Math.max(0, req.timeoutMs - AGENT_CHANNEL_MIN_EXCHANGE_MS),
  );

  try {
    channel = await new Promise<MuxChannel>((resolve, reject) => {
      let settled = false;
      abortOpen = (err) => {
        settled = true;
        reject(err);
      };
      entry.mux
        .openChannel({
          waitTimeoutMs: slotWaitTimeoutMs,
          onWaiting: () => {
            waitingForSlot = true;
          },
        })
        .then(
          (ch) => {
            waitingForSlot = false;
            if (settled) {
              ch.close();
              return;
            }
            settled = true;
            resolve(ch);
          },
          (err: unknown) => {
            waitingForSlot = false;
            if (settled) return;
            settled = true;
            if (
              err instanceof MuxBusyError ||
              (err instanceof Error && err.message.includes("channel cap"))
            ) {
              reject(new ChannelBusyError(err instanceof Error ? err.message : String(err)));
            } else {
              reject(fail(err instanceof Error ? err.message : String(err), "before-send"));
            }
          },
        );
    });
    abortOpen = null;
    if (timedOut) {
      channel.close();
      throw fail(`timed out after ${req.timeoutMs} ms`, "before-send");
    }
    const ch = channel;

    const parser = new HeadAndBodyParser();
    const maxResponseBytes = req.maxResponseBytes ?? maxResponseBodyBytesForPath(req.path);
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
        if (!parser.push(chunk, maxResponseBytes)) {
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
      try {
        return await response;
      } catch {
        ch.close();
        throw fail(
          timedOut ? `timed out after ${req.timeoutMs} ms` : "outbound channel lost while sending",
          "after-send",
        );
      }
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
    if (err instanceof ChannelBusyError) {
      throw new HostBusyError(hostId, err);
    }
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
export function createRequestSink(
  app: FastifyInstance,
  channel: MuxChannel,
  authToken: string,
  peerId?: string,
): ChannelSink {
  const parser = new HeadAndBodyParser();
  const write = makeWriter(channel);
  let dispatched = false;
  let maxBodyBytes = AGENT_CHANNEL_DEFAULT_MAX_REQUEST_BYTES;
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

  const onData = (chunk: Buffer) => {
    channel.acknowledgeConsumed(chunk.length);
    if (dispatched) return;
    if (parser.headLine === null) {
      if (!parser.push(chunk, maxBodyBytes)) {
        dispatched = true;
        void refuse(413, "request too large").finally(() => channel.close());
        return;
      }
      if (parser.headLine !== null) {
        try {
          const head = JSON.parse(parser.headLine) as ChannelRequestHead;
          if (typeof head.path === "string") {
            maxBodyBytes = maxRequestBodyBytesForPath(head.path);
          }
          const cl = Number(head.headers?.["content-length"] ?? head.headers?.["Content-Length"]);
          if (Number.isFinite(cl) && cl > maxBodyBytes) {
            dispatched = true;
            void refuse(413, "request too large").finally(() => channel.close());
            return;
          }
        } catch {
          // malformed head, handled on EOF
        }
        if (parser.bodyBytes > maxBodyBytes) {
          dispatched = true;
          void refuse(413, "request too large").finally(() => channel.close());
          return;
        }
      }
    } else {
      if (!parser.push(chunk, maxBodyBytes)) {
        dispatched = true;
        void refuse(413, "request too large").finally(() => channel.close());
      }
    }
  };
  const onEof = () => {
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
        // Decode the path and check for undecodable/double-encoded segments, dot-segments,
        // control characters, and websocket routes.
        if (typeof head.path !== "string") {
          return await refuse(400, "path not carried by the channel");
        }
        const decodedPath = validateAndDecodePath(head.path);
        if (decodedPath === null) {
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
        const peer = peerId ?? "peer";
        const res = await app.inject({
          method: method as "GET",
          url: head.path,
          headers,
          remoteAddress: `channel:${peer}`,
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
  };
  return { data: onData, eof: onEof };
}

/** Wires a request sink straight onto the channel's own listeners. */
export function serveChannelRequest(
  app: FastifyInstance,
  channel: MuxChannel,
  authToken: string,
  peerId?: string,
): void {
  const sink = createRequestSink(app, channel, authToken, peerId);
  channel.onData(sink.data);
  channel.onEof(sink.eof);
}

// --- primary side: which hosts ride the channel ------------------------------

// Operations each host's channel has negotiated during this process's life.
// Once bound, a host's traffic for that operation never falls back to the
// inbound URL when the channel is down: a mutation whose outcome is unknown
// must not be repeated on another transport (#2451), and a stream must not
// silently change transport under its consumer (#2571). Replaced on every
// handshake (so one that no longer negotiates an operation clears it) and
// cleared on revoke / delete.
// Keyed on app.agentChannels (decorated by fastify-plugin) so encapsulated route
// instances share the same binding set as the root app.
const boundHosts = new WeakMap<object, Map<string, ReadonlySet<string>>>();

export function bindChannelHost(
  app: FastifyInstance,
  hostId: string,
  operations: readonly string[] = [AGENT_CHANNEL_REQUESTS_OPERATION],
): void {
  const key = (app.agentChannels as unknown as object) ?? app;
  let map = boundHosts.get(key);
  if (!map) boundHosts.set(key, (map = new Map()));
  map.set(hostId, new Set(operations));
}

export function unbindChannelHost(app: FastifyInstance, hostId: string): void {
  const key = (app.agentChannels as unknown as object) ?? app;
  boundHosts.get(key)?.delete(hostId);
}

export function isChannelHostBound(
  app: FastifyInstance,
  hostId: string,
  operation: string = AGENT_CHANNEL_REQUESTS_OPERATION,
): boolean {
  const key = (app.agentChannels as unknown as object) ?? app;
  return boundHosts.get(key)?.get(hostId)?.has(operation) ?? false;
}

export type HostTransport =
  | { kind: "channel"; channel: ConnectedAgentChannel }
  /** Negotiated the channel, which is down right now: fail, do not dial inbound. */
  | { kind: "channel-down" }
  | { kind: "inbound" };

/** Chosen from negotiated support, not from whether a socket happens to be open. */
export function resolveHostTransport(
  app: FastifyInstance,
  hostId: string,
  operation: string = AGENT_CHANNEL_REQUESTS_OPERATION,
): HostTransport {
  const channel = app.agentChannels?.get(hostId);
  if (channel && channel.carriedOperations.includes(operation)) {
    return { kind: "channel", channel };
  }
  const key = (app.agentChannels as unknown as object) ?? app;
  return boundHosts.get(key)?.get(hostId)?.has(operation)
    ? { kind: "channel-down" }
    : { kind: "inbound" };
}
