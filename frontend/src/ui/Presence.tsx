import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { exitFinished } from "../lib/presence.js";
import { ParentPresenceContext } from "../hooks/usePresence.js";
import type { ParentPresence } from "../hooks/usePresence.js";

// #3037 — lets an overlay its parent mounts (a `Modal`, the command palette)
// leave the way it came when the PARENT closes it: a submit that succeeded, a
// palette command that ran, the global Escape. Without it the parent's
// `{open && <Modal/>}` unmounts the overlay in the same commit.
//
//   <Presence when={open}>
//     <CreateGroupModal onClose={() => setOpen(false)} … />
//   </Presence>
//
// While `when` is true, `children` render as given. When it turns false, the
// overlay stays mounted for its exit with the children it last had while open
// (a call site's `{x && <Dialog x={x}/>}` would render nothing by then), and
// it unmounts once its own animations have finished (lib/presence.ts). Under
// reduced motion, or where nothing animates (jsdom), it unmounts at once.
//
// The overlay reads the leaving state from context (`useParentPresence`) and
// puts it on its own root as `data-presence`, where styles/motion.css plays
// the exit; the closing state change itself, and whatever action caused it,
// is not delayed at all. Its own dismiss controls then call `onClose` at once
// and let this play the one exit. Reopening while it leaves mounts a fresh
// overlay rather than reviving the leaving one, whose form state is stale.
export function Presence({ when, children }: { when: boolean; children: ReactNode }) {
  const rootRef = useRef<Element | null>(null);
  // State derived from props during render (React's documented pattern):
  // the last open children, whether it is still mounted, and a generation
  // that a reopen bumps so the overlay mounts afresh.
  const [kept, setKept] = useState<ReactNode>(when ? children : null);
  const [present, setPresent] = useState(when);
  const [wasOpen, setWasOpen] = useState(when);
  const [generation, setGeneration] = useState(0);
  if (when !== wasOpen) {
    setWasOpen(when);
    if (when) {
      setGeneration((g) => g + 1);
      setPresent(true);
    }
  }
  if (when && kept !== children) setKept(children);
  const leaving = present && !when;

  useLayoutEffect(() => {
    if (!leaving) return;
    // Gone: the kept children (and the props they hold, such as a one-time
    // token) are released, as the parent's own state clear released them.
    const gone = () => {
      setPresent(false);
      setKept(null);
    };
    const done = exitFinished(rootRef.current);
    if (!done) {
      gone();
      return;
    }
    let live = true;
    void done.then(() => {
      if (live) gone();
    });
    return () => {
      live = false;
    };
  }, [leaving]);

  const register = useCallback((el: Element | null) => {
    rootRef.current = el;
    return () => {
      if (rootRef.current === el) rootRef.current = null;
    };
  }, []);
  const context = useMemo<ParentPresence>(() => ({ leaving, register }), [leaving, register]);

  if (!when && !present) return null;
  return (
    <ParentPresenceContext.Provider value={context}>
      <Fragment key={generation}>{when ? children : kept}</Fragment>
    </ParentPresenceContext.Provider>
  );
}
