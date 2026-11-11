/* eslint-disable react-hooks/exhaustive-deps -- dependency arrays are the
   original App.tsx arrays. Passed-in refs and useState setters are stable
   and were not listed there; adding them would not change when the effect
   runs. */
import { useEffect } from "react";
import type { RefObject } from "react";
import type { AppSettings } from "../api/index.js";
import { ensurePushSubscribed } from "../pushClient.js";

// Extracted from App.tsx (issue #2407). The hook is called at the effect's
// original position so its order among App's other effects is unchanged.
// The effect body, dependency array, and any eslint-disable inside it are
// the original text.

export interface UsePushResyncParams {
  pushResyncAttemptedRef: RefObject<boolean>;
  settingsLoaded: boolean;
  settings: AppSettings;
}

export function usePushResync({
  pushResyncAttemptedRef,
  settingsLoaded,
  settings,
}: UsePushResyncParams): void {
  // Issue #95 — re-syncs a push subscription on load (settings.notifications
  // .channels.push is the source of truth, not the presence of a live
  // browser subscription) so a subscription lost to a pushsubscriptionchange
  // the service worker missed, or to the browser clearing site data, gets
  // recreated without the user having to notice and re-toggle it. Gated on
  // settingsLoaded so this never fires against store.ts's synchronous
  // pre-hydration default (channels.push always false there).
  // ensurePushSubscribed itself never prompts for permission — see its own
  // doc comment.
  //
  // pushResyncAttemptedRef makes this run at most once per page load —
  // this effect's job is app-load recovery only, not the toggle path,
  // which stays Settings.tsx's alone. It does NOT by itself prevent a
  // concurrent duplicate run (Hermes review, sixth pass — an earlier
  // version of this comment overstated that): on a first-time toggle-on
  // (channels.push starts false, so this ref was never set), flipping the
  // switch in Settings still re-fires this effect at the same moment
  // Settings.tsx calls its own enablePush() — the ref only stops it from
  // firing a SECOND time after that. What actually makes the resulting
  // overlap harmless is pushClient.ts's module-level subscribeInFlight
  // guard, which both call sites route through regardless of which
  // component triggered them.

  useEffect(() => {
    if (pushResyncAttemptedRef.current) return;
    if (settingsLoaded && settings.notifications.channels.push) {
      pushResyncAttemptedRef.current = true;
      void ensurePushSubscribed();
    }
  }, [settingsLoaded, settings.notifications.channels.push]);
}
