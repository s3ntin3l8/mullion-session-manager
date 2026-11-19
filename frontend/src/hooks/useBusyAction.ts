import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Tracks a fire-and-forget request (a Refresh or a Retry) so its control can
 * show a pending state from the click until the request settles, and cannot be
 * double-fired meanwhile. `run` is a no-op while a call is in flight; errors
 * are the caller's to surface (the wrapped function owns its own error state),
 * so a rejection only ends the busy state.
 */
export function useBusyAction<A extends unknown[]>(
  fn: (...args: A) => unknown,
): {
  run: (...args: A) => void;
  busy: boolean;
} {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback((...args: A) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    new Promise<unknown>((resolve) => resolve(fnRef.current(...args)))
      .catch(() => undefined)
      .finally(() => {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      });
  }, []);
  return { run, busy };
}
