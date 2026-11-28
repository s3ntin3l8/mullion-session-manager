import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
import { usePhoneBackStack } from "../hooks/usePhoneBackStack.js";
import { ChevronLeftIcon, CloseIcon } from "../ui/icons.js";

/** One entry of the shell's nav rail. */
export interface SettingsShellSection<Id extends string = string> {
  id: Id;
  title: string;
  desc?: string;
  group?: string;
  icon: (size: number) => ReactNode;
}

export interface SettingsShellProps<Id extends string> {
  /** The dialog's name: the header title and its accessible name. */
  title: string;
  /** The sections the nav rail lists (already filtered, when it searches). */
  sections: readonly SettingsShellSection<Id>[];
  /** The section being shown (need not be in `sections`, e.g. while a search
   * hides it). */
  active: SettingsShellSection<Id>;
  onSelect: (id: Id) => void;
  /** Every way out (close button, backdrop, phone back) goes through here. */
  onClose: () => void;
  closeLabel: string;
  /** Back from a section on the phone: "Back to <listLabel>". */
  listLabel: string;
  /** Starts on the section's content rather than the phone's nav list. */
  startOnContent: boolean;
  phone?: boolean;
  backStack?: boolean;
  /** Above the nav items (Settings' search box). */
  navTop?: ReactNode;
  /** Shown in place of the nav items when `sections` is empty. */
  navEmpty?: ReactNode;
  /** Above the content pane (a confirmation strip). */
  banner?: ReactNode;
  /** Extra class on the content pane's scroll box (Project settings' editors
   * fill it rather than scroll in it). */
  bodyClassName?: string;
  /** The content pane's body. */
  children: ReactNode;
}

function PhoneBackEntry({ active, onBack }: { active: boolean; onBack: () => void }) {
  usePhoneBackStack(active, onBack);
  return null;
}

// The modal frame Settings and Project settings share (#3406): a nav rail and
// a content pane in a centered modal, a drill-down on the phone. Owns the
// focus trap, the phone back stack and the drill-down's focus moves; the
// caller owns which sections exist and what the content pane shows. Escape is
// not handled here: App's global keydown handler (handleGlobalEscape) closes
// whichever overlay is open from anywhere, focus inside the modal or not.
export function SettingsShell<Id extends string>({
  title,
  sections,
  active,
  onSelect,
  onClose,
  closeLabel,
  listLabel,
  startOnContent,
  phone = false,
  backStack = false,
  navTop,
  navEmpty,
  banner,
  bodyClassName,
  children,
}: SettingsShellProps<Id>) {
  // The phone's drill-down: the nav list shows first, picking a section swaps
  // to its content with a back chevron to return. Outside the <700px
  // breakpoint the CSS that reads this never applies, so the side-by-side
  // layout is untouched whatever its value. A deep link starts on content.
  const [mobileNavOpen, setMobileNavOpen] = useState(!startOnContent);
  // Stack order is [dialog, section content]: back pops the section to the
  // list first, then closes the dialog. Registered here rather than from App,
  // whose effects run after this component's and would land ABOVE.
  // The dialog's own entry is a keyed child (registered before the hook below,
  // since child effects run first). Back pops it before calling onClose, and an
  // onClose that refuses (Project settings asking over an unsaved draft) would
  // leave the dialog with no entry, so the next back would leave the app. A
  // new key after every back re-registers it while the dialog stays open.
  const [backKey, setBackKey] = useState(0);
  const onBack = () => {
    onClose();
    setBackKey((k) => k + 1);
  };
  usePhoneBackStack(phone && !mobileNavOpen, () => setMobileNavOpen(true));

  const select = (id: Id) => {
    onSelect(id);
    setMobileNavOpen(false);
  };

  const modalRef = useRef<HTMLDivElement>(null);

  // Both drill-down pane swaps hide whatever held focus (the nav goes
  // `display: none`; the back chevron unmounts on forward nav), so focus
  // moves to the new pane's entry point: forward → the back chevron, back →
  // the nav item of the current section. Skips the first render, which is
  // the focus trap's. `.focus()` on the back button while it is
  // `display: none` (any width ≥700px) is a no-op, so this never steals focus
  // outside the phone breakpoint.
  const isFirstRenderRef = useRef(true);
  const backBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      return;
    }
    if (mobileNavOpen) {
      modalRef.current?.querySelector<HTMLElement>(".settings-nav-item.active")?.focus();
    } else {
      backBtnRef.current?.focus();
    }
  }, [mobileNavOpen]);

  // Mounted only while open, so the trap is active for the whole lifetime.
  // Initial focus is the close button, not the first focusable: on a deep
  // link the (desktop-hidden) back chevron comes first in DOM order, and
  // focusing a `display: none` element is a silent no-op.
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const { onKeyDown: onTrapKeyDown } = useFocusTrap({
    active: true,
    containerRef: modalRef,
    initialFocusRef: closeBtnRef,
  });

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <PhoneBackEntry key={backKey} active={phone || backStack} onBack={onBack} />
      <div
        ref={modalRef}
        className="settings-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onTrapKeyDown}
        role="dialog"
        // Not modal on the phone: the tab bar stays on screen and usable
        // below it (mobile.css's .settings-host), so the rest of the page is
        // not inert there.
        aria-modal={phone ? undefined : "true"}
        aria-label={title}
      >
        <div className="settings-modal-header">
          {/* CSS-hidden outside the mobile breakpoint (.settings-back-btn). */}
          {!mobileNavOpen && (
            <button
              ref={backBtnRef}
              className="settings-back-btn"
              onClick={() => setMobileNavOpen(true)}
              // Where focus lands after picking a section, so it names the
              // section that opened.
              aria-label={`Back to ${listLabel} — currently viewing ${active.title}`}
            >
              <ChevronLeftIcon size={16} />
            </button>
          )}
          <h2 className="settings-modal-title">
            {/* Phone drill-down: name the section you're in. */}
            {phone && !mobileNavOpen ? active.title : title}
          </h2>
          <button
            ref={closeBtnRef}
            className="settings-modal-close"
            style={{ marginLeft: "auto" }}
            onClick={onClose}
            aria-label={closeLabel}
          >
            <CloseIcon size={15} />
          </button>
        </div>
        {banner}
        <div
          className={`settings-modal-body${mobileNavOpen ? "" : " settings-modal-body-showing-content"}`}
        >
          <div className="settings-nav">
            {navTop}
            <div className="settings-nav-items">
              {sections.map((s, i) => (
                <Fragment key={s.id}>
                  {s.group !== undefined && sections[i - 1]?.group !== s.group && (
                    <div className="settings-nav-group">{s.group}</div>
                  )}
                  <button
                    className={`settings-nav-item${s.id === active.id ? " active" : ""}`}
                    onClick={() => select(s.id)}
                    // Announced as "current page" within the modal.
                    aria-current={s.id === active.id ? "page" : undefined}
                  >
                    {s.icon(16)}
                    <span className="settings-nav-label">{s.title}</span>
                  </button>
                </Fragment>
              ))}
              {sections.length === 0 && navEmpty}
            </div>
          </div>
          <div className="settings-content">
            <div className="settings-content-header">
              <div className="settings-content-title" role="heading" aria-level={2}>
                {active.title}
              </div>
              {active.desc && <div className="settings-content-desc">{active.desc}</div>}
            </div>
            <div
              className={`cmux-scroll settings-content-body${bodyClassName ? ` ${bodyClassName}` : ""}`}
            >
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
