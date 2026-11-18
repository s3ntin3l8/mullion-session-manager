import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { DockviewPanelApi } from "dockview-react";
import { browserApi } from "./api/browser.js";
import type { Session } from "./api/index.js";
import { BrowserPanel } from "./BrowserPanel.js";
import type { BrowserPanelParams } from "./BrowserPanel.js";
import { BrowserPane } from "./BrowserPane.js";
import { EmptyStateNote } from "./ui/EmptyState.js";
import type { BrowserMode } from "./lib/browserTitles.js";

// The Browser pane's two modes behind one toolbar (#3371, decisions 1 and 6
// of docs/design/one-browser-pane/note.md). The engines stay apart: Preview
// is BrowserPanel's iframe, which the agent cannot see; Agent's browser is
// BrowserPane's canvas, streamed from the server-side browser the agent
// drives. This component only puts them behind one switch.
//
// It knows nothing about dockview or about which session to show. The grid
// pane (BrowserPaneHost.tsx) fixes the session at the switch; the right rail's
// Browser view can host this same component and pass the session it follows.

export function BrowserModeSwitch({
  mode,
  onChange,
  sessionTitle,
  agentDisabledReason,
}: {
  mode: BrowserMode;
  onChange: (mode: BrowserMode) => void;
  sessionTitle: string | null;
  agentDisabledReason: string | null;
}) {
  const agentLabel = sessionTitle ? `Agent's browser · ${sessionTitle}` : "Agent's browser";
  // aria-disabled rather than disabled, so the reason still shows as a
  // tooltip on hover (a disabled button gets no pointer events).
  const agentDisabled = agentDisabledReason != null && mode !== "agent";
  return (
    <div className="browser-mode-switch" role="radiogroup" aria-label="Browser mode">
      <button
        type="button"
        role="radio"
        aria-checked={mode === "preview"}
        className={`browser-mode-switch-seg${mode === "preview" ? " active" : ""}`}
        onClick={() => onChange("preview")}
      >
        Preview
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === "agent"}
        aria-disabled={agentDisabled || undefined}
        title={agentDisabled ? agentDisabledReason : agentLabel}
        className={`browser-mode-switch-seg${mode === "agent" ? " active" : ""}`}
        onClick={() => {
          if (!agentDisabled) onChange("agent");
        }}
      >
        <span className="browser-mode-switch-label">{agentLabel}</span>
      </button>
    </div>
  );
}

type Probe = { sessionId: number; bound: boolean } | null;

export interface BrowserShellProps {
  mode: BrowserMode;
  onModeChange: (mode: BrowserMode) => void;
  /** BROWSER_ENABLED; without it there is no switch and the pane is Preview only. */
  browserEnabled: boolean;
  previewParams: BrowserPanelParams;
  /** Lets BrowserPanel write its address back into a saved layout. */
  previewApi?: DockviewPanelApi;
  /** The session whose browser Agent's browser shows, or would show. */
  agentSession: Session | null;
  /** The title the sidebar gives that session. */
  agentSessionTitle: string;
  /** Why Agent's browser cannot be chosen, or null when it can. */
  agentDisabledReason: string | null;
  /**
   * Sessions whose browser may attach without asking the server first. An
   * explicit open of the agent's browser (the pane menu, the palette) puts
   * its session here; a switch does not, and probes instead.
   */
  attachSessionIds?: ReadonlySet<number>;
  /** Rendered last in the toolbar of either mode (#3373's button goes here). */
  toolbarEnd?: ReactNode;
}

export function BrowserShell({
  mode,
  onModeChange,
  browserEnabled,
  previewParams,
  previewApi,
  agentSession,
  agentSessionTitle,
  agentDisabledReason,
  attachSessionIds,
  toolbarEnd,
}: BrowserShellProps) {
  const sessionId = agentSession?.id ?? null;
  // Each body stays mounted once shown, hidden while the other mode is on,
  // so switching back finds the page where it was left.
  const [previewShown, setPreviewShown] = useState(mode === "preview");
  if (mode === "preview" && !previewShown) setPreviewShown(true);

  const [probe, setProbe] = useState<Probe>(null);
  // Sessions the user pressed "Open browser" for while this pane is open.
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
  // The session whose BrowserPane is mounted. Once attached it stays
  // attached while the pane shows Preview, so the page is still there.
  const [attachedId, setAttachedId] = useState<number | null>(null);

  const mayAttach =
    sessionId != null &&
    (opened.has(sessionId) ||
      attachSessionIds?.has(sessionId) === true ||
      (probe?.sessionId === sessionId && probe.bound));
  if (attachedId != null && attachedId !== sessionId) {
    // A different session, or none (it was killed), drops the attachment.
    setAttachedId(null);
  } else if (mode === "agent" && mayAttach && attachedId == null) {
    setAttachedId(sessionId);
  }

  // Attaching is what launches a session's browser (routes/browser.ts), so
  // the switch asks for the session's bindings first and never attaches on
  // its own: a session with no browser gets the "Open browser" state.
  const needsProbe =
    browserEnabled && mode === "agent" && sessionId != null && !mayAttach && attachedId == null;
  useEffect(() => {
    if (!needsProbe || sessionId == null) return;
    let cancelled = false;
    browserApi
      .getSessionBrowserBindings(sessionId)
      .then((bindings) => {
        if (!cancelled) setProbe({ sessionId, bound: bindings.length > 0 });
      })
      .catch(() => {
        // Unknown counts as "no browser yet": the button still opens one.
        if (!cancelled) setProbe({ sessionId, bound: false });
      });
    return () => {
      cancelled = true;
    };
  }, [needsProbe, sessionId]);

  const modeSwitch = browserEnabled ? (
    <BrowserModeSwitch
      mode={mode}
      onChange={onModeChange}
      sessionTitle={agentSession ? agentSessionTitle : null}
      agentDisabledReason={agentDisabledReason}
    />
  ) : null;

  const agentToolbar = (
    <div className="browser-panel-toolbar">
      {modeSwitch}
      <span className="browser-panel-url" />
      {toolbarEnd}
    </div>
  );

  let agentBody: ReactNode = null;
  if (mode === "agent" && attachedId == null) {
    let note: ReactNode;
    if (agentSession == null) {
      note = <EmptyStateNote>{agentDisabledReason ?? "No session in this project"}</EmptyStateNote>;
    } else if (probe?.sessionId !== agentSession.id) {
      note = <EmptyStateNote>Loading…</EmptyStateNote>;
    } else {
      note = (
        <div className="browser-sidebar-empty">
          <EmptyStateNote>{agentSessionTitle} has no browser yet.</EmptyStateNote>
          <button
            type="button"
            className="rs-touch-btn"
            onClick={() => setOpened((prev) => new Set(prev).add(agentSession.id))}
          >
            Open browser
          </button>
        </div>
      );
    }
    agentBody = (
      <div className="browser-pane">
        {agentToolbar}
        {note}
      </div>
    );
  }

  return (
    <div className="browser-host" data-mode={mode}>
      {previewShown && (
        <div className="browser-host-body" hidden={mode !== "preview"}>
          <BrowserPanel
            params={previewParams}
            api={previewApi}
            toolbarStart={modeSwitch}
            toolbarEnd={toolbarEnd}
          />
        </div>
      )}
      {attachedId != null && (
        <div className="browser-host-body" hidden={mode !== "agent"}>
          <BrowserPane
            key={attachedId}
            params={{ sessionId: attachedId }}
            toolbarStart={modeSwitch}
            toolbarEnd={toolbarEnd}
          />
        </div>
      )}
      {agentBody && <div className="browser-host-body">{agentBody}</div>}
    </div>
  );
}
