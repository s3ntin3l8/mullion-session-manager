import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { FILE_STREAM_CONTENT_TYPE } from "../shared/constants.js";
import {
  channelDownError,
  channelFetch,
  channelFetchStream,
  mapChannelError,
  refusalForStatus,
  type HostTransport,
} from "./agent-channel-tunnel.js";
import { HostRequestError, HostUnreachableError } from "./remote-host-errors.js";

/** A transport the exchange must not leave: the channel, or its absence. */
type BoundTransport = Exclude<HostTransport, { kind: "inbound" }>;

function channelOf(hostId: string, transport: BoundTransport) {
  if (transport.kind === "channel-down") throw channelDownError(hostId);
  return transport.channel;
}

// Issue #2620 — the file transfers and the HTTP preview forward of
// RemoteHostClient, over the host's outbound channel. Split out of
// remote-host-client.ts: the client decides the transport (and never dials the
// advertised URL for a bound host); these carry the exchange.

/**
 * uploadProjectFile over the outbound channel (#2620): the body is sent as it
 * is produced under the mux's send window, with the same idle (not total)
 * budget. The agent holds the body up to the channel's own limit before it
 * writes the file; a transfer above that is refused 413 (the exchange
 * rejects a declared size, or a body that outgrows the limit, before the agent runs anything).
 */
export async function uploadOverChannel(
  hostId: string,
  transport: BoundTransport,
  requestTarget: string,
  body: Readable,
  idleTimeoutMs: number,
  opts: { declaredBytes?: number } = {},
): Promise<{ path: string; size: number }> {
  const channel = channelOf(hostId, transport);
  let res;
  try {
    res = await channelFetch(channel, {
      method: "POST",
      path: requestTarget,
      headers: { "content-type": FILE_STREAM_CONTENT_TYPE },
      body,
      ...(opts.declaredBytes !== undefined ? { declaredBodyBytes: opts.declaredBytes } : {}),
      timeoutMs: idleTimeoutMs,
      idleTimeoutMs,
    });
  } catch (err) {
    throw mapChannelError(hostId, err, "POST", requestTarget);
  } finally {
    // The agent may have answered (a 413) while the body was still arriving:
    // discard the rest, so the primary can reply to its own client.
    body.resume();
  }
  const refusal = refusalForStatus(hostId, res.status, () => res.body.toString("utf8"));
  if (refusal) throw refusal;
  return JSON.parse(res.body.toString("utf8")) as { path: string; size: number };
}

/**
 * downloadProjectFile over the outbound channel (#2620). Every refusal is
 * thrown before a byte is returned; the file then streams under the idle
 * budget, read at the consumer's pace (the mux window only re-opens as it
 * reads) and capped at the channel's own download limit.
 */
export async function downloadOverChannel(
  hostId: string,
  transport: BoundTransport,
  cwd: string,
  relPath: string,
  idleTimeoutMs: number,
): Promise<{ stream: Readable; size: number | null; path: string; name: string }> {
  const requestTarget = "/internal/project-files/download";
  const channel = channelOf(hostId, transport);
  let res;
  try {
    res = await channelFetchStream(channel, {
      method: "POST",
      path: requestTarget,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, path: relPath }),
      timeoutMs: idleTimeoutMs,
      idleTimeoutMs,
    });
  } catch (err) {
    // A download changes nothing on the agent: always safe to report as down.
    throw mapChannelError(hostId, err, "GET", requestTarget);
  }
  if (res.status < 200 || res.status >= 300) {
    const text = await readAll(res.stream, 64 * 1024).catch(
      () => `(no response body — HTTP ${res.status})`,
    );
    res.stream.destroy();
    throw (
      refusalForStatus(hostId, res.status, () => text) ??
      new HostUnreachableError(hostId, new Error(`HTTP ${res.status}`))
    );
  }
  const rawLength = res.headers["content-length"];
  const size = typeof rawLength === "string" && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
  return { stream: res.stream, size, path: relPath, name: path.basename(relPath) };
}

/**
 * openPreviewHttpRequest over the outbound channel (#2620). The channel is the
 * credential, so no bearer or signature is set; `headers` arrives with the
 * browser's own `authorization` and signature headers already deleted, and
 * every `x-mullion-*` the browser sent is dropped here too (the agent would
 * otherwise replay one as if it were the primary's: the channel-auth header
 * included). Returns a Response like the inbound path does: a non-2xx upstream
 * status passes through, only a failure to reach the agent throws.
 */
export async function previewHttpOverChannel(
  hostId: string,
  transport: BoundTransport,
  requestTarget: string,
  init: { method: string; body?: ReadableStream<Uint8Array> },
  headers: Headers,
  idleTimeoutMs: number,
): Promise<Response> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (!name.toLowerCase().startsWith("x-mullion-")) forwarded[name] = value;
  }
  const channel = channelOf(hostId, transport);
  let res;
  try {
    res = await channelFetchStream(channel, {
      method: init.method,
      path: requestTarget,
      headers: forwarded,
      ...(init.body !== undefined
        ? { body: Readable.fromWeb(init.body as WebReadableStream) }
        : {}),
      timeoutMs: idleTimeoutMs,
      idleTimeoutMs,
      // A preview can run for as long as its dev server keeps the response
      // open (SSE, long-poll): it takes a stream-class slot, so it cannot
      // starve the request slots (#2674); the preview cap keeps previews from
      // taking the stream slots attach, events and relay need.
      stream: true,
      preview: true,
    });
  } catch (err) {
    throw mapChannelError(hostId, err, init.method.toUpperCase(), requestTarget);
  }
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    for (const v of Array.isArray(value) ? value : [value]) responseHeaders.append(name, v);
  }
  // A Response refuses a body on a null-body status (and a status outside 200-599).
  const nullBody =
    [101, 204, 205, 304].includes(res.status) || init.method.toUpperCase() === "HEAD";
  if (nullBody) res.stream.destroy();
  return new Response(nullBody ? null : (Readable.toWeb(res.stream) as ReadableStream), {
    status: res.status,
    headers: responseHeaders,
  });
}

/** Reads a (small) stream whole, stopping once it passes `maxBytes`. */
async function readAll(stream: Readable, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes) break;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** An AbortSignal that fires after `ms` without a `touch()`. */
export function idleAbort(ms: number): {
  signal: AbortSignal;
  touch: () => void;
  clear: () => void;
} {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error("transfer idle timeout")), ms);
  };
  arm();
  return {
    signal: controller.signal,
    touch: arm,
    clear: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** request()'s response handling, for the streaming methods that issue
 * their own fetch: 4xx -> HostRequestError (with the agent's body, so the
 * route can read its `code`), 5xx -> unreachable, 2xx -> parsed JSON. */
export async function readJsonResponse<T>(hostId: string, res: Response): Promise<T> {
  if (!res.ok) {
    if (res.status >= 400 && res.status < 500) {
      const text = await res.text().catch(() => `(no response body — HTTP ${res.status})`);
      throw new HostRequestError(hostId, res.status, text);
    }
    await res.body?.cancel().catch(() => undefined);
    throw new HostUnreachableError(hostId, new Error(`HTTP ${res.status}`));
  }
  return (await res.json()) as T;
}
