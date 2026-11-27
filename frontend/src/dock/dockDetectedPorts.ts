import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "../api/index.js";

// #3589 — which running Dock commands on this server have a port the server
// detected in their output: the Browser quick pick's `dock:<sessionId>`
// entries (services/browser-destinations.ts). A row's "Open in browser" opens
// that entry. Polled while one runs, since the port shows up in the output
// after the start.
//
// One poll per project, shared by every surface showing it (the bottom Dock
// and the rail's Dock view), the way dockProjectShared.ts shares the
// controls poll (#3036): two mounted surfaces must not poll the same
// endpoint twice.

export const DETECTED_PORT_POLL_MS = 5_000;

/** A detected port's entry: its key, and its address on this server. */
export interface DetectedDestination {
  key: string;
  address: string | null;
}

export type DetectedDestinations = ReadonlyMap<number, DetectedDestination>;

interface Entry {
  destinations: DetectedDestinations;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  /** The running sessions the poll was started for: a new run restarts it
   * at once rather than waiting out the interval. */
  signature: string | undefined;
  seq: number;
}

const EMPTY: DetectedDestinations = new Map();
const entries = new Map<number, Entry>();

function sameEntries(a: DetectedDestinations, b: DetectedDestinations): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (w?.key !== v.key || w.address !== v.address) return false;
  }
  return true;
}

function fetchDestinations(projectId: number, entry: Entry): void {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  const seq = ++entry.seq;
  void api.getBrowserDestinations(projectId).then(
    (result) => {
      if (entries.get(projectId) !== entry || entry.seq !== seq) return;
      const next = new Map<number, DetectedDestination>();
      for (const d of result.destinations) {
        if (d.kind === "dock") {
          next.set(Number(d.key.slice("dock:".length)), { key: d.key, address: d.address });
        }
      }
      if (sameEntries(entry.destinations, next)) return;
      entry.destinations = next;
      for (const listener of entry.listeners) listener();
    },
    () => {
      // Best effort: without the answer a row offers only the dev server.
    },
  );
}

function startPoll(projectId: number, entry: Entry) {
  if (entry.timer !== null) clearInterval(entry.timer);
  fetchDestinations(projectId, entry);
  entry.timer = setInterval(() => fetchDestinations(projectId, entry), DETECTED_PORT_POLL_MS);
}

function subscribe(projectId: number, listener: () => void): () => void {
  let entry = entries.get(projectId);
  if (!entry) {
    entry = {
      destinations: EMPTY,
      listeners: new Set(),
      timer: null,
      signature: undefined,
      seq: 0,
    };
    entries.set(projectId, entry);
  }
  const own = entry;
  own.listeners.add(listener);
  return () => {
    own.listeners.delete(listener);
    if (own.listeners.size > 0) return;
    if (own.timer !== null) clearInterval(own.timer);
    if (entries.get(projectId) === own) entries.delete(projectId);
  };
}

function syncSignature(projectId: number, signature: string) {
  const entry = entries.get(projectId);
  if (!entry || entry.signature === signature) return;
  entry.signature = signature;
  startPoll(projectId, entry);
}

/**
 * The project's detected Dock ports by session id, polled while `enabled`
 * (a command runs on this server and the surface can open a browser).
 * `runningSignature` names the running sessions: a change re-fetches now.
 */
export function useDetectedDockPorts(
  projectId: number,
  runningSignature: string,
  enabled: boolean,
): DetectedDestinations {
  const subscribeFor = useCallback(
    (listener: () => void) => (enabled ? subscribe(projectId, listener) : () => {}),
    [projectId, enabled],
  );
  const destinations = useSyncExternalStore(subscribeFor, () =>
    enabled ? (entries.get(projectId)?.destinations ?? EMPTY) : EMPTY,
  );
  useEffect(() => {
    if (enabled) syncSignature(projectId, runningSignature);
  }, [projectId, runningSignature, enabled]);
  return destinations;
}
