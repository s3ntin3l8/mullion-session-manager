import { useEffect, useRef } from "react";
import type { DependencyList } from "react";

// Shared version of the `let cancelled = false` idiom hand-rolled at ~6
// plain "fetch once on mount / when deps change" effects across the
// frontend (GitHubPanel, CreateProjectModal, HostConfigModal, Sidebar's
// SessionFileDiff, SourceControlSection's ProjectFileDiff — see each call
// site for its own `onSuccess`/`onError` shape, which this hook
// deliberately leaves untouched rather than forcing a common `{data,
// error, loading}` shape that would collapse each site's actual
// differences).
//
// Deliberately NOT used for every `cancelled` site found in the frontend —
// a few have a genuinely different shape this hook would either distort or
// can't represent without losing behavior:
//  - SessionTimeline.tsx fires N independent per-session requests inside
//    one effect and applies each one's result as it resolves (its own doc
//    comment explains why: streaming updates, not a single batched result).
//    A single-`fetcher` hook would need `Promise.all` (delaying every
//    result to the slowest) to fit this shape — a real behavior change.
//  - AgentRulesPanel/SkillsPanel/DockConfigPanel, and GitPanel's own
//    `fetchStatus`/`refreshBranches`, wrap their fetch in a `useCallback`
//    taking an *optional* `cancelledRef` param specifically so mutation
//    handlers elsewhere in the same component can re-run the identical
//    fetch imperatively, without the cancellation guard that only makes
//    sense for the mount-effect caller. This hook owns its own fetcher
//    end-to-end; it has no way to also expose it for an unrelated
//    imperative call, so converting these would mean keeping the
//    hand-rolled callback anyway just to serve the second caller.
//
// `fetcher`/`onSuccess`/`onError`/`onStart` are all read through refs kept
// current every render (same technique `usePolling.ts` uses for `fn`), so
// callers can pass fresh inline closures each render without tearing down
// and re-running the effect — only `enabled` and `deps` do that.
export interface UseAsyncDataOptions {
  /** Whether the effect fetches at all. `false` short-circuits before
   * calling `fetcher`. Defaults to `true`. Included in the effect's own
   * restart trigger, same as `usePolling`'s `enabled`. */
  enabled?: boolean;
  /** Called synchronously, once, right before `fetcher()` — for a
   * caller that needs to reset its own state in lockstep with the fetch
   * starting (e.g. CreateProjectModal.tsx clearing a stale error from a
   * previous attempt before a retry). Only called when `enabled`. */
  onStart?: () => void;
}

export function useAsyncData<T>(
  fetcher: () => Promise<T>,
  onSuccess: (value: T) => void,
  onError: (error: unknown) => void,
  deps: DependencyList,
  options: UseAsyncDataOptions = {},
): void {
  const { enabled = true, onStart } = options;

  const fetcherRef = useRef(fetcher);
  const onSuccessRef = useRef(onSuccess);
  const onErrorRef = useRef(onError);
  const onStartRef = useRef(onStart);
  useEffect(() => {
    fetcherRef.current = fetcher;
    onSuccessRef.current = onSuccess;
    onErrorRef.current = onError;
    onStartRef.current = onStart;
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    onStartRef.current?.();
    fetcherRef
      .current()
      .then((value) => {
        if (!cancelled) onSuccessRef.current(value);
      })
      .catch((err: unknown) => {
        if (!cancelled) onErrorRef.current(err);
      });

    return () => {
      cancelled = true;
    };
    // `deps` is a caller-supplied dependency list, mirroring `useEffect`'s
    // own contract — same rationale as usePolling.ts's identical suppression.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
}
