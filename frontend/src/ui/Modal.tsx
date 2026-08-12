import { useRef } from "react";
import type { ReactNode, RefObject, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useFocusTrap } from "../useFocusTrap.js";
import { CloseIcon } from "../icons.js";

// PR 24 pilot — the shared shell behind the `create-modal-*` family
// (`CreateGroupModal`, `CreateProjectModal`, `CreateHostModal`,
// `HostConfigModal`, `GitHubDeviceFlowModal`, `PromoteDialog`; `SavedUrlModal`
// hand-rolls a different class family entirely, hence `backdropClassName`/
// `modalClassName` below rather than hardcoding `create-modal-*`). Every one
// of those seven hand-rolls the same backdrop + `stopPropagation` + close
// button, and none has `role="dialog"`, `aria-modal`, a focus trap, or
// Escape-to-close — see the roadmap's PR 24 entry. This component is the
// fix, piloted here on `PromoteDialog` only; the other six migrate in
// follow-up PRs once this shape is validated.
//
// Composes the existing `useFocusTrap` hook rather than reimplementing any
// of its focus-in/Tab-wrap/restore-on-close behavior — see that hook's own
// header comment for why Escape is deliberately NOT its job: this repo's
// four pre-existing call sites each own Escape locally (or via App.tsx's
// `handleGlobalEscape`) because a global listener would steal a keypress
// meant for whichever OTHER overlay is topmost. `create-modal-*` dialogs are
// simpler — none of the seven ever stacks under another overlay — so Modal
// owns Escape directly, scoped to its own `onKeyDown` (not a window
// listener) for the same "don't leak past this dialog" reasoning.
//
// `active: true` for the whole component lifetime, not a toggleable prop:
// every one of the seven target modals is a fresh mount per open (an `{open
// && <XModal .../>}` conditional at the call site, never a persistently
// mounted "hidden" instance) — the same shape `useFocusTrap`'s own
// Settings.tsx/CommandPalette call sites document as its `active: true`
// case, and the same reason a `SetActive`-style prop would be dead weight
// here.
//
// A caller that opens this from inside another focus-trapped overlay (e.g.
// `PromoteDialog`'s two triggers: `PaneActionsMenu`'s kebab menu and
// `Sidebar`'s `KebabMenu`) must make sure that overlay's own trap doesn't
// restore focus to its trigger button AFTER this modal's focus-in runs —
// the race `useFocusTrap`'s `suppressRestore()` exists for. Verified safe
// for both existing `PromoteDialog` call sites: `PaneActionsMenu.tsx`'s
// `closeMenuAfterAction` already calls `suppressRestore()` before closing
// the menu in the same click handler that opens this dialog, and
// `Sidebar.tsx`'s `KebabMenu` has no focus trap of its own to race against.
export interface ModalProps {
  // Fired on backdrop click, the header close button, and Escape — the
  // caller decides what "close" means (a plain `onClose`, or something like
  // PromoteDialog's `cancel`, which conditionally declines a pending
  // promote request first).
  onClose: () => void;
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  // The dialog body — rendered inside `.create-modal-body`.
  children: ReactNode;
  // Rendered inside `.create-modal-footer`, only when provided — `HostConfigModal`
  // has no submit action, only a single close/cancel button, so this stays optional
  // rather than forcing every caller to always supply one.
  footer?: ReactNode;
  // Defaults to `title` when `title` is a plain string (true for all seven
  // target modals' static titles); pass explicitly when `title` is a
  // JSX fragment (e.g. HostConfigModal's `{hostName} — config`).
  ariaLabel?: string;
  // See `useFocusTrap`'s own doc comment on why callers sometimes need
  // something more specific than "first focusable descendant" — none of
  // the pilot's needs require this, but the other six modals will (e.g. a
  // primary text input).
  initialFocusRef?: RefObject<HTMLElement | null>;
  backdropClassName?: string;
  modalClassName?: string;
}

export function Modal({
  onClose,
  icon,
  title,
  subtitle,
  children,
  footer,
  ariaLabel,
  initialFocusRef,
  backdropClassName = "create-modal-backdrop",
  modalClassName = "create-modal",
}: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const { onKeyDown: onTrapKeyDown } = useFocusTrap({
    active: true,
    containerRef: modalRef,
    initialFocusRef,
  });

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    onTrapKeyDown(e);
  };

  return (
    // `aria-modal="true"` is safe as an unconditional default here (unlike
    // NotificationBell's/PaneActionsMenu's popovers, which both deliberately
    // omit it) because `backdropClassName`'s default, `.create-modal-backdrop`
    // (styles.css), is `position: fixed; inset: 0` — a full-viewport backdrop
    // with nothing behind it reachable, the same condition Settings.tsx's own
    // `.settings-backdrop` documents for the same attribute. A future caller
    // that overrides `backdropClassName` to something that ISN'T a full-page
    // backdrop would need to override this too — none of the seven
    // `create-modal-*` target modals do.
    <div className={backdropClassName} onClick={onClose}>
      <div
        ref={modalRef}
        className={modalClassName}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? (typeof title === "string" ? title : undefined)}
      >
        <div className="create-modal-header">
          {icon && <span className="create-modal-icon">{icon}</span>}
          <span className="create-modal-header-text">
            <span className="create-modal-title">{title}</span>
            {subtitle && <span className="create-modal-subtitle">{subtitle}</span>}
          </span>
          <button className="create-modal-close" onClick={onClose}>
            <CloseIcon size={15} />
          </button>
        </div>

        <div className="create-modal-body">{children}</div>

        {footer && <div className="create-modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
