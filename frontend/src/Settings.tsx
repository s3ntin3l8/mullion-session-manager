import { useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "./hooks/useFocusTrap.js";
import { BASE_TITLE } from "./documentBadge.js";
import {
  AppearanceIcon,
  BellIcon,
  BoltIcon,
  BotIcon,
  ChevronLeftIcon,
  CloseIcon,
  DockIcon,
  FolderIcon,
  GitHubIcon,
  HostsIcon,
  LayersIcon,
  SearchIcon,
  ServerRackIcon,
  SkillIcon,
  TerminalPromptIcon,
} from "./ui/icons.js";
import { AppearanceSection } from "./settings/sections/AppearanceSection.js";
import { TerminalSection } from "./settings/sections/TerminalSection.js";
import { ProjectsSection } from "./settings/sections/ProjectsSection.js";
import { HostsSection } from "./settings/sections/HostsSection.js";
import { LaunchersSection } from "./settings/sections/LaunchersSection.js";
import { NotificationsSection } from "./settings/sections/NotificationsSection.js";
import { DockSection } from "./settings/sections/DockSection.js";
import { SessionsSection } from "./settings/sections/SessionsSection.js";
import { TaskMasterSection } from "./settings/sections/TaskMasterSection.js";
import { IntegrationsSection } from "./settings/sections/IntegrationsSection.js";
import { SkillsSection } from "./settings/sections/SkillsSection.js";
import { ServerInfoSection } from "./settings/sections/ServerInfoSection.js";

export type SettingsSection =
  | "appearance"
  | "terminal"
  | "projects"
  | "hosts"
  | "launchers"
  | "notifications"
  | "dock"
  | "sessions"
  | "tasks"
  | "integrations"
  | "skills"
  | "server";

const SECTIONS: Array<{
  id: SettingsSection;
  title: string;
  desc: string;
  icon: (size: number) => React.ReactNode;
}> = [
  {
    id: "appearance",
    title: "Appearance",
    desc: "Theme, terminal fonts, colors, and cursor.",
    icon: (size) => <AppearanceIcon size={size} />,
  },
  {
    id: "terminal",
    title: "Terminal behavior",
    desc: "Scrollback, clipboard, reconnect, and key capture.",
    icon: (size) => <TerminalPromptIcon size={size} />,
  },
  {
    id: "projects",
    title: "Projects & discovery",
    desc: "Where Mullion scans for repositories.",
    icon: (size) => <FolderIcon size={size} />,
  },
  {
    id: "hosts",
    title: "Hosts",
    desc: "Remote machines Mullion can run sessions on.",
    icon: (size) => <HostsIcon size={size} />,
  },
  {
    id: "launchers",
    title: "Launchers & agents",
    desc: "Detected CLIs and session defaults.",
    icon: (size) => <BoltIcon size={size} />,
  },
  {
    id: "notifications",
    title: "Notifications & status",
    desc: "Attention alerts and how they reach you.",
    icon: (size) => <BellIcon size={size} />,
  },
  {
    id: "dock",
    title: "Dock",
    desc: "Monitor worktree refresh behavior.",
    icon: (size) => <DockIcon size={size} />,
  },
  {
    id: "sessions",
    title: "Session management",
    desc: "Naming, confirmations, and cleanup.",
    icon: (size) => <LayersIcon size={size} />,
  },
  {
    id: "tasks",
    title: "Task Master",
    desc: "Autonomous task claiming and its safety envelope.",
    icon: (size) => <BotIcon size={size} />,
  },
  {
    id: "integrations",
    title: "Integrations",
    desc: "Connect external services like GitHub.",
    icon: (size) => <GitHubIcon size={size} />,
  },
  {
    id: "skills",
    title: "Skills",
    desc: "Discovered skills across every agent CLI.",
    icon: (size) => <SkillIcon size={size} />,
  },
  {
    id: "server",
    title: "Server info",
    desc: "Read-only deployment diagnostics.",
    icon: (size) => <ServerRackIcon size={size} />,
  },
];

// A real (not cosmetic) filter over control labels — the nav rail's search
// box (ported from the reference's 1a nav) narrows to sections that
// actually contain a matching control, not just a section whose title
// matches. Kept as a flat static index rather than scraping the rendered
// DOM: simpler, and stays correct even for a section that isn't currently
// mounted.
const SEARCH_INDEX: Array<{ section: SettingsSection; text: string }> = [
  { section: "appearance", text: "theme dark light system" },
  { section: "appearance", text: "terminal font family geist jetbrains ibm plex sf mono menlo" },
  { section: "appearance", text: "font size" },
  { section: "appearance", text: "pane padding margin inset panel edge" },
  { section: "appearance", text: "color scheme tokyo night dracula solarized gruvbox one dark" },
  { section: "appearance", text: "cursor style block bar underline blink" },
  { section: "appearance", text: "sidebar density comfortable compact" },
  { section: "terminal", text: "scrollback lines" },
  { section: "terminal", text: "copy on select clipboard" },
  { section: "terminal", text: "allow programs set clipboard write osc 52" },
  { section: "terminal", text: "paste on right click" },
  { section: "terminal", text: "auto reconnect drop" },
  { section: "terminal", text: "key conflict handling ctrl r l k reverse search clear kill line" },
  {
    section: "terminal",
    text: "clipboard shortcuts ctrl v paste ctrl c copy selection sigint insert",
  },
  { section: "projects", text: "project roots add root directory" },
  { section: "projects", text: "discover now rescan" },
  { section: "projects", text: "global config directory" },
  { section: "hosts", text: "remote host agent register base url token" },
  { section: "hosts", text: "test connection ping online offline" },
  { section: "hosts", text: "cascade delete host projects" },
  { section: "launchers", text: "detected clis shells agents refresh" },
  { section: "launchers", text: "ai agents skip perms status show" },
  { section: "launchers", text: "default shell" },
  { section: "launchers", text: "default agent" },
  { section: "launchers", text: "global launchers manage actions.json" },
  { section: "notifications", text: "browser permission bell osc" },
  { section: "notifications", text: "delivery channels browser sound ping chime blip" },
  { section: "notifications", text: "idle threshold" },
  { section: "notifications", text: "status notification matrix notify sound focus" },
  { section: "notifications", text: "auto focus on attention" },
  { section: "dock", text: "worktree refresh branch sync monitor hmr preview" },
  { section: "sessions", text: "new session name pattern agent project" },
  { section: "sessions", text: "confirm before kill" },
  { section: "sessions", text: "show exited killed sessions" },
  { section: "sessions", text: "auto reconcile interval" },
  { section: "sessions", text: "stale error timeout" },
  { section: "sessions", text: "event history persistence retention days" },
  { section: "sessions", text: "auto open child panels spawned subagent" },
  { section: "sessions", text: "max child sessions per parent spawn cap" },
  { section: "tasks", text: "task master enable autonomous claim board" },
  { section: "tasks", text: "pause auto-claim kill switch" },
  { section: "tasks", text: "max concurrent claims cap in flight" },
  { section: "tasks", text: "per-task budget minutes timeout" },
  { section: "tasks", text: "progress comment throttle github issue" },
  { section: "tasks", text: "reset to environment defaults" },
  { section: "tasks", text: "issue label poll interval deploy-time" },
  { section: "tasks", text: "default agent default review agent per-project" },
  { section: "integrations", text: "github personal access token pat connect disconnect" },
  { section: "integrations", text: "issues pull requests actions device flow oauth" },
  { section: "skills", text: "skill directories claude codex opencode agy plugins marketplace" },
  { section: "skills", text: "skill.md name description builtin global project" },
  { section: "server", text: "version environment port encryption uptime role primary agent" },
  { section: "server", text: "sessions directory database rate limit" },
  { section: "server", text: "updates update now release latest apply auto-update" },
];

// Ported 1:1 from the design's settings modal: an accented nav rail (1a's
// visuals) inside a centered modal (1b's shell already in use here) — see
// .claude/plans/i-work-to-rework-delegated-bonbon.md's "Design — the shell"
// section. No `open` prop — App.tsx only mounts this while open, so
// `initialSection` is read once via a lazy useState initializer.
export function Settings({
  onClose,
  initialSection = "appearance",
}: {
  onClose: () => void;
  initialSection?: SettingsSection;
}) {
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
              {visibleSections.map((s) => (
                <button
                  key={s.id}
                  className={`settings-nav-item${s.id === section ? " active" : ""}`}
                  onClick={() => selectSection(s.id)}
                >
                  {s.icon(16)}
                  <span style={{ flex: 1 }}>{s.title}</span>
                </button>
              ))}
              {visibleSections.length === 0 && (
                <div className="settings-nav-empty">No matching settings.</div>
              )}
            </div>
            <div className="settings-nav-footer">
              {/* Rich statuses (issue: extend surfaced session statuses) — was
                  reading document.title[0] directly, which broke once
                  documentBadge.ts started prefixing an attention count onto
                  document.title ("(2) Mullion" -> "(" instead of "M"). Reads
                  the app's own base title constant instead, so the two can't
                  drift out of sync with each other again. */}
              <span className="settings-nav-footer-badge">{BASE_TITLE[0] || "T"}</span>
              <span className="settings-nav-footer-text">single-user</span>
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
              {section === "appearance" && <AppearanceSection />}
              {section === "terminal" && <TerminalSection />}
              {section === "projects" && <ProjectsSection />}
              {section === "hosts" && <HostsSection />}
              {section === "launchers" && <LaunchersSection />}
              {section === "notifications" && <NotificationsSection />}
              {section === "dock" && <DockSection />}
              {section === "sessions" && <SessionsSection />}
              {section === "tasks" && <TaskMasterSection />}
              {section === "integrations" && <IntegrationsSection />}
              {section === "skills" && <SkillsSection />}
              {section === "server" && <ServerInfoSection />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
