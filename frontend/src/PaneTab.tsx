import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { IDockviewPanelHeaderProps } from "dockview-react";
import type { TerminalPaneParams } from "./TerminalPane.js";
import { useDashboardStore } from "./store.js";
import { CloseIcon, KillIcon, MoveIcon, OverflowIcon, RenameIcon } from "./icons.js";

// The one distinction the design's States doc (section 1) stresses above
// everything else: closing a pane only detaches the browser's view — the
// session keeps running on the host — while killing ends the actual
// program and is not reversible. They must never look like the same
// action: close is a plain × always visible on the tab; kill lives inside
// the overflow menu, and is armed by a first click before a second click
// actually fires it (matching the design's 3s arm window), so it can't
// happen by reflex the way a single-click × could.
const KILL_ARM_MS = 3000;
const KILL_ARM_SECONDS = KILL_ARM_MS / 1000;

export function PaneTab(props: IDockviewPanelHeaderProps<TerminalPaneParams>) {
  const sessionId = props.params.sessionId;
  const session = useDashboardStore((s) => s.sessions.find((sess) => sess.id === sessionId));
  const renameSession = useDashboardStore((s) => s.renameSession);
  const deleteSession = useDashboardStore((s) => s.deleteSession);
  const theme = useDashboardStore((s) => s.theme);
  const confirmBeforeKill = useDashboardStore((s) => s.settings.sessions.confirmBeforeKill);

  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(props.api.title ?? "");
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowPos, setOverflowPos] = useState<{ top: number; right: number } | null>(null);
  const [killArmed, setKillArmed] = useState(false);
  // Ticks 3 -> 2 -> 1 in the "3s"-style hint below rather than sitting
  // static for the whole arm window — matches KebabMenu's countdown.
  const [killSecondsLeft, setKillSecondsLeft] = useState(KILL_ARM_SECONDS);
  // Mirrors killSecondsLeft so the interval callback below can branch on the
  // current count without reaching into a setState updater — calling
  // setKillArmed/clearInterval (side effects) from inside a
  // setKillSecondsLeft updater function is impure and can warn under
  // StrictMode.
  const killSecondsRef = useRef(KILL_ARM_SECONDS);
  const armTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (renaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renaming]);

  useEffect(
    () => () => {
      if (armTimer.current) clearInterval(armTimer.current);
    },
    [],
  );

  // Dockview's own tab-strip container clips overflowing content (confirmed
  // live: the menu rendered in the DOM but was invisible, clipped by an
  // ancestor's `overflow: hidden`) — portaled to document.body with
  // position:fixed computed from the toggle button's own rect sidesteps
  // that entirely, rather than fighting dockview's internal stacking
  // context.
  useEffect(() => {
    if (!overflowOpen) return;
    const onOutsideClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (overflowBtnRef.current?.contains(target)) return;
      if (overflowMenuRef.current?.contains(target)) return;
      setOverflowOpen(false);
    };
    document.addEventListener("mousedown", onOutsideClick);
    return () => document.removeEventListener("mousedown", onOutsideClick);
  }, [overflowOpen]);

  const commitRename = () => {
    const value = draftName.trim();
    setRenaming(false);
    if (!value || !session) return;
    props.api.setTitle(value);
    void renameSession(session.id, value);
  };

  const armOrKill = () => {
    if (!session) return;
    // Settings -> Session management's "Confirm before kill" toggle — off
    // means the first click kills immediately, skipping the arm step below.
    if (killArmed || !confirmBeforeKill) {
      if (armTimer.current) clearInterval(armTimer.current);
      setKillArmed(false);
      setOverflowOpen(false);
      void deleteSession(session.id).then(() => props.api.close());
    } else {
      setKillArmed(true);
      killSecondsRef.current = KILL_ARM_SECONDS;
      setKillSecondsLeft(KILL_ARM_SECONDS);
      if (armTimer.current) clearInterval(armTimer.current);
      armTimer.current = setInterval(() => {
        killSecondsRef.current -= 1;
        if (killSecondsRef.current <= 0) {
          if (armTimer.current) clearInterval(armTimer.current);
          setKillArmed(false);
          setKillSecondsLeft(KILL_ARM_SECONDS);
        } else {
          setKillSecondsLeft(killSecondsRef.current);
        }
      }, 1000);
    }
  };

  // Status badge — attention takes priority (highest-value signal), then
  // working/idle for a live session, then exited/killed once the program
  // has ended. A session this process hasn't tracked yet (e.g. right after
  // a fresh page load, before the first live-refresh tick) just shows no
  // dot rather than guessing.
  let dot = null;
  let badge = null;
  let ringClass = "";
  if (session) {
    if (session.status === "killed") {
      dot = <CloseIcon size={10} className="pane-tab-dot-exited" style={{ color: "var(--r)" }} />;
    } else if (session.status === "exited") {
      dot = <CloseIcon size={10} className="pane-tab-dot-exited" />;
      badge = <span className="pane-tab-badge exited">Exited</span>;
    } else if (session.attention) {
      dot = <span className="pane-tab-dot-working" style={{ background: "var(--ring)" }} />;
      badge = <span className="pane-tab-badge attention">Attention</span>;
      ringClass = " attention-ring";
    } else if (session.activity === "working") {
      dot = <span className="pane-tab-dot-working" />;
      badge = <span className="pane-tab-badge working">Working</span>;
    } else {
      dot = <span className="pane-tab-dot-idle" />;
      badge = <span className="pane-tab-badge idle">Idle</span>;
    }
  }

  return (
    <div className={`pane-tab${ringClass}`}>
      {dot}
      {renaming ? (
        <input
          ref={renameInputRef}
          className="pane-tab-rename-input"
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            else if (e.key === "Escape") setRenaming(false);
          }}
          onBlur={commitRename}
        />
      ) : (
        <span
          className="pane-tab-name"
          title="Double-click to rename"
          onDoubleClick={() => {
            setDraftName(props.api.title ?? "");
            setRenaming(true);
          }}
        >
          {props.api.title}
        </span>
      )}
      {badge}
      <button
        className="pane-tab-btn"
        title="Close pane — detaches your view, session keeps running"
        onClick={() => props.api.close()}
      >
        <CloseIcon size={14} />
      </button>
      <button
        ref={overflowBtnRef}
        className="pane-tab-btn"
        title="More…"
        onClick={() => {
          if (!overflowOpen && overflowBtnRef.current) {
            const rect = overflowBtnRef.current.getBoundingClientRect();
            setOverflowPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
          }
          setOverflowOpen((v) => !v);
        }}
      >
        <OverflowIcon size={16} />
      </button>
      {overflowOpen &&
        overflowPos &&
        createPortal(
          <div
            ref={overflowMenuRef}
            // Portaled to document.body (see the comment above the outside-click
            // effect), which escapes the .cmux-root/.light element in App.tsx
            // where every --chrome/--border/--fg/etc. custom property is actually
            // defined — without reapplying those classes here, var(--chrome) etc.
            // resolve to nothing and the menu renders with a transparent
            // background instead of falling back to the theme.
            className={`cmux-root${theme === "light" ? " light" : ""} pane-tab-overflow-menu`}
            style={{ position: "fixed", top: overflowPos.top, right: overflowPos.right }}
          >
            <button
              className="pane-tab-overflow-item"
              onClick={() => {
                setDraftName(props.api.title ?? "");
                setRenaming(true);
                setOverflowOpen(false);
              }}
            >
              <RenameIcon size={14} style={{ color: "var(--muted)" }} />
              <span style={{ flex: 1 }}>Rename</span>
              <span className="pane-tab-overflow-hint">↵</span>
            </button>
            <button
              className="pane-tab-overflow-item"
              disabled
              title="Drag the tab to move it between panes/workspaces"
            >
              <MoveIcon size={14} style={{ color: "var(--muted)" }} />
              <span style={{ flex: 1 }}>Move (drag tab)</span>
            </button>
            <div className="pane-tab-overflow-divider" />
            <button
              className={`pane-tab-overflow-item danger${killArmed ? " armed" : ""}`}
              onClick={armOrKill}
            >
              <KillIcon size={14} />
              <span style={{ flex: 1 }}>{killArmed ? "Click again to kill" : "Kill session"}</span>
              {killArmed && (
                <span className="pane-tab-overflow-hint" style={{ color: "var(--o)" }}>
                  {killSecondsLeft}s
                </span>
              )}
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
