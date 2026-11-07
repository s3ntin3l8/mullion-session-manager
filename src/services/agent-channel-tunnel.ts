import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { type MuxChannel, MuxBusyError } from "./ssh-agent-mux.js";
import type { ConnectedAgentChannel } from "../plugins/agent-channel.js";
import {
  HostBusyError,
  HostOutcomeUnknownError,
  HostRequestError,
  HostResponseTooLargeError,
  HostUnreachableError,
  isIdempotentRequest,
} from "./remote-host-errors.js";
import {
  AGENT_CHANNEL_DEFAULT_MAX_REQUEST_BYTES,
  AGENT_CHANNEL_DEFAULT_MAX_RESPONSE_BYTES,
  AGENT_CHANNEL_MAX_HEAD_BYTES,
  AGENT_CHANNEL_MAX_RESPONSE_BYTES,
  AGENT_CHANNEL_SLOT_WAIT_GRACE_MS,
  AGENT_CHANNEL_REQUESTS_OPERATION,
  AGENT_CHANNEL_SLOT_WAIT_MS,
  AGENT_CHANNEL_STREAMS_OPERATION,
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
// A preview forwards whatever method the browser used.
const PREVIEW_REPLAY_METHODS = new Set([...REPLAY_METHODS, "HEAD", "OPTIONS"]);
// Never replayed for a preview: framing the agent's own inject recomputes, and
// every credential header (the replay presents the channel's own token; a
// browser-supplied one must not reach a project's dev server).
const PREVIEW_DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "authorization",
  "x-request-signature",
  "x-request-timestamp",
  "x-request-nonce",
]);
const DROPPED_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding"]);

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
    /** The transfer outgrew the channel's size limit (#2674): a refusal of the
     * request (413), not a sign the host is down. */
    readonly tooLarge: boolean = false,
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

/** The HTTP preview forwards (#2620): they carry a browser's request, so they
 * get the browser-facing header treatment and the large body limits. */
export function isPreviewPath(path: string): boolean {
  const p = path.split("?")[0]!;
  return p.startsWith("/internal/preview/") || p === "/internal/configured-preview";
}

export function maxRequestBodyBytesForPath(path: string): number {
  if (isUploadPath(path) || isPreviewPath(path)) return AGENT_CHANNEL_MAX_RESPONSE_BYTES;
  return AGENT_CHANNEL_DEFAULT_MAX_REQUEST_BYTES;
}

export function maxResponseBodyBytesForPath(path: string): number {
  if (isDownloadPath(path) || isPreviewPath(path)) return AGENT_CHANNEL_MAX_RESPONSE_BYTES;
  return AGENT_CHANNEL_DEFAULT_MAX_RESPONSE_BYTES;
}

function formatLimit(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MiB` : `${bytes} bytes`;
}
/** A response that carries no body whatever its Content-Length says. */
export function responseHasNoBody(method: string, status: number): boolean {
  return (
    method.toUpperCase() === "HEAD" ||
    (status >= 100 && status < 200) ||
    status === 204 ||
    status === 304
  );
}
export function requestTooLargeMessage(cap: number): string {
  return `request body exceeds the ${formatLimit(cap)} limit of the outbound channel to this host`;
}
/** Set on the 413 the agent answers when a response head declares more than
 * the channel's limit, so it is not mistaken for the origin's own 413. */
export const RESPONSE_TOO_LARGE_HEADER = "x-mullion-response-too-large";

export function responseTooLargeMessage(cap: number): string {
  return `response exceeds the ${formatLimit(cap)} limit of the outbound channel to this host`;
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

  /** The body bytes so far, which the caller now owns. */
  takeBody(): Buffer {
    const taken = Buffer.concat(this.bodyChunks);
    this.bodyChunks = [];
    return taken;
  }
}

// --- primary side ------------------------------------------------------------

export interface ChannelRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  /** A Readable is sent as it is produced, under the channel's send window. */
  body?: string | Buffer | Readable;
  timeoutMs: number;
  /** Replaces the total `timeoutMs` budget with one that re-arms whenever a
   * byte moves in either direction (large transfers, #2620). */
  idleTimeoutMs?: number;
  /** Closes the channel (and fails the exchange) when it fires. */
  signal?: AbortSignal;
  maxResponseBytes?: number;
  /** Size of a streamed `body`, when the caller already knows it (a
   * Content-Length): above the channel's limit it is refused before any byte
   * is sent. */
  declaredBodyBytes?: number;
  /** Takes a stream-class slot (`AGENT_CHANNEL_MAX_STREAM_CHANNELS`) instead
   * of a request slot, so long-lived exchanges (a preview's SSE / long-poll)
   * can never starve ordinary requests. Refused at once, not queued, when the
   * stream budget is spent. */
  stream?: boolean;
  /** A preview response: a stream that also counts against the (smaller)
   * preview cap (`AGENT_CHANNEL_MAX_PREVIEW_CHANNELS`). Implies `stream`. */
  preview?: boolean;
}

export interface ChannelResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

/** channelFetchStream's result: the response body is read as it arrives. */
export interface ChannelStreamResponse {
  status: number;
  headers: Record<string, string | string[]>;
  /** Ends at EOF; errors if the channel is lost or the response outgrows
   * `maxResponseBytes`. Destroying it closes the channel. */
  stream: Readable;
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
  return (await exchange(entry, req, false)) as ChannelResponse;
}

/**
 * channelFetch, but the response body is handed back as a Readable as soon as
 * the head arrives (#2620), so a large download never sits in memory whole. The
 * mux window is only re-opened as the consumer reads, so buffering is bounded
 * by the window plus the Readable's own high-water mark.
 */
export async function channelFetchStream(
  entry: ConnectedAgentChannel,
  req: ChannelRequest,
): Promise<ChannelStreamResponse> {
  return (await exchange(entry, req, true)) as ChannelStreamResponse;
}

async function exchange(
  entry: ConnectedAgentChannel,
  req: ChannelRequest,
  streaming: boolean,
): Promise<ChannelResponse | ChannelStreamResponse> {
  const fail = (
    message: string,
    phase: "before-send" | "after-send",
    tooLarge = false,
  ): ChannelTransportError => new ChannelTransportError(message, phase, entry.terminal, tooLarge);
  let sendStarted = false;
  let channel: MuxChannel | null = null;
  let timedOut = false;
  let aborted = false;
  let abortOpen: ((err: Error) => void) | null = null;
  const limitMs = req.idleTimeoutMs ?? req.timeoutMs;
  const timeoutMessage = `timed out after ${limitMs} ms${req.idleTimeoutMs ? " idle" : ""}`;
  let timer: NodeJS.Timeout | undefined;
  const onTimeout = () => {
    timedOut = true;
    channel?.close();
    abortOpen?.(fail(timeoutMessage, sendStarted ? "after-send" : "before-send"));
  };
  // The slot wait is not charged to the exchange: the timer is stopped while
  // queued and restarted with the full budget once the slot is granted. The
  // wait has its own bound, the mux's `waitTimeoutMs`; this backstop covers a
  // mux that never settles.
  let slotWaitTimer: NodeJS.Timeout | undefined;
  const onSlotWaitBackstop = () => {
    abortOpen?.(
      new ChannelBusyError(
        `timed out after ${AGENT_CHANNEL_SLOT_WAIT_MS} ms waiting for free channel slot`,
      ),
    );
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(onTimeout, limitMs);
  };
  // An idle budget re-arms on every byte that moves; a total one never does.
  const touch = req.idleTimeoutMs !== undefined ? arm : () => undefined;
  const onAbort = () => {
    aborted = true;
    channel?.close();
    abortOpen?.(fail("aborted", sendStarted ? "after-send" : "before-send"));
  };
  const release = () => {
    clearTimeout(timer);
    clearTimeout(slotWaitTimer);
    req.signal?.removeEventListener("abort", onAbort);
  };
  if (req.signal?.aborted) throw fail("aborted", "before-send");
  // An over-limit body that is already in memory is refused before a channel
  // is even opened (#2674). A streamed one is cut off at the limit in sendBody.
  const requestCap = maxRequestBodyBytesForPath(req.path);
  if (req.body !== undefined && !(req.body instanceof Readable)) {
    const len = typeof req.body === "string" ? Buffer.byteLength(req.body) : req.body.length;
    if (len > requestCap) throw fail(requestTooLargeMessage(requestCap), "before-send", true);
  }
  if (req.declaredBodyBytes !== undefined && req.declaredBodyBytes > requestCap) {
    throw fail(requestTooLargeMessage(requestCap), "before-send", true);
  }
  req.signal?.addEventListener("abort", onAbort, { once: true });
  arm();
  // A streamed response outlives this call: its Readable owns the channel and
  // the timer from the head on.
  let handedOff = false;

  try {
    channel = await new Promise<MuxChannel>((resolve, reject) => {
      let settled = false;
      abortOpen = (err) => {
        settled = true;
        reject(err);
      };
      entry.mux
        .openChannel({
          waitTimeoutMs: AGENT_CHANNEL_SLOT_WAIT_MS,
          ...(req.preview ? { preview: true } : req.stream ? { stream: true } : {}),
          onWaiting: () => {
            clearTimeout(timer);
            slotWaitTimer = setTimeout(
              onSlotWaitBackstop,
              AGENT_CHANNEL_SLOT_WAIT_MS + AGENT_CHANNEL_SLOT_WAIT_GRACE_MS,
            );
          },
          onSlotAcquired: () => {
            clearTimeout(slotWaitTimer);
            if (!settled) arm();
          },
        })
        .then(
          (ch) => {
            if (settled) {
              ch.close();
              return;
            }
            settled = true;
            resolve(ch);
          },
          (err: unknown) => {
            if (settled) return;
            settled = true;
            if (err instanceof MuxBusyError) {
              reject(new ChannelBusyError(err.message));
            } else {
              reject(fail(err instanceof Error ? err.message : String(err), "before-send"));
            }
          },
        );
    });
    abortOpen = null;
    if (timedOut || aborted) {
      channel.close();
      throw fail(timedOut ? timeoutMessage : "aborted", "before-send");
    }
    const ch = channel;

    const parser = new HeadAndBodyParser();
    const maxResponseBytes = req.maxResponseBytes ?? maxResponseBodyBytesForPath(req.path);
    const lostMessage = () =>
      timedOut
        ? timeoutMessage
        : aborted
          ? "aborted"
          : entry.terminal
            ? `outbound channel closed: ${entry.terminal}`
            : "outbound channel lost before the response completed";
    const response = new Promise<ChannelResponse | ChannelStreamResponse>((resolve, reject) => {
      let settled = false;
      const settle = (
        err: ChannelTransportError | null,
        value?: ChannelResponse | ChannelStreamResponse,
      ) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(value!);
      };
      // Streaming: set once the head is in, from then on the body goes here.
      let out: Readable | null = null;
      let eofSeen = false;
      let bodyBytes = 0;
      // Bytes received but not yet released to the peer's send window (the
      // consumer has not asked for them).
      let held = 0;
      const startStream = () => {
        let head: ChannelResponseHead;
        try {
          head = JSON.parse(parser.headLine!) as ChannelResponseHead;
          if (!Number.isInteger(head.status)) throw new Error("bad status");
        } catch {
          settle(fail("malformed response head", "after-send"));
          ch.close();
          return;
        }
        const body = new Readable({
          read() {
            if (held > 0) {
              const n = held;
              held = 0;
              ch.acknowledgeConsumed(n);
            }
          },
          destroy(err, cb) {
            cb(err);
            ch.close();
          },
        });
        out = body;
        const first = parser.takeBody();
        bodyBytes = first.length;
        if (first.length > 0) body.push(first);
        settle(null, { status: head.status, headers: head.headers ?? {}, stream: body });
      };
      // The length the head promises, or 0 where no body follows whatever the
      // headers say: a HEAD reply and the null-body statuses carry the
      // Content-Length of the representation they describe (#2690).
      const declaredLength = (): number => {
        try {
          const head = JSON.parse(parser.headLine!) as ChannelResponseHead;
          if (responseHasNoBody(req.method, head.status)) return 0;
          const raw = head.headers?.["content-length"];
          const n = Number(Array.isArray(raw) ? raw[0] : raw);
          return Number.isFinite(n) ? n : 0;
        } catch {
          return 0;
        }
      };
      ch.onData((chunk) => {
        touch();
        if (out) {
          bodyBytes += chunk.length;
          if (bodyBytes > maxResponseBytes) {
            out.destroy(fail(responseTooLargeMessage(maxResponseBytes), "after-send", true));
            return;
          }
          if (out.push(chunk)) ch.acknowledgeConsumed(chunk.length);
          else held += chunk.length;
          return;
        }
        ch.acknowledgeConsumed(chunk.length);
        if (!parser.push(chunk, maxResponseBytes)) {
          settle(fail(responseTooLargeMessage(maxResponseBytes), "after-send", true));
          ch.close();
          return;
        }
        if (parser.headLine !== null && declaredLength() > maxResponseBytes) {
          // The head already says the body will not fit: refuse before any of
          // it is read (#2674).
          settle(fail(responseTooLargeMessage(maxResponseBytes), "after-send", true));
          ch.close();
          return;
        }
        if (streaming && parser.headLine !== null) startStream();
      });
      ch.onEof(() => {
        if (out) {
          eofSeen = true;
          out.push(null);
          return;
        }
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
        if (out) {
          if (!eofSeen) out.destroy(fail(lostMessage(), "after-send"));
          return;
        }
        settle(fail(lostMessage(), "after-send"));
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
    // Returns why the request body could not be sent in full (its own source
    // failed, or it outgrew the limit), or null. A failure of the channel
    // itself is thrown.
    const sendBody = async (): Promise<string | null> => {
      const body = req.body;
      if (body === undefined) return null;
      if (!(body instanceof Readable)) {
        if (body.length > 0)
          await write(typeof body === "string" ? Buffer.from(body, "utf8") : body);
        return null;
      }
      const cap = requestCap;
      let sent = 0;
      let writing = false;
      try {
        // destroyOnReturn: false — an early exit (the agent answered 413 while
        // the body was still arriving) must not tear down the caller's own
        // request; it drains what is left itself.
        for await (const piece of body.iterator({ destroyOnReturn: false })) {
          const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array);
          sent += buf.length;
          if (sent > cap) return requestTooLargeMessage(cap);
          writing = true;
          await write(buf);
          writing = false;
          touch();
        }
      } catch (err) {
        if (writing) throw err;
        return "request body stream failed";
      }
      return null;
    };
    let res: ChannelResponse | ChannelStreamResponse | undefined;
    let bodyFailure: string | null = null;
    try {
      await write(Buffer.from(`${JSON.stringify(head)}\n`, "utf8"));
      touch();
      bodyFailure = await sendBody();
      if (bodyFailure === null) ch.eof();
    } catch {
      try {
        res = await response;
      } catch {
        ch.close();
        throw fail(
          timedOut ? timeoutMessage : aborted ? "aborted" : "outbound channel lost while sending",
          "after-send",
        );
      }
    }
    if (bodyFailure !== null) {
      // Half a request was sent: the agent must not run it, so end the channel
      // rather than the body.
      // The agent only runs a request once it has the whole body and EOF, so a
      // request cut short here never ran: nothing for the caller to doubt.
      ch.close();
      throw fail(bodyFailure, "before-send", bodyFailure === requestTooLargeMessage(requestCap));
    }
    if (res === undefined) {
      try {
        res = await response;
      } catch (err) {
        ch.close();
        throw err;
      }
    }
    if ("stream" in res) {
      handedOff = true;
      res.stream.once("close", release);
    } else {
      ch.close();
    }
    return res;
  } finally {
    if (!handedOff) release();
  }
}

/**
 * Maps a failed exchange onto the RemoteHostClient error taxonomy, the same for
 * every caller of the channel: busy is retryable, a failure after the request
 * began sending is an unknown outcome unless the request is idempotent, a
 * channel the primary ended (revoked / expired) is a 401, anything else is the
 * host being unreachable.
 */
export function mapChannelError(
  hostId: string,
  err: unknown,
  method: string,
  path: string,
  body?: string | Buffer | null,
): Error {
  if (err instanceof ChannelBusyError) return new HostBusyError(hostId, err);
  if (!(err instanceof ChannelTransportError)) return new HostUnreachableError(hostId, err);
  // An over-limit transfer is the request's fault, not the host's: 413 with the
  // limit named. A response that outgrew the limit of a non-idempotent request
  // already ran, so that stays an unknown outcome.
  if (err.tooLarge && (err.phase === "before-send" || isIdempotentRequest(method, path, body))) {
    const body = JSON.stringify({ message: err.message });
    return err.phase === "before-send"
      ? new HostRequestError(hostId, 413, body)
      : new HostResponseTooLargeError(hostId, body);
  }
  if (err.phase === "after-send" && !isIdempotentRequest(method, path, body)) {
    return new HostOutcomeUnknownError(hostId, err);
  }
  if (err.terminal) return new HostRequestError(hostId, 401, err.message);
  return new HostUnreachableError(hostId, err);
}

/** The error a non-2xx status stands for (4xx a rejection, 5xx unreachable), or null. */
export function refusalForStatus(
  hostId: string,
  status: number,
  bodyText: () => string,
): Error | null {
  if (status >= 200 && status < 300) return null;
  if (status >= 400 && status < 500) return new HostRequestError(hostId, status, bodyText());
  return new HostUnreachableError(hostId, new Error(`HTTP ${status}`));
}

/**
 * The error for a bound host whose channel is down. One message, so a caller
 * cannot drift from request(): the advertised URL is never dialed instead.
 */
export function channelDownError(hostId: string): HostUnreachableError {
  return new HostUnreachableError(
    hostId,
    new Error("outbound channel is not connected (not falling back to the advertised URL)"),
  );
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
    throw mapChannelError(hostId, err, method, path, body);
  }
  const refusal = refusalForStatus(hostId, res.status, () => res.body.toString("utf8"));
  if (refusal) throw refusal;
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
  opts: { maxResponseBytes?: number } = {},
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

  const respond = async (
    status: number,
    headers: Record<string, string | string[]>,
    body: Buffer,
  ) => {
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
        const preview = typeof head.path === "string" && isPreviewPath(head.path);
        if (!(preview ? PREVIEW_REPLAY_METHODS : REPLAY_METHODS).has(method)) {
          return await refuse(405, "method not allowed");
        }
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
          if (preview) {
            // A browser's own headers (cookies, validators, range ...) travel to
            // the dev server; its credentials, and anything claiming to be
            // Mullion's, never do (the replay's own token is set below).
            if (!PREVIEW_DROPPED_REQUEST_HEADERS.has(key) && !key.startsWith("x-mullion-")) {
              headers[key] = value;
            }
          } else if (FORWARDED_HEADERS.has(key) || key.startsWith("x-mullion-")) {
            headers[key] = value;
          }
        }
        // The presented credential is ours, never the peer's.
        headers[AGENT_CHANNEL_AUTH_HEADER] = authToken;
        const body = parser.body();
        const peer = peerId ?? "peer";
        // payloadAsStream: the inject resolves once the response's headers are
        // out, and the body is read chunk by chunk below. Nothing is buffered
        // past the channel's own limit (#2674), and an SSE / long-poll preview
        // delivers each chunk as it is written instead of at the end.
        // The primary may give up (timeout, disconnect) while the dev server
        // is still producing headers: the close handler is registered before
        // the call, and aborts the replay's request so the upstream is dropped
        // now, not when the server finally answers (#2690).
        const replay = new AbortController();
        let gone = channel.closed;
        let payload: Readable | null = null;
        let onGone: () => void = () => undefined;
        const goneSignal = new Promise<null>((resolve) => {
          onGone = () => resolve(null);
        });
        channel.onClose(() => {
          gone = true;
          // Before the headers: cancel the replay itself. After them the
          // response stream is destroyed as before; aborting then would make
          // the replayed route's own error handler write into a sent reply.
          if (payload === null) replay.abort();
          else payload.destroy();
          onGone();
        });
        if (gone) {
          replay.abort();
          return;
        }
        const injected = app.inject({
          method: method as "GET",
          url: head.path,
          headers,
          remoteAddress: `channel:${peer}`,
          payloadAsStream: true,
          signal: replay.signal,
          ...(body.length > 0 ? { payload: body } : {}),
        });
        injected.catch(() => undefined);
        const res = await Promise.race([injected, goneSignal]);
        if (res === null) return;
        // Every response header but the framing the channel replaces: a
        // download needs its content-length, a preview its location,
        // set-cookie and validators.
        const outHeaders: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined || DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
          outHeaders[name.toLowerCase()] = Array.isArray(value) ? value.map(String) : String(value);
        }
        const stream = res.stream();
        payload = stream;
        if (gone) {
          stream.destroy();
          return;
        }
        const cap = opts.maxResponseBytes ?? maxResponseBodyBytesForPath(head.path);
        const bodyless = responseHasNoBody(method, res.statusCode);
        const declared = Number(outHeaders["content-length"]);
        if (!bodyless && Number.isFinite(declared) && declared > cap) {
          stream.destroy();
          // Marked so the primary can tell the dev server's response outgrew the
          // limit from a 413 the dev server itself answered (#2702).
          return await respond(
            413,
            { "content-type": "application/json", [RESPONSE_TOO_LARGE_HEADER]: "1" },
            Buffer.from(JSON.stringify({ message: responseTooLargeMessage(cap) })),
          );
        }
        let wroteHead = false;
        try {
          await write(
            Buffer.from(
              `${JSON.stringify({ status: res.statusCode, headers: outHeaders })}\n`,
              "utf8",
            ),
          );
          wroteHead = true;
          if (bodyless) {
            stream.destroy();
          } else {
            let sent = 0;
            for await (const piece of stream) {
              const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array);
              sent += buf.length;
              // An undeclared length is bounded as it arrives. Past the limit
              // the response is ended with the ERROR end marker: the channel
              // is closed WITHOUT the EOF a complete response ends with, which
              // the primary reports as a failed response (never as a short,
              // clean one). docs/multi-host.md, "Outbound transfers".
              if (sent > cap) {
                stream.destroy();
                app.log.warn(
                  { cap, path: head.path },
                  "[agent-channel] response over the channel limit, ended with an error",
                );
                return;
              }
              await write(buf);
            }
          }
          channel.eof();
        } catch (err) {
          stream.destroy();
          // Before the head went out the primary can still be answered; after
          // that the channel just ends short and the primary reports it lost.
          if (!wroteHead && !channel.closed) throw err;
        }
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
  opts: { maxResponseBytes?: number } = {},
): void {
  const sink = createRequestSink(app, channel, authToken, peerId, opts);
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

/**
 * Whether the primary has any way to reach a host: an address to dial
 * (`baseUrl`), or an outbound channel the agent dials in on — connected right
 * now, or bound from an earlier connection (#2636). A manual host with neither
 * has nothing to reach yet, so the fan-outs and syncs skip it.
 */
export function hasReachablePath(
  app: FastifyInstance,
  host: { id: string; baseUrl: string | null },
): boolean {
  return (
    host.baseUrl !== null ||
    app.agentChannels?.has(host.id) === true ||
    isChannelHostBound(app, host.id)
  );
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

/**
 * Whether a host's streams are bound to its outbound channel while that channel
 * is down. A stream there can only fail with "not connected", so a fan-out
 * skips the attempt (at debug level) and waits for the channel-up reconcile
 * (routes/agent-channel.ts) instead of retrying with backoff and a warning each
 * time.
 */
export function isStreamChannelDown(app: FastifyInstance, hostId: string): boolean {
  return resolveHostTransport(app, hostId, AGENT_CHANNEL_STREAMS_OPERATION).kind === "channel-down";
}
