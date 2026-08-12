import { useEffect, useRef, useState } from "react";

// U8 — arm-then-confirm before a running monitor's header click actually
// kills it, extracted from DockColumn (Wave 5 / PR 28 of
// .claude/plans/can-we-do-a-warm-cocke.md). Not the shared <ConfirmButton>
// component: that renders a <button>, and a dock monitor's header already
// hosts other real interactive elements (the worktree <select>, the docker
// kebab menu) that would become an illegal button-inside-button nest if the
// whole header were one. This mirrors DockColumn's own former
// `checkStatusById`/`checkStatusTimersRef` idiom (now dock/useTransientStatus.ts)
// instead — a per-id armed set plus a per-id disarm timer — rather than
// either inventing a third shape or forcing every control in a column to
// share one armed slot (which would silently disarm a SECOND monitor's
// confirm step the instant a first one gets armed).
export function useArmedKill(disarmMs: number) {
  const [armedIds, setArmedIds] = useState<Set<string>>(new Set());
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(
    () => () => {
      for (const timer of Object.values(timersRef.current)) clearTimeout(timer);
    },
    [],
  );

  const arm = (id: string) => {
    setArmedIds((prev) => new Set(prev).add(id));
    const existing = timersRef.current[id];
    if (existing) clearTimeout(existing);
    timersRef.current[id] = setTimeout(() => {
      setArmedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      delete timersRef.current[id];
    }, disarmMs);
  };

  const disarm = (id: string) => {
    const existing = timersRef.current[id];
    if (existing) {
      clearTimeout(existing);
      delete timersRef.current[id];
    }
    setArmedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  return { armedIds, arm, disarm };
}
