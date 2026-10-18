import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/index.js";
import type {
  CacheStorageStatus,
  DevWorktreeStatus,
  DockerStorageStatus,
  Measured,
  OpencodeStorageStatus,
  SystemStats,
  TempStorageStatus,
} from "../api/index.js";
import { usePolling } from "../hooks/usePolling.js";

// The server measures Docker, temp files, caches, opencode and worktrees in the
// background and answers at once with whatever it has, so a probe that is still
// `measuring` is polled until it settles.
const MEASURING_POLL_MS = 2000;

function useProbe<T>(fetcher: (refresh: boolean) => Promise<Measured<T>>) {
  const [value, setValue] = useState<Measured<T> | null>(null);
  // Responses can arrive out of order (a slow poll answering after the Refresh
  // that came later), so only the newest request is allowed to set the value.
  const latest = useRef(0);
  const load = (refresh = false) => {
    const mine = ++latest.current;
    return fetcher(refresh).then(
      (next) => {
        if (mine === latest.current) setValue(next);
      },
      (error: unknown) => {
        if (mine !== latest.current) return;
        const message = error instanceof ApiError ? error.message : "Could not load";
        // Any figures already on screen stay; they are just marked as failed to refresh.
        setValue(
          (previous) =>
            ({
              ...previous,
              state: "error",
              measuredAt: previous?.measuredAt ?? null,
              error: message,
            }) as Measured<T>,
        );
      },
    );
  };
  // Before the first answer there is nothing to show, which reads as measuring.
  const measuring = value === null || value.state === "measuring";
  return { value, load, measuring, loaded: value !== null };
}

export function useStorageProbes() {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const docker = useProbe<DockerStorageStatus>((r) => api.getDockerStorage(r));
  const temp = useProbe<TempStorageStatus>((r) => api.getTempStorage(r));
  const caches = useProbe<CacheStorageStatus>((r) => api.getCacheStorage(r));
  const opencode = useProbe<OpencodeStorageStatus>((r) => api.getOpencodeStorage(r));
  const worktrees = useProbe<DevWorktreeStatus>((r) => api.getDevWorktrees(r));
  const probes = [docker, temp, caches, opencode, worktrees];

  const loadStats = (refresh = false) =>
    api.getSystemStats(refresh).then(
      (next) => {
        setStats(next);
        setStatsError(null);
      },
      (error: unknown) => {
        setStatsError(error instanceof ApiError ? error.message : "Could not load disk usage");
      },
    );

  useEffect(() => {
    void loadStats();
    for (const probe of probes) void probe.load();
    // Mount only: later loads come from the poll below and the Refresh button,
    // and the probe objects are rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const anyMeasuring = probes.some((probe) => probe.measuring);

  usePolling(
    () => {
      for (const probe of probes) if (probe.loaded && probe.measuring) void probe.load();
    },
    MEASURING_POLL_MS,
    { enabled: anyMeasuring, immediate: false },
  );

  /** Asks for new measurements; ones already running are joined, not doubled. */
  const refresh = () => {
    setRequesting(true);
    return Promise.all([loadStats(true), ...probes.map((probe) => probe.load(true))]).finally(() =>
      setRequesting(false),
    );
  };

  return {
    stats,
    statsError,
    docker: docker.value,
    temp: temp.value,
    caches: caches.value,
    opencode: opencode.value,
    worktrees: worktrees.value,
    /** A refresh was just asked for, or any measurement is still running. */
    busy: requesting || anyMeasuring,
    refresh,
  };
}
