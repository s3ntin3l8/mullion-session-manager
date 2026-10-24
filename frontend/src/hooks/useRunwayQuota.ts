import { useEffect, useState } from "react";
import { api } from "../api/index.js";
import type { RunwayQuota } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";

// Issue #29 — the Runway quota snapshot (GET /api/runway/quota).
//
// ONE request serves every session row's badge: the quota belongs to the
// PROVIDER, not to a row, so the snapshot is cached at module level and
// shared by every caller (rows mount one after another and all ask the same
// question). A failed request is NOT cached — the next mount retries it —
// and it yields null, which means "no quota information", never "every
// agent is fine" (the same posture the backend's runway-client.ts takes).

// How long a snapshot is reused. The server polls Runway on its own
// interval (settings.runway.pollSeconds); re-reading after a minute keeps a
// long-lived tab from freezing on the first answer it ever saw.
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  quota: RunwayQuota;
  apiUrl: string;
  at: number;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<RunwayQuota | null> | null = null;

// Test seam — forgets the shared snapshot so one test's answer can't leak
// into the next.
export function __resetRunwayQuotaCacheForTests(): void {
  cache = null;
  inFlight = null;
}

function fetchQuota(apiUrl: string): Promise<RunwayQuota | null> {
  const now = Date.now();
  if (cache !== null && cache.apiUrl === apiUrl && now - cache.at < CACHE_TTL_MS) {
    return Promise.resolve(cache.quota);
  }
  if (inFlight !== null) return inFlight;
  inFlight = api
    .getRunwayQuota()
    .then((quota) => {
      cache = { quota, apiUrl, at: Date.now() };
      return quota;
    })
    .catch(() => null)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function useRunwayQuota(): RunwayQuota | null {
  // The feature is off until a server URL is configured. That half is a
  // plain setting the store already holds, so an install that never uses
  // Runway makes no request at all — and the badge stays silent instead of
  // asking the server about a feature that isn't there.
  const apiUrl = useDashboardStore((s) => s.settings?.runway?.apiUrl ?? "");
  const [quota, setQuota] = useState<RunwayQuota | null>(null);

  useEffect(() => {
    if (apiUrl === "") return;
    let cancelled = false;
    // setState only happens in the promise callback, never synchronously in
    // the effect body (same rule the rest of the frontend follows).
    void fetchQuota(apiUrl).then((snapshot) => {
      if (!cancelled) setQuota(snapshot);
    });
    return () => {
      cancelled = true;
    };
  }, [apiUrl]);

  return quota;
}
