import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { canPlayExit, exitFinished } from "../lib/presence.js";
import type { PresenceState } from "../lib/presence.js";

// The two shapes an overlay comes in, one hook each, both built on
// lib/presence.ts (which explains why the wait is on the animations
// themselves, and when there is nothing to wait for).

/**
 * For an overlay that owns its `open` state (a menu, a popover): keeps it
 * mounted while it leaves. Render while `present`, put `state` on the
 * overlay's root as `data-presence`, and point `ref` at that root.
 *
 * A reopen while it is leaving turns the same element back (`state` returns
 * to "open"), rather than unmounting and mounting a new one.
 */
export function usePresence(
  open: boolean,
  ref: RefObject<Element | null>,
): { present: boolean; state: PresenceState } {
  // Set during render on open (React's documented pattern for state derived
  // from a prop change), cleared when the exit has played. The same shape as
  // BottomSheet's own `present`.
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);
  const leaving = present && !open;

  useLayoutEffect(() => {
    if (!leaving) return;
    const done = exitFinished(ref.current);
    if (!done) {
      setPresent(false);
      return;
    }
    let live = true;
    void done.then(() => {
      if (live) setPresent(false);
    });
    return () => {
      live = false;
    };
    // `ref` is a stable ref object; the effect is keyed on the leaving state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving]);

  return { present: open || present, state: leaving ? "leaving" : "open" };
}

/**
 * For an overlay its parent mounts and unmounts (a `{open && <Modal/>}` call
 * site): the overlay's own dismiss controls (Escape, the backdrop, its close
 * button) call `dismiss`, which plays the exit and only then calls `onClose`,
 * so the parent unmounts an overlay that has already gone.
 *
 * A close the parent makes on its own (a submit that succeeded, a command
 * that ran) still unmounts at once: the overlay never hears about it.
 *
 * If the parent keeps the overlay after `onClose` (a dialog that refuses to
 * close while something is in flight), it comes back.
 */
export function useDismissExit(
  onClose: () => void,
  ref: RefObject<Element | null>,
): { state: PresenceState; dismiss: () => void } {
  const [leaving, setLeaving] = useState(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const dismiss = useCallback(() => {
    if (!canPlayExit()) {
      onCloseRef.current();
      return;
    }
    setLeaving(true);
  }, []);

  useLayoutEffect(() => {
    if (!leaving) return;
    let live = true;
    const finish = () => {
      if (!live) return;
      setLeaving(false);
      onCloseRef.current();
    };
    const done = exitFinished(ref.current);
    if (!done) finish();
    else void done.then(finish);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving]);

  return { state: leaving ? "leaving" : "open", dismiss };
}
