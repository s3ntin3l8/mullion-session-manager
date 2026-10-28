import { useEffect, useRef, useState } from "react";
import { api } from "../api/index.js";
import type { OrphanRecoveryInfo, OrphanRemovalStatus } from "../api/index.js";
import { usePolling } from "../hooks/usePolling.js";
import { describeError } from "../lib/describeError.js";

/** The last server-side orphan removal survives a disconnected request or reload. */
export function useOrphanRemoval(
  onFinished: () => void,
  onRecoveries: (recoveries: OrphanRecoveryInfo[]) => void,
) {
  const [job, setJob] = useState<OrphanRemovalStatus>({ state: "idle" });
  const [warnings, setWarnings] = useState<string[]>([]);
  const [successId, setSuccessId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasRunning = useRef(false);
  const notified = useRef<string | null>(null);
  const latest = useRef(0);
  const finishedRef = useRef(onFinished);
  const recoveriesRef = useRef(onRecoveries);
  useEffect(() => {
    finishedRef.current = onFinished;
    recoveriesRef.current = onRecoveries;
  });
  const apply = (status: OrphanRemovalStatus) => {
    setJob(status);
    if (wasRunning.current && status.state === "idle") {
      setError("Removal was interrupted. Check the directory before trying again.");
      finishedRef.current();
    }
    if (status.state === "done" && notified.current !== status.id) {
      notified.current = status.id;
      if (status.result.removed) {
        let seen = false;
        try {
          seen = sessionStorage.getItem("mullion.orphan.lastSuccess") === status.id;
          sessionStorage.setItem("mullion.orphan.lastSuccess", status.id);
        } catch {
          /* The notice remains visible for this mount. */
        }
        if (!seen) setSuccessId(status.id);
      }
      finishedRef.current();
    }
    wasRunning.current = status.state === "running";
  };
  const load = (): Promise<OrphanRemovalStatus | null> => {
    const request = ++latest.current;
    return api.getOrphanRemoval().then(
      (snapshot) => {
        if (request !== latest.current) return null;
        setError(null);
        recoveriesRef.current(snapshot.recoveries);
        setWarnings(snapshot.warnings ?? []);
        apply(snapshot.job);
        return snapshot.job;
      },
      () => {
        if (request === latest.current)
          setError(
            "Could not read orphan removal status or recovery records. Refresh before trying again.",
          );
        return null;
      },
    );
  };
  useEffect(() => {
    void load();
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  usePolling(() => void load(), 2000, { enabled: job.state === "running", immediate: false });
  const start = async (projectId: number, path: string) => {
    setError(null);
    setStarting(true);
    setSuccessId(null);
    let previousId: string | null = null;
    let attempted = false;
    try {
      // A fresh baseline lets a lost POST response be distinguished from an
      // older completed job for the same path.
      const previous = await load();
      if (!previous) throw new Error("Could not check the current removal status.");
      if (previous.state === "running") return;
      previousId = previous.state === "idle" ? null : previous.id;
      const request = ++latest.current;
      attempted = true;
      const started = await api.removeOrphanWorktree(projectId, path);
      // A focus poll may have started before the POST reached the server.
      // The accepted response always wins, followed by a fresh status read.
      if (request !== latest.current) ++latest.current;
      apply(started);
      void load();
    } catch (cause) {
      // The request may have reached the server even if its response did not.
      const status = await load();
      if (
        !attempted ||
        !status ||
        status.state === "idle" ||
        status.id === previousId ||
        status.projectId !== projectId ||
        status.path !== path
      ) {
        setError(
          describeError(cause, "Could not confirm removal status; refresh before trying again."),
        );
      }
    } finally {
      setStarting(false);
    }
  };
  return {
    job,
    busy: starting || job.state === "running",
    error,
    warnings,
    showSuccess: job.state === "done" && job.id === successId,
    start,
  };
}
