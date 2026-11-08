import path from "node:path";
import { Readable, Transform, pipeline } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { FILE_STREAM_CONTENT_TYPE } from "../shared/constants.js";
import { idleAbort, readJsonResponse } from "./remote-host-channel-transfers.js";
import { HostRequestError, HostUnreachableError } from "./remote-host-errors.js";
import type { RemoteHostTransport } from "./remote-host-transport.js";

// Split out of remote-host-client-core.ts (issue #2714, its size ceiling): the
// two streamed inbound file transfers. Both take their dispatcher, bearer token
// and signature headers from the transport — nothing here builds its own SSRF
// pinning — and both keep the redirect: "manual" the transport's rawFetch sets.
//
// Their 401 behaviour DIFFERS on purpose; do not "fix" it into parity:
//  - uploadInbound never retries: its body stream is single-use, so a
//    stale-credential failure surfaces to the caller instead of being replayed.
//  - downloadInbound retries once with refreshed credentials, as request().

/** The inbound (non-channel) half of RemoteHostClient.uploadProjectFile. */
export async function uploadInbound(
  transport: RemoteHostTransport,
  requestTarget: string,
  body: Readable,
  transferIdleTimeoutMs: number,
): Promise<{ path: string; size: number }> {
  const idle = idleAbort(transferIdleTimeoutMs);
  const metered = body.pipe(
    new Transform({
      transform(chunk, _enc, cb) {
        idle.touch();
        cb(null, chunk);
      },
    }),
  );
  // A client that hangs up mid-upload ends `body` with an error; propagate
  // it so fetch aborts instead of waiting for bytes that never come.
  body.on("error", (err) => metered.destroy(err));
  let res: Response;
  try {
    res = await fetch(`${transport.baseUrl}${requestTarget}`, {
      method: "POST",
      headers: {
        "content-type": FILE_STREAM_CONTENT_TYPE,
        authorization: `Bearer ${transport.token}`,
        ...transport.signatureHeaders("POST", requestTarget, undefined),
      },
      body: Readable.toWeb(metered) as ReadableStream<Uint8Array>,
      duplex: "half",
      redirect: "manual",
      signal: idle.signal,
      dispatcher: transport.pinnedDispatcher(),
    } as RequestInit & { duplex: "half" });
  } catch (err) {
    idle.clear();
    // fetch failed before a response existed; drop the unread body so the
    // caller's connection is not held open.
    body.unpipe(metered);
    metered.destroy();
    body.resume();
    throw new HostUnreachableError(transport.hostId, err);
  }
  // Headers are in, but the (small) result body is not. Re-arm the timer so
  // it bounds that read: a fixed deadline of one idle period from here (the
  // body is a few bytes of JSON and never touches the clock itself), so a
  // stalled agent can't hang the upload request — and the browser's XHR
  // behind it — forever.
  idle.touch();
  try {
    // Read the JSON refusal (409/413 carry `code`) BEFORE discarding the
    // request body. Destroying a still-uploading body first makes undici
    // tear down the connection the response is arriving on.
    return await readJsonResponse<{ path: string; size: number }>(transport.hostId, res);
  } catch (err) {
    // An abort from the idle timer surfaces as a fetch/body error: that is
    // the agent going quiet, not a refusal.
    if (err instanceof HostRequestError) throw err;
    if (idle.signal.aborted) throw new HostUnreachableError(transport.hostId, err);
    throw err;
  } finally {
    idle.clear();
    // The agent may have answered (a 409, a 413) while the body was still
    // arriving: discard the rest, so the primary can reply to its own client
    // instead of resetting the connection under it.
    body.unpipe(metered);
    metered.destroy();
    body.resume();
  }
}

/** The inbound (non-channel) half of RemoteHostClient.downloadProjectFile. */
export async function downloadInbound(
  transport: RemoteHostTransport,
  cwd: string,
  relPath: string,
  transferIdleTimeoutMs: number,
): Promise<{ stream: Readable; size: number | null; path: string; name: string }> {
  const open = async () => {
    const requestTarget = "/internal/project-files/download";
    const payload = JSON.stringify({ cwd, path: relPath });
    const idle = idleAbort(transferIdleTimeoutMs);
    try {
      const res = await fetch(`${transport.baseUrl}${requestTarget}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${transport.token}`,
          ...transport.signatureHeaders("POST", requestTarget, payload),
        },
        body: payload,
        redirect: "manual",
        signal: idle.signal,
        dispatcher: transport.pinnedDispatcher(),
      } as RequestInit);
      return { res, idle };
    } catch (err) {
      idle.clear();
      throw new HostUnreachableError(transport.hostId, err);
    }
  };
  let { res, idle } = await open();
  if (res.status === 401 && transport.refreshCredentials) {
    const fresh = transport.refreshCredentials();
    if (
      fresh &&
      (fresh.token !== transport.token || fresh.sessionSecret !== transport.sessionSecret)
    ) {
      await res.body?.cancel().catch(() => undefined);
      idle.clear();
      transport.token = fresh.token;
      transport.sessionSecret = fresh.sessionSecret;
      ({ res, idle } = await open());
    }
  }
  if (!res.ok || !res.body) {
    idle.clear();
    return readJsonResponse(transport.hostId, res);
  }
  // Null-safe: Number(null) and Number("") are 0, which would read as "an
  // empty file" and truncate the download the primary then serves.
  const rawLength = res.headers.get("content-length");
  const size = rawLength !== null && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
  const stream = new Transform({
    transform(chunk, _enc, cb) {
      idle.touch();
      cb(null, chunk);
    },
    flush(cb) {
      idle.clear();
      cb();
    },
  });
  // pipeline, not .pipe(): a body that errors (the idle abort, a dropped
  // connection) must END `stream` with that error. Piping leaves the output
  // open forever — the primary's reply to its client would hang.
  pipeline(Readable.fromWeb(res.body as WebReadableStream), stream, () => idle.clear());
  // An aborted/stalled body must not leave the idle timer armed.
  stream.on("close", () => idle.clear());
  return {
    stream,
    size,
    path: relPath,
    name: path.basename(relPath),
  };
}
