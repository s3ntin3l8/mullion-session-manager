import { useEffect, useState } from "react";
import { BrowserPane } from "../BrowserPane.js";
import { browserApi } from "../api/browser.js";
import { useFollowedSession } from "../hooks/useFollowedSession.js";
import { sessionDisplayTitle } from "../lib/sessionDisplay.js";
import { EmptyStateNote } from "../ui/EmptyState.js";
import type { RightSidebarViewProps } from "./views.js";

// The right sidebar's Browser view (#3012), registered only on the rails
// layouts (700 to 1099.98px; see viewBands.ts): the browser of the session the
// sidebar follows, the page filling the view under BrowserPane's own address
// bar. It is BrowserPane itself, the same client the grid pane uses, keyed by
// session so switching sessions reconnects cleanly.
//
// Attaching a BrowserPane is what launches and binds a session's browser
// (routes/browser.ts), so the view does not mount one just because a session
// has focus: it asks for the session's bindings first, and a session that has
// none gets an empty state with "Open browser", the same action as the pane
// menu's "Open Agent Browser".
type Probe = { sessionId: number; bound: boolean } | null;

export function BrowserSidebarView({ projectId }: RightSidebarViewProps) {
  const session = useFollowedSession(projectId);
  const sessionId = session?.id ?? null;
  const [probe, setProbe] = useState<Probe>(null);
  // Sessions the user asked to open a browser for while this view is mounted.
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());

  useEffect(() => {
    if (sessionId == null) return;
    let cancelled = false;
    browserApi
      .getSessionBrowserBindings(sessionId)
      .then((bindings) => {
        if (!cancelled) setProbe({ sessionId, bound: bindings.length > 0 });
      })
      .catch(() => {
        // Unknown is treated as "no browser yet": the empty state's button
        // still opens one, and attaching never needs this probe to succeed.
        if (!cancelled) setProbe({ sessionId, bound: false });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (session == null) {
    return (
      <div className="browser-sidebar-view rs-fill">
        <EmptyStateNote>
          No session in focus. Focus a session of this project to see its browser.
        </EmptyStateNote>
      </div>
    );
  }

  const show = opened.has(session.id) || (probe?.sessionId === session.id && probe.bound);
  if (show) {
    return (
      <div className="browser-sidebar-view rs-fill">
        <BrowserPane key={session.id} params={{ sessionId: session.id }} />
      </div>
    );
  }

  const probing = probe?.sessionId !== session.id;
  return (
    <div className="browser-sidebar-view rs-fill">
      {probing ? (
        <EmptyStateNote>Loading…</EmptyStateNote>
      ) : (
        <div className="browser-sidebar-empty">
          <EmptyStateNote>{sessionDisplayTitle(session)} has no browser yet.</EmptyStateNote>
          <button
            type="button"
            className="rs-touch-btn"
            onClick={() => setOpened((prev) => new Set(prev).add(session.id))}
          >
            Open browser
          </button>
        </div>
      )}
    </div>
  );
}
