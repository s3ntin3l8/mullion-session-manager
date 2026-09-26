import { useEffect, useId, useRef } from "react";

// Android back / the back gesture used to close nothing on phone: every
// overlay (navigator, session/notification sheets, Settings, Tasks) is plain
// React state, and the browser had no history entry to pop, so back left the
// app. This gives each open phone overlay a slot in a small stack: back
// closes the topmost one.
//
// One shared history "guard" entry stands in for the whole stack, not one
// entry per overlay: push it when the first overlay opens, and on back pop
// only the topmost overlay (re-arming the guard if more remain). When the
// last overlay closes by any other route (its own ✕, picking a row) the
// guard is consumed with history.back() — deferred one tick so a hand-off
// (navigator closes as Settings opens) reuses the same entry instead of
// racing history.back() against the next pushState.
//
// Everything is inert unless `active` is true, and callers pass
// `isPhone && open`, so it never touches history on desktop/tablet; a tier
// change flips `active` off, which unregisters and consumes the guard.

interface Entry {
  id: string;
  close: () => void;
}

let stack: Entry[] = [];
let guardPushed = false;
// popstate events we caused ourselves (consuming the guard) and must not
// treat as the user pressing back.
let ignoredPops = 0;
let listening = false;

function ensureGuard(): void {
  if (guardPushed) return;
  window.history.pushState({ mullionPhoneOverlay: true }, "");
  guardPushed = true;
}

function onPopState(event: PopStateEvent): void {
  if (ignoredPops > 0) {
    ignoredPops -= 1;
    return;
  }
  // Landing ON the guard entry (a forward navigation, or external history
  // manipulation, onto one we'd already consumed) is not a back press: the
  // guard is simply present again, so reconcile instead of popping an overlay.
  if ((event.state as { mullionPhoneOverlay?: boolean } | null)?.mullionPhoneOverlay) {
    guardPushed = true;
    return;
  }
  // The browser already consumed the guard entry.
  guardPushed = false;
  const top = stack.pop();
  if (!top) return;
  if (stack.length > 0) ensureGuard();
  top.close();
}

function register(entry: Entry): void {
  if (!listening) {
    window.addEventListener("popstate", onPopState);
    listening = true;
  }
  stack.push(entry);
  ensureGuard();
}

function unregister(id: string): void {
  stack = stack.filter((entry) => entry.id !== id);
  if (stack.length > 0 || !guardPushed) return;
  setTimeout(() => {
    if (stack.length > 0 || !guardPushed) return;
    guardPushed = false;
    ignoredPops += 1;
    window.history.back();
  }, 0);
}

export function usePhoneBackStack(active: boolean, onClose: () => void): void {
  const id = useId();
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!active) return;
    register({ id, close: () => closeRef.current() });
    return () => unregister(id);
  }, [active, id]);
}

// Test-only: the stack is module state shared across the whole app.
export function resetPhoneBackStackForTests(): void {
  stack = [];
  guardPushed = false;
  ignoredPops = 0;
  if (listening) window.removeEventListener("popstate", onPopState);
  listening = false;
}
