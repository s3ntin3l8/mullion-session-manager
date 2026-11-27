// Issue #3574 — the per-host update-status poll behind Settings → Hosts.
//
// Two kinds of host cannot answer GET /api/hosts/:id/update:
//
//   - a host awaiting approval: the server answers 409 ("host is awaiting
//     approval") — the approval gate, by design (src/routes/hosts.ts's
//     pendingHostReply);
//   - a host with no connected agent: the server answers 503.
//
// Asking either of them is a wasted request, and every one of them writes a
// "Failed to load resource" line to the browser console — a few dozen a
// minute with a handful of hosts. So this poll:
//
//   - never asks a host that cannot answer (approval pending, identity
//     revoked), and picks it up again within one interval once the host's
//     state changes (Approve, Re-pair);
//   - backs off after an answer the host could not give (409/503): the wait
//     doubles per unanswered poll, up to a minute, and a successful answer
//     (or a state change) puts the host back on the normal cadence;
//   - reads a new row's update status on its first tick, which is
//     immediate — the row's version label lands with the row, as it did
//     before this poll existed.
//
// The server is unchanged: it still answers 409 and 503.
import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { api, LOCAL_HOST_ID } from "../api/index.js";
import type { Host, HostUpdateStatus } from "../api/index.js";

// Issue #647 / roadmap 7.8 — separate from ServerInfoSection's own
// UPDATE_STATUS_POLL_MS (2000ms), which only gates the primary's own
// single global updater; N hosts need their own keyed poll, not a shared
// flat useState (same reasoning HostsSection's own pingStatus follows).
// Issue #3574 — this is also the cadence a host that CAN answer is polled
// at; a host that cannot backs off from here (see backoffMs).
export const HOST_UPDATE_POLL_MS = 2000;

// Issue #3574 — the longest the poll ever waits between two answers. Past
// this the host is asked once a minute, not never: an agent that comes back
// is picked up without the user waiting for a page reload.
export const HOST_UPDATE_POLL_MAX_MS = 60_000;

/**
 * The host state the poll's cadence is tied to: approval, health and
 * identity. A change in any of them means the host may answer again (or may
 * have stopped answering), so the backoff is dropped and the host is polled
 * again within one interval.
 */
function pollStateKey(host: Host): string {
  return [
    host.approvalPending ? "pending" : "approved",
    host.machineIdentityRevoked ? "revoked" : "unrevoked",
    host.hasMachineIdentity ? "identity" : "no-identity",
    host.health,
  ].join("|");
}

/**
 * Whether this host can answer the poll at all (issue #3574). A host
 * awaiting approval is refused by the server's approval gate (409), and a
 * host whose machine identity was revoked can no longer authenticate to its
 * agent (the server answers 503). Neither is worth asking.
 */
function canPoll(host: Host): boolean {
  return host.approvalPending !== true && host.machineIdentityRevoked !== true;
}

/** The status code of a failed request, if it carries one. */
function statusCodeOf(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { statusCode?: unknown }).statusCode;
  return typeof code === "number" ? code : null;
}

/**
 * Whether the answer is one the host itself could not give: the approval
 * gate (409) or an agent that is not connected (503). Both mean "ask me
 * again later, but not right now".
 */
function isUnanswerable(err: unknown): boolean {
  const code = statusCodeOf(err);
  return code === 409 || code === 503;
}

/**
 * The wait before the next poll, after the k-th answer the host could not
 * give: the normal interval for the first, then double per unanswered poll,
 * capped at a minute. A host that never answers is therefore asked at 2s,
 * 4s, 8s, 16s, 32s and then once a minute — never a request storm, never
 * more often than a minute apart.
 */
function backoffMs(unanswered: number): number {
  const exponent = Math.max(0, unanswered - 1);
  return Math.min(HOST_UPDATE_POLL_MS * 2 ** exponent, HOST_UPDATE_POLL_MAX_MS);
}

/** One host's poll state. */
interface HostPoller {
  /** The wait before this host's next poll. */
  intervalMs: number;
  /** How many answers in a row the host could not give (409/503). */
  unanswered: number;
  /** The pending timer, if any. */
  timer: ReturnType<typeof setTimeout> | null;
  /** The host state the current cadence was set under. */
  stateKey: string;
}

interface Engine {
  schedule: (hostId: string, delayMs: number) => void;
  cancel: (hostId: string) => void;
  poll: (hostId: string) => void;
  /** The tab is hidden: no requests while nobody is looking. */
  pause: () => void;
  /** The tab is visible again: every pollable host is armed again. */
  resume: () => void;
  /** The section is gone: every timer stops. */
  stop: () => void;
}

/**
 * The poll's machinery, built once per mount. It reads the host list, the
 * applying map and the status callback through refs, so it never has to be
 * rebuilt when the section re-renders.
 */
function createEngine(ctx: {
  hosts: RefObject<Host[]>;
  applying: RefObject<Record<string, boolean>>;
  onStatus: RefObject<(hostId: string, status: HostUpdateStatus) => void>;
  mounted: RefObject<boolean>;
  pollers: Map<string, HostPoller>;
}): Engine {
  const { hosts, applying, onStatus, mounted, pollers } = ctx;
  // While the tab is hidden nothing is asked of any host — the same "soft
  // pause" the live-refresh poll has always had.
  let hidden = typeof document !== "undefined" && document.visibilityState !== "visible";

  const hostById = (hostId: string): Host | undefined =>
    hosts.current.find((host) => host.id === hostId);

  const schedule = (hostId: string, delayMs: number): void => {
    const poller = pollers.get(hostId);
    if (!poller || hidden) return;
    if (poller.timer !== null) clearTimeout(poller.timer);
    poller.timer = setTimeout(() => {
      poller.timer = null;
      poll(hostId);
    }, delayMs);
  };

  const cancel = (hostId: string): void => {
    const poller = pollers.get(hostId);
    if (!poller || poller.timer === null) return;
    clearTimeout(poller.timer);
    poller.timer = null;
  };

  const poll = (hostId: string): void => {
    const poller = pollers.get(hostId);
    const host = hostById(hostId);
    if (!poller || !host || hidden) return;
    if (!canPoll(host)) {
      // The host cannot answer at all: no request is made. It is picked up
      // again when its state changes (the effect in the hook below re-arms
      // it), so this host is never polled while it stays in this state.
      cancel(hostId);
      poller.intervalMs = HOST_UPDATE_POLL_MS;
      poller.unanswered = 0;
      return;
    }
    if (applying.current[hostId] === true) {
      // An update is running on this host: the in-flight poll owns the
      // status, so this round is skipped and the cadence continues.
      schedule(hostId, HOST_UPDATE_POLL_MS);
      return;
    }
    // Armed BEFORE the request: a request that never answers must not stall
    // this host's poll. The answer re-arms the timer with the cadence the
    // host earns — the normal one, or the backoff.
    schedule(hostId, poller.intervalMs);
    api.getHostUpdateStatus(hostId).then(
      (status) => {
        // A host that answers is back on the normal cadence.
        poller.unanswered = 0;
        poller.intervalMs = HOST_UPDATE_POLL_MS;
        if (mounted.current) onStatus.current(hostId, status);
        schedule(hostId, HOST_UPDATE_POLL_MS);
      },
      (err: unknown) => {
        if (isUnanswerable(err)) {
          poller.unanswered += 1;
          poller.intervalMs = backoffMs(poller.unanswered);
        }
        // A failed fetch (host unreachable, old build) just means no
        // version/update UI renders for this row — the health dot already
        // communicates connectivity, no need for a second error surface.
        schedule(hostId, poller.intervalMs);
      },
    );
  };

  const pause = (): void => {
    hidden = true;
    for (const hostId of pollers.keys()) cancel(hostId);
  };

  const resume = (): void => {
    hidden = false;
    for (const [hostId, poller] of pollers) {
      const host = hostById(hostId);
      if (!host || !canPoll(host)) continue;
      schedule(hostId, poller.intervalMs);
    }
  };

  const stop = (): void => {
    for (const hostId of pollers.keys()) cancel(hostId);
    pollers.clear();
  };

  return { schedule, cancel, poll, pause, resume, stop };
}

export interface HostUpdateStatusPollOptions {
  /** Every host the section knows about; the local host is skipped. */
  hosts: Host[];
  /** The hosts with an update currently running — the in-flight poll owns those. */
  applying: Record<string, boolean>;
  /** Called with every fresh status. */
  onStatus: (hostId: string, status: HostUpdateStatus) => void;
}

/**
 * Polls every remote host's update status, at a cadence that follows what
 * the host can answer (issue #3574).
 */
export function useHostUpdateStatusPoll({
  hosts,
  applying,
  onStatus,
}: HostUpdateStatusPollOptions): void {
  const hostsRef = useRef(hosts);
  const applyingRef = useRef(applying);
  const onStatusRef = useRef(onStatus);
  const mountedRef = useRef(true);
  const pollersRef = useRef(new Map<string, HostPoller>());
  const engineRef = useRef<Engine | null>(null);

  // The refs are read from timers and promise callbacks, which run outside
  // React's render — they are kept current here (the same technique
  // usePolling uses for its `fn`).
  useEffect(() => {
    hostsRef.current = hosts;
  });
  useEffect(() => {
    applyingRef.current = applying;
  });
  useEffect(() => {
    onStatusRef.current = onStatus;
  });
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The poll's machinery, built once per mount. It reads the host list, the
  // applying map and the status callback through refs, so it never has to be
  // rebuilt when the section re-renders. Declared FIRST: the effects below
  // use it, and React runs the effects in declaration order.
  useEffect(() => {
    const engine = createEngine({
      hosts: hostsRef,
      applying: applyingRef,
      onStatus: onStatusRef,
      mounted: mountedRef,
      pollers: pollersRef.current,
    });
    engineRef.current = engine;
    return () => {
      // The section is gone: every timer stops.
      engine.stop();
      engineRef.current = null;
    };
  }, []);

  // Which remote hosts exist, and what each of them can answer: the poll's
  // cadence follows this, so a change here re-arms the affected host.
  const signature = hosts
    .filter((host) => host.id !== LOCAL_HOST_ID)
    .map((host) => `${host.id}#${pollStateKey(host)}`)
    .join("|");

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const pollers = pollersRef.current;
    const live = new Set<string>();
    for (const host of hostsRef.current) {
      if (host.id === LOCAL_HOST_ID) continue;
      live.add(host.id);
      const key = pollStateKey(host);
      const poller = pollers.get(host.id);
      if (!poller) {
        // A new row: its first poll is immediate, so the row's version
        // label lands as soon as the row does — the effect this poll
        // replaced fetched on mount. It is still gated on canPoll, so a
        // host that cannot answer is never asked, and the backoff that
        // follows an unanswered poll is untouched: the first answer is
        // what earns the wait, not the first tick.
        pollers.set(host.id, {
          intervalMs: HOST_UPDATE_POLL_MS,
          unanswered: 0,
          timer: null,
          stateKey: key,
        });
        if (canPoll(host)) engine.schedule(host.id, 0);
        continue;
      }
      if (poller.stateKey === key) continue;
      // The host's state changed (approval, health, identity): the backoff is
      // over, and the host is polled again within one interval.
      poller.stateKey = key;
      poller.intervalMs = HOST_UPDATE_POLL_MS;
      poller.unanswered = 0;
      if (canPoll(host)) engine.schedule(host.id, HOST_UPDATE_POLL_MS);
      else engine.cancel(host.id);
    }
    for (const [hostId, poller] of pollers) {
      if (live.has(hostId)) continue;
      if (poller.timer !== null) clearTimeout(poller.timer);
      pollers.delete(hostId);
    }
  }, [signature]);

  // The tab is hidden: no requests while nobody is looking.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") engine.resume();
      else engine.pause();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);
}
