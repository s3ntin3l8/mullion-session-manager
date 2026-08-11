import { useEffect, useRef } from "react";
import type { RefObject, KeyboardEvent as ReactKeyboardEvent } from "react";

// P11 — shared focus-management primitive for modals/popovers/menus,
// extracted from UnifiedBoard.tsx's task-detail drawer (the one place in the
// app that got this right before this PR — see that component's own doc
// comments on `lastFocusedRef`/`onDrawerKeyDown` for the underlying
// rationale this restates in reusable form):
//  - focus moves into the container the moment it becomes active
//    (`initialFocusRef` if given, else the first focusable descendant)
//  - Tab/Shift+Tab wraps at the container's boundary instead of escaping
//    into the page behind it
//  - focus is restored to whatever was focused right before the container
//    became active, captured inside this hook's own effect. UnifiedBoard's
//    drawer captures at the click site instead, specifically because
//    `detailTaskId` can go directly from one non-null value to a different
//    one without unmounting in between (switching tasks), which would make
//    an effect-time capture read focus the OUTGOING effect's own cleanup
//    just moved to. None of this hook's four call sites (Settings,
//    CommandPalette — fresh mount per open; NotificationBell's popover,
//    PaneTab's menu — a plain boolean toggle) have that shape, so capturing
//    here, at activation, is equivalent and keeps every call site from
//    having to plumb its own "capture before opening" wiring.
//
// Escape is deliberately NOT handled here. UnifiedBoard's own drawer scopes
// Escape to itself via onKeyDown specifically so a window-level listener
// doesn't also catch a keypress meant for some OTHER overlay sitting above
// it — and this repo's four call sites already have three different Escape
// owners (Settings/CommandPalette close via App.tsx's `handleGlobalEscape`;
// PaneTab's menu and NotificationBell's popover own it locally, wired
// alongside this hook's own `onKeyDown` at each call site). Folding one
// Escape policy into this hook would fight whichever of those a given
// caller already has.
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// jsdom (this repo's test environment) always reports 0 for offsetWidth/
// Height and an empty DOMRect from getClientRects(), so neither can be used
// to filter hidden elements without breaking every test that exercises this
// hook. `aria-hidden` ancestry is jsdom-safe AND is exactly how
// CommandPalette.tsx already marks its own conditionally-hidden
// skip-permissions block (`visibility: hidden` + `aria-hidden` on the same
// wrapper) — without this check the Tab trap could focus a checkbox that's
// invisible on screen, a real focus black hole for a keyboard user.
function isAriaHidden(el: Element): boolean {
  return el.closest('[aria-hidden="true"]') !== null;
}

// Hermes review, PR #621 round 3 — a CSS-`display: none` ancestor (not just
// `aria-hidden`) also needs filtering out: Settings.tsx's mobile drill-down
// keeps both its nav and content panes mounted at all times, toggling which
// one is `display: none` purely via CSS class (no unmount), same for its
// back button outside the mobile breakpoint. Without this, `getFocusable()`
// could return a hidden element as `focusable[0]`/`focusable[last]` — Tab's
// wrap-around check (`document.activeElement === first/last`, below) can
// never match a hidden element (a browser refuses to actually focus one), so
// the trap silently stops wrapping and focus leaks out of the dialog instead
// — a real bug, but not `offsetWidth`/`getClientRects`-detectable (see the
// note above), so `getComputedStyle` instead, walking ancestors the same way
// `isAriaHidden` walks for `aria-hidden` — a `display: none` ancestor hides
// this element just as much as one on the element itself. jsdom's
// `getComputedStyle` reads inline styles and its own default per-tag UA
// stylesheet correctly (it just can't do real *layout*, which is what
// `offsetWidth` needs) — jsdom-safe, unlike the layout-dependent checks.
function isDisplayNone(el: Element): boolean {
  let node: Element | null = el;
  while (node) {
    if (window.getComputedStyle(node).display === "none") return true;
    node = node.parentElement;
  }
  return false;
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !isAriaHidden(el) && !isDisplayNone(el),
  );
}

export function useFocusTrap({
  active,
  containerRef,
  initialFocusRef,
}: {
  active: boolean;
  containerRef: RefObject<HTMLElement | null>;
  // Defaults to the first focusable descendant of the container — pass this
  // when the caller wants something more specific (e.g. CommandPalette's
  // search input, which already anchors typing/arrow-key navigation).
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  // Set by a call-site action that closes the overlay by ALSO moving focus
  // somewhere else on purpose (e.g. CommandPalette launching a session and
  // focusing its new pane's terminal, or NotificationBell's EventRow opening
  // a session/timeline). Without this, the restore-on-close cleanup below
  // would win the race and snap focus back to the trigger button right after
  // whatever was just opened asked for it — exactly the bug PR13's terminal-
  // focus fix (U7) exists to prevent. Callers call `suppressRestore()`
  // (returned below) immediately before the state change that closes them.
  const suppressRestoreRef = useRef(false);

  useEffect(() => {
    if (!active) return;
    lastFocusedRef.current = document.activeElement as HTMLElement | null;
    suppressRestoreRef.current = false;
    const toFocus =
      initialFocusRef?.current ?? (containerRef.current && getFocusable(containerRef.current)[0]);
    toFocus?.focus();
    return () => {
      if (suppressRestoreRef.current) return;
      if (lastFocusedRef.current?.isConnected) {
        lastFocusedRef.current.focus();
      }
    };
    // Deliberately only [active] — re-running this on every render (e.g. a
    // re-created initialFocusRef object) would re-focus the container on
    // every unrelated re-render while it's already open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== "Tab" || !containerRef.current) return;
    const focusable = getFocusable(containerRef.current);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return {
    onKeyDown,
    suppressRestore: () => {
      suppressRestoreRef.current = true;
    },
  };
}
