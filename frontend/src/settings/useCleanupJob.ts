import { useEffect, useRef, useState } from "react";
import { api, ApiError, RateLimitedError } from "../api/index.js";
import type { CleanupJob, DockerPruneMode } from "../api/index.js";
import { usePolling } from "../hooks/usePolling.js";

const RUNNING_POLL_MS = 2000;

/**
 * The server's one cleanup job. It runs on the server, so a reload (or another
 * tab) finds it exactly where it was: the status is read on mount, and polled
 * while it runs; an idle tab looks again when it regains focus.
 */
export function useCleanupJob(onFinished: () => void) {
  const [job, setJob] = useState<CleanupJob | null>(null);
  const [startingMode, setStartingMode] = useState<DockerPruneMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only a job seen running and then seen done counts as "just finished": one
  // that was already done when the page opened changed nothing.
  const wasRunning = useRef(false);
  // Read through a ref so a new callback each render never restarts the poll.
  const finishedRef = useRef(onFinished);
  useEffect(() => {
    finishedRef.current = onFinished;
  });

  const apply = (next: CleanupJob | null) => {
    setJob(next);
    const running = next?.state === "running";
    if (wasRunning.current && !running) {
      // Done, or gone: idle after running means the server restarted mid-job.
      // Either way the figures on screen are stale.
      if (next === null) {
        setError("The cleanup was interrupted (the server restarted). Check the figures below.");
      }
      finishedRef.current();
    }
    wasRunning.current = running;
  };

  const load = (onFail?: () => void) =>
    api.getCleanupStatus().then(
      (status) => apply(status.state === "idle" ? null : status),
      () => {
        // A missed poll keeps what is on screen; the next one catches up.
        onFail?.();
      },
    );

  useEffect(() => {
    void load();
    // A tab that sat idle while another one started the job never polls, so
    // look again whenever it is brought back.
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
    // Mount only: later reads come from the poll below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  usePolling(() => void load(), RUNNING_POLL_MS, {
    enabled: job?.state === "running",
    immediate: false,
  });

  const start = (mode: DockerPruneMode, cacheDirs: string[]) => {
    setError(null);
    setStartingMode(mode);
    return api
      .startCleanup(mode, cacheDirs)
      .then(apply, (cause: unknown) => {
        // 409: another tab (or an earlier click) already started one. Join it.
        if (cause instanceof ApiError && cause.statusCode === 409) {
          return load(() =>
            setError("A cleanup is already running, but its progress could not be read."),
          );
        }
        if (cause instanceof RateLimitedError) {
          setError(
            `Too many cleanup requests. Try again in ${Math.max(1, Math.ceil(cause.retryAfterMs / 1000))} s.`,
          );
          return;
        }
        setError(cause instanceof ApiError ? cause.message : "Could not start the cleanup.");
      })
      .finally(() => setStartingMode(null));
  };

  // The tier being cleaned right now, from the click until the job is done.
  const activeMode = startingMode ?? (job?.state === "running" ? job.mode : null);

  return { job, activeMode, running: activeMode !== null, error, start };
}
