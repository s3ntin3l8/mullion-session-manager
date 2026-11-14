import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useDashboardStore } from "../store/index.js";
import { themeClassName } from "../store/theme.js";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
import { usePhoneBackStack } from "../hooks/usePhoneBackStack.js";
import { CloseIcon } from "./icons.js";
import { MOTION_EASE, MOTION_FADE_MS, prefersReducedMotion } from "../lib/motion.js";
import {
  Spring,
  addPointerSample,
  projectRest,
  releaseVelocity,
  rubberBand,
} from "../lib/spring.js";
import type { PointerSample } from "../lib/spring.js";

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

  const { present, backdropRef, onDragStart, onDragMove, onDragEnd } = useSheetMotion(
    open,
    sheetRef,
    onClose,
  );

  if (!open && !present) return null;

  const backdropClass = [
    portal ? themeClassName(theme) : null,
    "mobile-session-backdrop",
    backdropClassName ?? null,
  ]
    .filter(Boolean)
    .join(" ");
  const sheetClass = ["mobile-session-sheet", sheetClassName ?? null].filter(Boolean).join(" ");

  const content = (
    <div
      ref={backdropRef}
      className={backdropClass}
      // Leaving: still on screen while it travels out, but no longer a dialog
      // anyone can reach. `open` is already false, so the focus trap and the
      // back-stack entry are gone; this keeps a stray tap or a screen reader
      // from landing on a sheet that is on its way out.
      inert={!open}
      aria-hidden={open ? undefined : true}
      style={open ? undefined : { pointerEvents: "none" }}
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
        <div
          className="mobile-session-sheet-header"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        >
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

// Issue #3008 — the sheet's motion (docs/motion.md). It enters from the bottom
// edge it belongs to on the house spring, leaves the same way, and follows a
// finger on its header: a drag can be thrown down to dismiss, caught mid-way,
// or let go to spring back. Every change of direction (a reopen while it is
// leaving, a grab while it is arriving) continues from the spring's current
// position and speed.
//
// The travel is the distance from the sheet's top edge to the bottom of the
// backdrop, measured on every open and close. Where there is no layout to
// measure (jsdom), the travel is 0 and every run is already at rest, so the
// sheet opens and closes synchronously, exactly as it did before it moved.
//
// Under reduced motion the spring jumps (lib/spring.ts decides that, through
// lib/motion.ts) and the sheet fades in and out instead, with the Web
// Animations API: tokens.css's reduced-motion reset zeroes CSS transitions and
// animations, but not these.
const INTERACTIVE = "button, a, input, select, textarea, [role='button']";

interface DragState {
  pointerId: number;
  // clientY minus the sheet's offset when the finger went down.
  origin: number;
  samples: PointerSample[];
  // Whether the finger has moved since it went down. A tap is not a drag.
  moved: boolean;
}

function useSheetMotion(
  open: boolean,
  sheetRef: RefObject<HTMLDivElement | null>,
  onClose: () => void,
) {
  const backdropRef = useRef<HTMLDivElement>(null);
  // Mounted: open, or still leaving. Set during render on open (React's
  // documented pattern for state derived from a prop change), cleared when
  // the exit comes to rest.
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);

  const springRef = useRef<Spring | null>(null);
  const travelRef = useRef(0);
  // Whether the sheet has entered since it was last fully gone: decides
  // between entering from the edge and reversing a sheet that is leaving.
  const shownRef = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const fadeRef = useRef<Animation | null>(null);

  const measureTravel = () => {
    const backdrop = backdropRef.current;
    const sheet = sheetRef.current;
    if (!backdrop || !sheet) return 0;
    return Math.max(0, backdrop.clientHeight - sheet.offsetTop);
  };

  const getSpring = () => {
    springRef.current ??= new Spring({
      onUpdate: (offset) => {
        const sheet = sheetRef.current;
        const backdrop = backdropRef.current;
        // At rest the inline styles are removed again, so a resting sheet is
        // exactly the element its callers and their CSS know.
        if (sheet) sheet.style.transform = offset ? `translateY(${offset}px)` : "";
        if (backdrop) {
          const travel = travelRef.current;
          backdrop.style.opacity =
            offset > 0 && travel > 0 ? String(Math.max(0, 1 - offset / travel)) : "";
        }
      },
    });
    return springRef.current;
  };

  const fade = (from: number, to: number, onFinish?: () => void): boolean => {
    const backdrop = backdropRef.current;
    if (!backdrop || typeof backdrop.animate !== "function") return false;
    fadeRef.current?.cancel();
    const animation = backdrop.animate([{ opacity: from }, { opacity: to }], {
      duration: MOTION_FADE_MS,
      easing: MOTION_EASE,
      // A fade-out holds its end state: without it the sheet is back at full
      // opacity for the frame between the finish and React's unmount.
      fill: to === 0 ? "forwards" : "none",
    });
    fadeRef.current = animation;
    animation.onfinish = () => {
      fadeRef.current = null;
      onFinish?.();
    };
    return true;
  };

  useLayoutEffect(() => {
    if (!present) return;
    const spring = getSpring();
    const travel = measureTravel();
    travelRef.current = travel;
    const gone = () => {
      shownRef.current = false;
      setPresent(false);
    };
    if (open) {
      fadeRef.current?.cancel();
      fadeRef.current = null;
      if (!shownRef.current) {
        shownRef.current = true;
        // Enters from the edge it belongs to.
        spring.jump(travel);
        if (prefersReducedMotion()) fade(0, 1);
      }
      spring.to(0);
      return;
    }
    dragRef.current = null;
    if (prefersReducedMotion()) {
      spring.stop();
      if (!fade(1, 0, gone)) gone();
      return;
    }
    // Leaves the way it came, carrying whatever speed it had (a throw).
    spring.to(travel, { onRest: gone });
    // getSpring/measureTravel only read refs; the effect is keyed on the two
    // values that decide where the sheet should be.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, present]);

  useEffect(
    () => () => {
      springRef.current?.stop();
      fadeRef.current?.cancel();
    },
    [],
  );

  const onDragStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!open || dragRef.current) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest(INTERACTIVE)) return;
    // Not every environment has pointer capture (jsdom), and a browser throws
    // for a pointer that is already gone; the drag works without it, only
    // less reliably once the finger leaves the header.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* see above */
    }
    const spring = getSpring();
    // Caught mid-flight: it stops under the finger.
    spring.stop();
    travelRef.current = measureTravel();
    dragRef.current = {
      pointerId: e.pointerId,
      origin: e.clientY - spring.value,
      samples: [{ position: e.clientY, time: e.timeStamp }],
      moved: false,
    };
  };

  const onDragMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.moved) {
      // Until the first move the only sample is where the finger went down.
      if (e.clientY === drag.samples[0].position) return;
      drag.moved = true;
    }
    const offset = e.clientY - drag.origin;
    // Down it tracks the finger 1:1; up, past its resting place, it resists.
    getSpring().jump(offset < 0 ? rubberBand(offset) : offset);
    drag.samples = addPointerSample(drag.samples, { position: e.clientY, time: e.timeStamp });
  };

  const onDragEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    const spring = getSpring();
    const velocity = e.type === "pointercancel" ? 0 : releaseVelocity(drag.samples, e.timeStamp);
    const travel = travelRef.current;
    // Decided by where the throw is heading, not where the finger lifted. A
    // tap that never moved is not a drag: a sheet caught while still
    // arriving (most of its travel away) just carries on arriving.
    const dismiss = drag.moved && travel > 0 && projectRest(spring.value, velocity) > travel / 2;
    // Under reduced motion the spring would jump back to 0 before the fade
    // out; the sheet fades from where the finger left it instead.
    if (dismiss && prefersReducedMotion()) {
      onClose();
      return;
    }
    // Hands the finger's speed to the spring either way. On a dismiss the
    // close re-targets it to the edge before the next frame, so the throw
    // carries on out; if the caller keeps the sheet open, it springs back.
    spring.to(0, { velocity });
    if (dismiss) onClose();
  };

  return { present, backdropRef, onDragStart, onDragMove, onDragEnd };
}
