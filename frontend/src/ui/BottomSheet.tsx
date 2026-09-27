import { useEffect, useRef } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MutableRefObject,
  ReactNode,
  RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useDashboardStore } from "../store/index.js";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
import { usePhoneBackStack } from "../hooks/usePhoneBackStack.js";
import { CloseIcon } from "./icons.js";

// Issue #1435 — MobileSessionSwitcher, CopyModeSheet, the NotificationBell
// phone branch, and the TasksToolbar phone filter sheet each hand-rolled the
// same recipe: a `.mobile-session-backdrop`/`.mobile-session-sheet` shell
// (portal, `cmux-root`/theme wrapper, `useFocusTrap`, Escape-to-close,
// backdrop-tap-to-close, a header with a close button, `usePhoneBackStack`).
// `CopyModeSheet` had drifted into its own byte-for-byte-duplicate
// `.copy-mode-*` CSS family rather than sharing `.mobile-session-*` at all.
// This is that shell, extracted once a third sheet (the notifications one)
// made the duplication a real pattern rather than a coincidence. Every
// difference between the four existing sheets becomes a prop here, not
// something silently unified away — see each prop's own comment.
//
// Modeled on `ui/Modal.tsx`'s own composition of `useFocusTrap` (that
// component's header comment covers why Escape is this component's own job,
// not that hook's), but Modal's callers are all fresh-mount-per-open (no
// `open` prop at all); every caller here instead keeps its trigger mounted
// and just toggles this component's `open`, so — like the sheets it
// replaces — this stays mounted for its parent's whole lifetime and
// internally renders nothing while closed. `useFocusTrap`/`usePhoneBackStack`
// are called unconditionally on every render (gated internally by `open`/
// `backStack`), exactly the shape those hooks are documented against — so a
// caller whose OWN `phone` prop can flip at runtime (NotificationBell) sees
// this component mount/unmount as a normal child, not a conditional hook
// call; `usePhoneBackStack`'s unregister-on-cleanup fires either way.
export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  // aria-label for the dialog itself.
  label: string;
  // aria-label for the built-in close button — varies per sheet ("Close
  // session list", "Close copy view", "Close notifications", "Close
  // filters"), so callers own the exact wording rather than this component
  // guessing one from `label`.
  closeLabel: string;
  // Left side of the header.
  title: ReactNode;
  // Rendered between the title and the close button, inside the same
  // right-aligned flex group as the close button (not a sibling of it) —
  // load-bearing for the notifications sheet's "Read all" button: with
  // `.mobile-session-sheet-header`'s own `justify-content: space-between`,
  // an ungrouped 3rd flex item would drift to the header's midpoint instead
  // of sitting flush against the close button. The other three sheets pass
  // nothing here, so the group holds only the close button — cosmetically
  // identical to it being the header's sole trailing child.
  headerActions?: ReactNode;
  children: ReactNode;
  // Extra class(es) alongside the shared `.mobile-session-backdrop` base —
  // lets a caller keep its own pre-existing selector (CopyModeSheet's own
  // tests query `.copy-mode-backdrop` directly) without duplicating the
  // shared rules a second time.
  backdropClassName?: string;
  // Extra class(es) alongside the shared `.mobile-session-sheet` base — how
  // each caller supplies its own height variant (`.mobile-notif-sheet`,
  // `.tasks-phone-filter-sheet`, `.copy-mode-sheet`) without duplicating the
  // shared shell rules a second time.
  sheetClassName?: string;
  // "click" (default): any click landing on the backdrop closes, the same
  // as every sheet except CopyModeSheet — the sheet's own `stopPropagation`
  // is what keeps an inside click from ever reaching it.
  // "press-release": CopyModeSheet's own variant — closes only when BOTH a
  // pointerdown AND the resulting click land on the backdrop itself, so a
  // text-selection drag that starts inside the sheet and ends on the
  // backdrop doesn't close it.
  backdropClose?: "click" | "press-release";
  // Portals to `document.body` by default, and — since a portaled sheet
  // renders outside the app's own themed subtree — wraps itself in
  // `cmux-root`/`.light` to carry the current theme along. The Tasks phone
  // filter sheet passes `false`: it lives inside `.kanban-board-overlay`
  // (dockview-container's own isolated stacking context, z-index 100), and
  // a body-portaled z-55 backdrop wouldn't reliably stack above that — see
  // that overlay's own CSS comment. Already inside the app's themed
  // subtree, it also needs no theme wrapper of its own.
  portal?: boolean;
  // Opt-in `usePhoneBackStack` registration — every caller passes `true`
  // except CopyModeSheet, which doesn't register today; adding it here
  // unconditionally would be a behavior change this extraction isn't
  // making.
  backStack?: boolean;
  // Run before the default Escape-closes-the-sheet behavior. Returning
  // `true` means "handled, don't also close" — MobileSessionSwitcher's own
  // two-step Escape (cancel an in-flight rename first; only a SECOND Escape
  // closes the sheet). Every other caller has nothing to intercept and
  // omits this, getting the default straight-to-close behavior.
  onEscape?: () => boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  // Lets a caller reach the sheet's own DOM node for something this
  // component doesn't otherwise do — MobileSessionSwitcher scrolls its
  // active row into view and refocuses it after a rename ends;
  // NotificationBell shares one `panelRef` across both its phone and
  // desktop panels for a single outside-click effect. Defaults to an
  // internal ref when the caller doesn't need external access.
  sheetRef?: RefObject<HTMLDivElement | null>;
  // Exposes this instance's own `useFocusTrap` `suppressRestore` to the
  // caller, via a ref rather than a callback prop (writing to a ref during
  // render is fine; calling a prop function during render isn't). Needed
  // only by a caller whose own action both closes this sheet AND
  // intentionally moves focus elsewhere (NotificationBell's row tap, which
  // opens a session's terminal) — without it, this trap's own
  // restore-on-close would win that race and snap focus back to the
  // trigger button right after. See useFocusTrap.ts's own doc comment
  // (issue U7) for why suppressRestore exists at all.
  suppressRestoreRef?: MutableRefObject<(() => void) | null>;
}

export function BottomSheet({
  open,
  onClose,
  label,
  closeLabel,
  title,
  headerActions,
  children,
  backdropClassName,
  sheetClassName,
  backdropClose = "click",
  portal = true,
  backStack = false,
  onEscape,
  initialFocusRef,
  sheetRef: sheetRefProp,
  suppressRestoreRef,
}: BottomSheetProps) {
  const theme = useDashboardStore((s) => s.theme);
  const internalSheetRef = useRef<HTMLDivElement>(null);
  const sheetRef = sheetRefProp ?? internalSheetRef;
  // "press-release" only — tracks whether the pointerdown that STARTED this
  // click also landed on the backdrop itself, same as CopyModeSheet's own
  // `pressedBackdropRef` before this extraction.
  const pressedBackdropRef = useRef(false);

  usePhoneBackStack(backStack && open, onClose);

  const { onKeyDown: onTrapKeyDown, suppressRestore } = useFocusTrap({
    active: open,
    containerRef: sheetRef,
    initialFocusRef,
  });
  // A ref write, not state — deliberately in an effect rather than inline
  // during render (a bare `if (...) ref.current = ...` here is flagged by
  // this repo's react-hooks/refs rule: "Cannot access refs during render").
  // `suppressRestore` is a fresh closure every render (useFocusTrap doesn't
  // memoize it), so this re-runs every render, which is exactly what keeps
  // the ref current — a caller only ever reads it later, from an event
  // handler, never during this same render.
  useEffect(() => {
    if (suppressRestoreRef) suppressRestoreRef.current = suppressRestore;
  }, [suppressRestoreRef, suppressRestore]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (!onEscape?.()) onClose();
      return;
    }
    onTrapKeyDown(e);
  };

  if (!open) return null;

  const backdropClass = [
    portal ? `cmux-root${theme === "light" ? " light" : ""}` : null,
    "mobile-session-backdrop",
    backdropClassName ?? null,
  ]
    .filter(Boolean)
    .join(" ");
  const sheetClass = ["mobile-session-sheet", sheetClassName ?? null].filter(Boolean).join(" ");

  const content = (
    <div
      className={backdropClass}
      onPointerDown={
        backdropClose === "press-release"
          ? (e) => {
              pressedBackdropRef.current = e.target === e.currentTarget;
            }
          : undefined
      }
      onClick={(e) => {
        if (backdropClose === "press-release") {
          if (pressedBackdropRef.current && e.target === e.currentTarget) onClose();
          pressedBackdropRef.current = false;
        } else {
          onClose();
        }
      }}
    >
      <div
        ref={sheetRef}
        className={sheetClass}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="mobile-session-sheet-header">
          <span>{title}</span>
          <span className="mobile-session-sheet-header-actions">
            {headerActions}
            <button className="mobile-tab-btn" aria-label={closeLabel} onClick={onClose}>
              <CloseIcon size={14} />
            </button>
          </span>
        </div>
        {children}
      </div>
    </div>
  );

  return portal ? createPortal(content, document.body) : content;
}
