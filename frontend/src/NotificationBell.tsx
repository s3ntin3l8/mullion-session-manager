import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDashboardStore } from "./store.js";
import { isUnreadAttention } from "./attention.js";
import type { Session } from "./api.js";
import { BellIcon, CheckIcon } from "./icons.js";

// The toolbar bell, upgraded from a static count badge (its pre-existing
// behavior — see Toolbar.tsx's own history) into an actual notification
// center. Modeled directly on KebabMenu.tsx's portal-dropdown pattern:
// position:fixed computed from the trigger's own getBoundingClientRect()
// (sidesteps the toolbar clipping overflow), an outside-click listener
// comparing against both the trigger and the panel's own ref, and the
// load-bearing detail carried over from that component — the portaled node
// reapplies the `cmux-root`/`light` theme classes, since portaling to
// document.body escapes the `.cmux-root` subtree where every
// `--chrome`/`--border`/`--fg` custom property is actually defined.
//
// There is no backend "mark read" concept (attention is sticky in-memory
// PtyManager state — see src/services/pty-manager.ts), so read state is a
// frontend-only overlay: store.ts's `acknowledgedAttention` map plus
// `isUnreadAttention()`, the single shared rule this component and the
// badge count both use.

function formatRelativeAge(epochMs: number): string {
  const deltaSec = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (deltaSec < 45) return "just now";
  const deltaMin = Math.round(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHour = Math.round(deltaMin / 60);
  if (deltaHour < 24) return `${deltaHour}h ago`;
  const deltaDay = Math.round(deltaHour / 24);
  return `${deltaDay}d ago`;
}

export function NotificationBell({ onOpenSession }: { onOpenSession: (session: Session) => void }) {
  const theme = useDashboardStore((s) => s.theme);
  const sessions = useDashboardStore((s) => s.sessions);
  const projects = useDashboardStore((s) => s.projects);
  const acknowledgedAttention = useDashboardStore((s) => s.acknowledgedAttention);
  const acknowledgeAttention = useDashboardStore((s) => s.acknowledgeAttention);
  const acknowledgeAllAttention = useDashboardStore((s) => s.acknowledgeAllAttention);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onOutsideClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onOutsideClick);
    return () => document.removeEventListener("mousedown", onOutsideClick);
  }, [open]);

  // The toolbar's mobile breakpoint (styles.css's max-width:699px block)
  // changes .toolbar-lead's width, so the bell can move under the panel on a
  // resize/orientation-change while it's open — recompute rather than leave
  // it anchored to a stale rect.
  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      if (!btnRef.current) return;
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 6, left: rect.left });
    };
    window.addEventListener("resize", reposition);
    return () => window.removeEventListener("resize", reposition);
  }, [open]);

  const unread = sessions
    .filter((s) => isUnreadAttention(s, acknowledgedAttention))
    .sort((a, b) => (b.attentionAt ?? 0) - (a.attentionAt ?? 0));

  return (
    <>
      <button
        ref={btnRef}
        className="toolbar-icon-btn"
        title={
          unread.length > 0
            ? `Attention — ${unread.length} session${unread.length === 1 ? "" : "s"} need input`
            : "No sessions need attention"
        }
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={
          unread.length > 0
            ? `Notifications, ${unread.length} unread`
            : "Notifications, none unread"
        }
        onClick={(e) => {
          e.stopPropagation();
          if (!open && btnRef.current) {
            const rect = btnRef.current.getBoundingClientRect();
            setPos({ top: rect.bottom + 6, left: rect.left });
          }
          setOpen((v) => !v);
        }}
      >
        <BellIcon size={17} />
        {unread.length > 0 && <span className="attention-badge">{unread.length}</span>}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            className={`cmux-root${theme === "light" ? " light" : ""} pane-tab-overflow-menu notif-panel`}
            style={{ position: "fixed", top: pos.top, left: pos.left }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="notif-panel-header">
              <span className="notif-panel-title">Attention</span>
              {unread.length > 0 && (
                <button
                  className="notif-mark-all-btn"
                  onClick={() => acknowledgeAllAttention()}
                  title="Mark all as read"
                >
                  <CheckIcon size={12} />
                  Mark all read
                </button>
              )}
            </div>
            {unread.length === 0 ? (
              <div className="notif-empty">No sessions need attention</div>
            ) : (
              unread.map((session) => {
                const project = projects.find((p) => p.id === session.projectId);
                const title = session.name || session.command;
                const subtitle = `${project?.name ?? "Unknown project"}${session.lastTitle ? ` · ${session.lastTitle}` : ""}`;
                const age = session.attentionAt ? formatRelativeAge(session.attentionAt) : "";
                return (
                  <button
                    key={session.id}
                    className="notif-row"
                    aria-label={`${title} — ${subtitle}${age ? ` — ${age}` : ""}`}
                    onClick={() => {
                      acknowledgeAttention(session.id);
                      setOpen(false);
                      onOpenSession(session);
                    }}
                  >
                    <span className="notif-row-title">{title}</span>
                    <span className="notif-row-subtitle">{subtitle}</span>
                    <span className="notif-row-time">{age}</span>
                  </button>
                );
              })
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
