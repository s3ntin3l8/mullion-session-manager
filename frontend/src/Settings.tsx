import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "./hooks/useFocusTrap.js";
import { ChevronLeftIcon, CloseIcon, SearchIcon } from "./ui/icons.js";
import {
  SEARCH_INDEX,
  SECTIONS,
  resolveSettingsSection,
  type SettingsSection,
  type SettingsSectionLink,
} from "./settings/settingsSections.js";
import { AppearanceSection } from "./settings/sections/AppearanceSection.js";
import { TerminalSection } from "./settings/sections/TerminalSection.js";
import { ProjectsSection } from "./settings/sections/ProjectsSection.js";
import { HostsSection } from "./settings/sections/HostsSection.js";
import { LaunchersSection } from "./settings/sections/LaunchersSection.js";
import { ModelsSection } from "./settings/sections/ModelsSection.js";
import { NotificationsSection } from "./settings/sections/NotificationsSection.js";
import { DockSection } from "./settings/sections/DockSection.js";
import { SessionsSection } from "./settings/sections/SessionsSection.js";
import { TaskMasterSection } from "./settings/sections/TaskMasterSection.js";
import { IntegrationsSection } from "./settings/sections/IntegrationsSection.js";
import { ServerInfoSection } from "./settings/sections/ServerInfoSection.js";
import { AccountSection } from "./settings/sections/AccountSection.js";
import { DevicesSection } from "./settings/sections/DevicesSection.js";
import { InputSection } from "./settings/sections/InputSection.js";
import { AgentContextSection } from "./settings/sections/AgentContextSection.js";
import { BrowserSection } from "./settings/sections/BrowserSection.js";

export type { SettingsSection, SettingsSectionLink } from "./settings/settingsSections.js";

// Ported 1:1 from the design's settings modal: an accented nav rail (1a's
// visuals) inside a centered modal (1b's shell already in use here) — see
// .claude/plans/i-work-to-rework-delegated-bonbon.md's "Design — the shell"
// section. No `open` prop — App.tsx only mounts this while open, so
// `initialSection` is read once via a lazy useState initializer.
export function Settings({
  onClose,
  initialSection: initialSectionLink = "appearance",
}: {
  onClose: () => void;
  initialSection?: SettingsSectionLink;
}) {
  const initialSection = resolveSettingsSection(initialSectionLink);
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [query, setQuery] = useState("");
  const meta = SECTIONS.find((s) => s.id === section)!;

  // Mobile UI/UX overhaul, item D — the nav rail and content pane can't sit
  // side by side on a phone (no width for it; see `.settings-modal-body`'s
  // mobile override in styles.css), so this drives a drill-down instead:
  // the nav list shows first, picking a section swaps to its content with a
  // back chevron to return. Purely additive state — outside the <700px
  // breakpoint the CSS that reads it never applies, so desktop's existing
  // side-by-side layout is untouched regardless of this value.
  //
  // Starts already showing content, not the nav list, when `initialSection`
  // is a deep link (e.g. the server-status pill's `openSettings("server")`)
  // rather than a generic open (⌘, / the toolbar gear, both of which default
  // to "appearance" — see App.tsx's `openSettings`). There's no prop that
  // distinguishes "explicitly opened to Appearance" from "defaulted to
  // Appearance" by the time it reaches here — App.tsx's `settingsSection`
  // state always holds a concrete section — so this reads it as "requested
  // section isn't the default", which matches every current deep-link call
  // site. A future deep link that specifically targets Appearance would
  // start on the nav list instead of its content; harmless (one extra tap),
  // and not a case that exists today.
  const [mobileNavOpen, setMobileNavOpen] = useState(initialSection === "appearance");

  const visibleSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS;
    return SECTIONS.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        SEARCH_INDEX.some((entry) => entry.section === s.id && entry.text.includes(q)),
    );
  }, [query]);

  const selectSection = (id: SettingsSection) => {
    setSection(id);
    setMobileNavOpen(false);
  };

  const modalRef = useRef<HTMLDivElement>(null);

  // Hermes review, PR #621 — on mobile, both drill-down pane swaps hide
  // whatever held focus (the nav goes `display: none`; the back chevron
  // unmounts on forward nav), dropping focus to <body> with no announcement
  // of the view change. Moves focus to the new pane's own entry point:
  // forward → the back chevron (the first thing in the now-visible content
  // pane), back → the nav item for the still-current `section` (so a
  // keyboard/screen-reader user lands back where they started, not at the
  // top of the list). Skips the very first render deliberately — that
  // initial focus-in is `useFocusTrap`'s job (P11, below), not this
  // effect's; running on mount too would fight it for the first focused
  // element. `.focus()` on the back button while it's the mobile block's
  // own `display: none` (desktop, or any width ≥700px) is a no-op per spec
  // — elements outside the flat tree aren't focusable — so this never steals
  // focus outside the mobile breakpoint despite `mobileNavOpen` itself being
  // viewport-agnostic state.
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

  // P11 — this modal previously had none of UnifiedBoard.tsx's task-detail
  // drawer's focus management (focus-in, Tab trap, focus-restore). App.tsx
  // only mounts this component while `settingsOpen` is true (a fresh mount
  // per open, like CommandPalette), so `active: true` for this component's
  // entire lifetime is correct — there's no "still mounted but closed" state
  // to gate on, unlike NotificationBell's popover or PaneTab's menu.
  // `role="dialog"` + `aria-modal="true"` here (unlike UnifiedBoard's own
  // drawer, which deliberately omits aria-modal) because `.settings-backdrop`
  // genuinely covers the whole page and nothing behind it is reachable —
  // see that component's own comment for the APG rule this is following in
  // the opposite direction.
  //
  // Escape is deliberately NOT wired here — App.tsx's global keydown handler
  // (`handleGlobalEscape`) already closes Settings on Escape from anywhere,
  // including outside this modal's own subtree, which is exactly what U9
  // exists to fix for the command palette. Adding a second, redundant local
  // handler would just call `onClose` twice for the same keypress.
  //
  // Independent code review, PR #621 — explicit `initialFocusRef` (the
  // close button), not the hook's own "first focusable descendant"
  // default: whenever `initialSection` is a deep link, `mobileNavOpen`
  // starts `false`, so `.settings-back-btn` mounts before the close button
  // in DOM order. `getFocusable()` only filters `aria-hidden` ancestry, not
  // `display: none` — the back button's `display: none` outside the mobile
  // breakpoint (styles.css) makes `.focus()` a silent no-op there (verified
  // in real Chromium), so the default would leave focus on the trigger
  // behind the modal on every desktop deep-link open, never actually
  // entering the dialog. The close button is always present, always
  // visible, and identical to what the no-deep-link case already resolved
  // to before this PR — so this doesn't change behavior for that path.
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const { onKeyDown: onTrapKeyDown } = useFocusTrap({
    active: true,
    containerRef: modalRef,
    initialFocusRef: closeBtnRef,
  });

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div
        ref={modalRef}
        className="settings-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onTrapKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <div className="settings-modal-header">
          {/* CSS-hidden outside the mobile breakpoint (see .settings-back-btn
              in styles.css) — only mounted at all while mobile drill-down
              has navigated into a section, so it never has to hide itself
              on desktop via its own logic, just via the media query. */}
          {!mobileNavOpen && (
            <button
              ref={backBtnRef}
              className="settings-back-btn"
              onClick={() => setMobileNavOpen(true)}
              // Hermes review, PR #621 round 2 (non-blocking suggestion) —
              // this is exactly where focus lands after picking a section
              // (see the mobileNavOpen effect above), so folding the
              // section title in here announces which section opened
              // without a separate aria-live region (which would risk a
              // double announcement racing the focus-move announcement).
              aria-label={`Back to settings list — currently viewing ${meta.title}`}
            >
              <ChevronLeftIcon size={16} />
            </button>
          )}
          <span className="settings-modal-title">Settings</span>
          <button
            ref={closeBtnRef}
            className="settings-modal-close"
            style={{ marginLeft: "auto" }}
            onClick={onClose}
            aria-label="Close settings"
          >
            <CloseIcon size={15} />
          </button>
        </div>
        <div
          className={`settings-modal-body${mobileNavOpen ? "" : " settings-modal-body-showing-content"}`}
        >
          <div className="settings-nav">
            <div className="settings-nav-search">
              <SearchIcon size={15} strokeWidth={1.9} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search settings…"
              />
            </div>
            <div className="settings-nav-items">
              {visibleSections.map((s, i) => (
                <Fragment key={s.id}>
                  {visibleSections[i - 1]?.group !== s.group && (
                    <div className="settings-nav-group">{s.group}</div>
                  )}
                  <button
                    className={`settings-nav-item${s.id === section ? " active" : ""}`}
                    onClick={() => selectSection(s.id)}
                  >
                    {s.icon(16)}
                    <span style={{ flex: 1 }}>{s.title}</span>
                  </button>
                </Fragment>
              ))}
              {visibleSections.length === 0 && (
                <div className="settings-nav-empty">No matching settings.</div>
              )}
            </div>
          </div>
          <div className="settings-content">
            <div className="settings-content-header">
              {/* Hermes review, PR #621 (suggestion) — a plain div gave
                  screen readers nothing to announce on a mobile pane swap;
                  real heading semantics without touching its layout (a `h2`
                  here would also need `.settings-content-title`'s own CSS
                  reset for browser default heading margins). */}
              <div className="settings-content-title" role="heading" aria-level={2}>
                {meta.title}
              </div>
              <div className="settings-content-desc">{meta.desc}</div>
            </div>
            <div className="cmux-scroll settings-content-body">
              {section === "account" && <AccountSection />}
              {section === "appearance" && <AppearanceSection />}
              {section === "terminal" && <TerminalSection />}
              {section === "input" && <InputSection />}
              {section === "notifications" && <NotificationsSection />}
              {section === "sessions" && <SessionsSection />}
              {section === "launchers" && <LaunchersSection />}
              {section === "models" && <ModelsSection />}
              {section === "agent-context" && <AgentContextSection />}
              {section === "tasks" && <TaskMasterSection />}
              {section === "projects" && <ProjectsSection />}
              {section === "dock" && <DockSection />}
              {section === "browser" && <BrowserSection />}
              {section === "devices" && <DevicesSection />}
              {section === "hosts" && <HostsSection />}
              {section === "integrations" && <IntegrationsSection />}
              {section === "server" && <ServerInfoSection />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
