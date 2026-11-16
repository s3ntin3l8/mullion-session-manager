import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "../api/index.js";
import type { DockControl } from "../api/index.js";

// What every mounted useDockProject for one project shares for its data
// (#3036): ONE poll of GET /api/projects/:id/dock. The bottom Dock's
// DockProjectGroup and the right sidebar's Dock view can both be mounted for
// one project (a fine pointer between 700 and 1099px); each used to poll on
// its own timer, so there were two requests per interval and the two copies
// could disagree on a container's state between their polls. Now the first
// subscriber starts the poll, the last one to leave stops it and drops the
// cache, and every subscriber reads the same `controls`. The auto-attach
// state the surfaces share is in dockAutoAttach.ts.

// Issue #73 — how often a project with a mounted Dock surface re-fetches
// GET .../dock, so a container's state/image reflects `docker ps` reality
// without the user having to toggle anything. The backend's own
// getComposeServices() cache (docker-service-detect.ts) TTLs at 10s
// specifically so this 15s interval only pays for a fresh `docker ps`
// roughly once per poll, not once per project.
export const DOCKER_POLL_INTERVAL_MS = 15_000;

interface Entry {
  controls: DockControl[];
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  // The dockConfigRefreshTrigger value the poll last (re)started for;
  // undefined until the first subscriber's effect reports it.
  trigger: number | undefined;
  // Latest request wins: a response to an older request (a poll overtaken
  // by a refresh, or a poll from before a trigger bump) is dropped.
  seq: number;
}

const EMPTY: DockControl[] = [];
// Before the first response: empty too, but told apart from a loaded empty
// list by identity, so auto-attach does not read "nothing discovered" (and
// prune what it knows) before the poll has answered.
const NOT_LOADED: DockControl[] = [];
const entries = new Map<number, Entry>();

function setControls(entry: Entry, controls: DockControl[]) {
  entry.controls = controls;
  for (const listener of entry.listeners) listener();
}

function fetchControls(projectId: number, entry: Entry, clearOnError: boolean): Promise<void> {
  const seq = ++entry.seq;
  const current = () => entries.get(projectId) === entry && entry.seq === seq;
  return api.listProjectDock(projectId).then(
    (next) => {
      if (current()) setControls(entry, next);
    },
    () => {
      if (current() && clearOnError) setControls(entry, EMPTY);
    },
  );
}

function startPoll(projectId: number, entry: Entry) {
  if (entry.timer !== null) clearInterval(entry.timer);
  void fetchControls(projectId, entry, true);
  entry.timer = setInterval(() => {
    void fetchControls(projectId, entry, true);
  }, DOCKER_POLL_INTERVAL_MS);
}

function subscribe(projectId: number, listener: () => void): () => void {
  let entry = entries.get(projectId);
  if (!entry) {
    entry = {
      controls: NOT_LOADED,
      listeners: new Set(),
      timer: null,
      trigger: undefined,
      seq: 0,
    };
    entries.set(projectId, entry);
    startPoll(projectId, entry);
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

// A dock config save bumps the store's dockConfigRefreshTrigger. Every
// subscriber reports the value it sees, but only the first report of a new
// value re-fetches (and restarts the interval), so N subscribers still make
// one request.
function syncTrigger(projectId: number, trigger: number) {
  const entry = entries.get(projectId);
  if (!entry || entry.trigger === trigger) return;
  const first = entry.trigger === undefined;
  entry.trigger = trigger;
  // The first subscriber's own subscribe already fetched.
  if (!first) startPoll(projectId, entry);
}

/** The project's shared Dock controls, whether the poll has answered yet,
 * and a refresh that re-fetches them now for every subscriber (after a
 * service action). */
export function useSharedDockControls(projectId: number, refreshTrigger: number) {
  const subscribeFor = useCallback(
    (listener: () => void) => subscribe(projectId, listener),
    [projectId],
  );
  const controls = useSyncExternalStore(
    subscribeFor,
    () => entries.get(projectId)?.controls ?? NOT_LOADED,
  );
  useEffect(() => {
    syncTrigger(projectId, refreshTrigger);
  }, [projectId, refreshTrigger]);
  const refreshNow = useCallback(async () => {
    const entry = entries.get(projectId);
    // A failed refresh keeps what is shown: the next scheduled poll retries.
    if (entry) await fetchControls(projectId, entry, false);
  }, [projectId]);
  return { controls, loaded: controls !== NOT_LOADED, refreshNow };
}
