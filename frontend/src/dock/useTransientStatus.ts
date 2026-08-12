import { useEffect, useRef, useState } from "react";

// Transient, human-readable outcome of the LAST docker action click
// (control id -> message), auto-cleared after `clearMs` — extracted from
// DockColumn (Wave 5 / PR 28 of .claude/plans/can-we-do-a-warm-cocke.md).
// Issue #73 Hermes review: a `reason: "pull-failed"` (private registry,
// network failure, the 45s pull timeout) result was stored but never
// surfaced anywhere, since the image pill only ever reacts to
// `updateAvailable`. Without this, a failed or merely up-to-date check
// reads as "nothing happened" after a real (and, before the timeout
// reduction, up to 120s-long) network round trip.
export function useTransientStatus(clearMs: number) {
  const [statusById, setStatusById] = useState<
    Record<string, { message: string; isError: boolean }>
  >({});
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(
    () => () => {
      for (const timer of Object.values(timersRef.current)) clearTimeout(timer);
    },
    [],
  );

  const show = (id: string, message: string, isError = false) => {
    setStatusById((prev) => ({ ...prev, [id]: { message, isError } }));
    const existing = timersRef.current[id];
    if (existing) clearTimeout(existing);
    timersRef.current[id] = setTimeout(() => {
      setStatusById((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      delete timersRef.current[id];
    }, clearMs);
  };

  return { statusById, show };
}
