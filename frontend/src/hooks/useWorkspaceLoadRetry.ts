/* eslint-disable react-hooks/exhaustive-deps -- dependency arrays are the
   original App.tsx arrays. Passed-in refs and useState setters are stable
   and were not listed there; adding them would not change when the effect
   runs. */
import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useDashboardStore } from "../store/index.js";

// Issue #1618 — bounded retry for the initial GET /api/workspaces: up to 5
// attempts, with backoff delays of 500ms, 1s, 2s and 4s between them (a new
// round starts on `online`/tab-visible after giving up).
export const WORKSPACE_LOAD_MAX_ATTEMPTS = 5;
export const WORKSPACE_LOAD_RETRY_BASE_MS = 500;

// Extracted from App.tsx (issue #2407). The hook is called at the effect's
// original position so its order among App's other effects is unchanged.
// The effect body, dependency array, and any eslint-disable inside it are
// the original text.

export interface UseWorkspaceLoadRetryParams {
  workspaceLoadNonce: number;
  setWorkspacesLoaded: Dispatch<SetStateAction<boolean>>;
  setWorkspaceLoadFailed: Dispatch<SetStateAction<boolean>>;
}

export function useWorkspaceLoadRetry({
  workspaceLoadNonce,
  setWorkspacesLoaded,
  setWorkspaceLoadFailed,
}: UseWorkspaceLoadRetryParams): void {
  // Load the workspace list once on mount, retrying a bounded number of
  // times with backoff (issue #1618) — a single failed fetch used to leave
  // workspacesLoaded false forever, with no active workspace and no autosave.
  // Giving up leaves workspacesLoaded false on purpose: flipping it with an
  // unknown (not genuinely empty) list would let the bootstrap in
  // useDefaultWorkspaceBootstrap.ts create a duplicate "Default". Instead,
  // giving up re-arms on the browser coming back online or the tab becoming
  // visible again, starting a fresh bounded round, so a transient outage can't
  // leave the app workspace-less for the rest of the session. A failed round
  // sets workspaceLoadFailed so the grid banner can offer Retry (issue #1638);
  // that bumps workspaceLoadNonce and this effect starts over. Success clears
  // the flag. workspacesLoaded still stays false until a round actually resolves.
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let rearmed = false;
    const rearm = () => {
      if (cancelled || !rearmed || document.visibilityState === "hidden") return;
      disarm();
      load(0);
    };
    const disarm = () => {
      rearmed = false;
      window.removeEventListener("online", rearm);
      document.removeEventListener("visibilitychange", rearm);
    };
    const load = (attempt: number) => {
      useDashboardStore
        .getState()
        .refreshWorkspaces()
        .then(
          () => {
            if (cancelled) return;
            setWorkspacesLoaded(true);
            setWorkspaceLoadFailed(false);
          },
          (err: unknown) => {
            if (cancelled) return;
            if (attempt + 1 >= WORKSPACE_LOAD_MAX_ATTEMPTS) {
              console.error("[workspace] failed to load workspaces, giving up", err);
              setWorkspaceLoadFailed(true);
              rearmed = true;
              window.addEventListener("online", rearm);
              document.addEventListener("visibilitychange", rearm);
              return;
            }
            retryTimer = setTimeout(
              () => load(attempt + 1),
              WORKSPACE_LOAD_RETRY_BASE_MS * 2 ** attempt,
            );
          },
        );
    };
    load(0);
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      disarm();
    };
  }, [workspaceLoadNonce]);
}
