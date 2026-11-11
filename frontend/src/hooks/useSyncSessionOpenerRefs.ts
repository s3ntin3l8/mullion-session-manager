/* eslint-disable react-hooks/exhaustive-deps -- dependency arrays are the
   original App.tsx arrays. Passed-in refs and useState setters are stable
   and were not listed there; adding them would not change when the effect
   runs. */
import { useEffect } from "react";
import type { RefObject } from "react";
import type { Session } from "../api/index.js";

// Extracted from App.tsx (issue #2407) — mirrors `sessions` and
// `onOpenSession` into refs so the push-notification listener
// (usePushSessionOpen, called immediately after this hook) is not torn
// down on every live-refresh tick. Called at the effect's original
// position, which is before usePushSessionOpen. Body and dependency
// array are unchanged.

export interface UseSyncSessionOpenerRefsParams {
  sessionsRef: RefObject<Session[]>;
  onOpenSessionRef: RefObject<(session: Session) => void>;
  sessions: Session[];
  onOpenSession: (session: Session) => void;
}

export function useSyncSessionOpenerRefs({
  sessionsRef,
  onOpenSessionRef,
  sessions,
  onOpenSession,
}: UseSyncSessionOpenerRefsParams): void {
  useEffect(() => {
    sessionsRef.current = sessions;
    onOpenSessionRef.current = onOpenSession;
  }, [sessions, onOpenSession]);
}
