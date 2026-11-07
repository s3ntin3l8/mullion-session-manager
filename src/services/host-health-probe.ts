import { findSsrfBlock } from "./pinned-connect.js";

type LogFn = (obj: object, msg: string) => void;

/**
 * The inbound `/health` probe behind `RemoteHostClient.probe()`: a healthy
 * agent's `/health` is intentionally unauthenticated, so this is a bare fetch,
 * and it never throws.
 *
 * `makeDispatcher` runs inside the promise chain on purpose. It throws
 * synchronously for a URL the SSRF policy now refuses (a host's baseUrl is
 * re-read on every call), and built as a fetch argument it would escape the
 * `.catch` and turn the Settings "test connection" route into a 500 (#2702).
 * A blocked host is simply "down", with the refusal logged.
 */
export function probeHealth(
  baseUrl: string,
  timeoutMs: number,
  makeDispatcher: () => RequestInit["dispatcher"],
  failures?: { hostId: string; log: { warn: LogFn; debug: LogFn } | undefined },
): Promise<"ok" | "down"> {
  return Promise.resolve()
    .then(() =>
      fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
        // Same redirect-bypass reasoning as RemoteHostClient.request(): no
        // bearer token to leak here, but a followed redirect would still report
        // "online" from an unvalidated target's response instead of the
        // configured baseUrl's own.
        redirect: "manual",
        dispatcher: makeDispatcher(),
      }),
    )
    .then(
      (res) => (res.ok ? "ok" : "down"),
      (err: unknown) => {
        // A URL the SSRF policy refuses can never answer; say so (warn), so it
        // does not read as a host that is merely asleep. An ordinary network
        // failure is the heartbeat's normal business (debug).
        const level = findSsrfBlock(err) ? "warn" : "debug";
        failures?.log?.[level]({ hostId: failures.hostId, err }, "host health probe failed");
        return "down";
      },
    );
}
