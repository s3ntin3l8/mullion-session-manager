import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { DockviewPanelApi } from "dockview-react";
import { browserApi } from "./api/browser.js";
import type { Session } from "./api/index.js";
import { BrowserPanel } from "./BrowserPanel.js";
import type { BrowserPanelParams } from "./BrowserPanel.js";
import { BrowserPane } from "./BrowserPane.js";
import { EmptyStateNote } from "./ui/EmptyState.js";
import type { BrowserMode } from "./lib/browserTitles.js";
import { HandoffButton } from "./BrowserHandoff.js";
import { useAgentAddressForPreview, usePreviewForAgentAddress } from "./hooks/useBrowserHandoff.js";
import { addressLabel, previewTargetKey, retargetedPreviewParams } from "./lib/browserHandoff.js";
import type { PreviewSource } from "./lib/browserHandoff.js";
import { useDashboardStore } from "./store/index.js";
import { describeError } from "./lib/describeError.js";

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
  previewApi?: Pick<DockviewPanelApi, "updateParameters">;
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
  /** Rendered last in the toolbar of either mode, after the ⇄ button. */
  toolbarEnd?: ReactNode;
  /**
   * #3373 — ⇄ opened another target in the preview: `params` are its new
   * preview params, every target key named; `label` is what the pane's title
   * names ("" for the project's own dev server).
   */
  onPreviewRetarget?: (params: BrowserPanelParams, label: string) => void;
  /** #3373 — bumped by an opener that resets the preview to `previewParams`,
   * dropping what ⇄ opened in it. */
  previewRev?: number;
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
  onPreviewRetarget,
  previewRev,
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
  // #3373 — ⇄'s state: what each mode shows, what the agent's browser was
  // asked to load, and what the preview was retargeted to.
  const [previewSource, setPreviewSource] = useState<PreviewSource | null>(null);
  const [agentPageUrl, setAgentPageUrl] = useState<string | null>(null);
  const [agentNav, setAgentNav] = useState<{
    url: string;
    rev: number;
    sessionId: number;
  } | null>(null);
  const [previewOverride, setPreviewOverride] = useState<BrowserPanelParams | null>(null);
  // Remounts the preview: BrowserPanel reads its target from params once.
  const [previewEpoch, setPreviewEpoch] = useState(0);
  const [handoffRev, setHandoffRev] = useState(0);
  const [seenPreviewRev, setSeenPreviewRev] = useState(previewRev);
  if (previewRev !== seenPreviewRev) {
    setSeenPreviewRev(previewRev);
    setPreviewOverride(null);
    setPreviewEpoch((e) => e + 1);
  }
  // The host changed the preview's own target (an opener bumped targetRev,
  // the rail follows another project): that wins over what ⇄ opened. The
  // host's write-back of ⇄'s own retarget names the same target, so it does
  // not count.
  const paramsTarget = previewTargetKey(previewParams);
  const [seenParamsTarget, setSeenParamsTarget] = useState(paramsTarget);
  if (paramsTarget !== seenParamsTarget) {
    setSeenParamsTarget(paramsTarget);
    if (previewOverride != null && previewTargetKey(previewOverride) !== paramsTarget) {
      setPreviewOverride(null);
      setPreviewEpoch((e) => e + 1);
    }
  }

  if (attachedId != null && attachedId !== sessionId) {
    // A different session, or none (it was killed), drops the attachment.
    setAttachedId(null);
    setAgentPageUrl(null);
    setAgentNav(null);
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

  // Preview -> agent's browser (#3373): the session ⇄ would open is the one
  // the switch would fix, so ⇄ asks about that session's browser.
  const toAgent = useAgentAddressForPreview(
    browserEnabled && mode === "preview" && agentDisabledReason == null ? sessionId : null,
    previewSource,
  );
  const toAgentReason =
    agentDisabledReason ??
    (agentSession == null ? "No session in this project" : toAgent.ok ? null : toAgent.reason);
  const openInAgent = () => {
    if (!toAgent.ok || agentSession == null || toAgentReason != null) return;
    const rev = handoffRev + 1;
    setHandoffRev(rev);
    setAgentNav({ url: toAgent.value, rev, sessionId: agentSession.id });
    // ⇄ is an explicit open: it attaches (and so launches) the browser.
    setOpened((prev) => new Set(prev).add(agentSession.id));
    onModeChange("agent");
  };

  // Agent's browser -> preview: the page the server reports, mapped by the
  // server to one of the project's previews, or an external address.
  const toPreview = usePreviewForAgentAddress(
    browserEnabled && mode === "agent" ? attachedId : null,
    attachedId != null ? agentPageUrl : null,
  );
  const previewProjectId = previewParams.projectId ?? agentSession?.projectId;
  // A click is stale once the pane left Agent's browser or its session
  // changed while a named target's preview was being created.
  const clickContext = `${mode}|${attachedId ?? ""}`;
  const clickContextRef = useRef(clickContext);
  useEffect(() => {
    clickContextRef.current = clickContext;
  });
  const openInPreview = async () => {
    if (!toPreview.ok) return;
    const startedIn = clickContext;
    const found = toPreview.value;
    let next: BrowserPanelParams;
    let label: string;
    if (found.kind === "external") {
      next = retargetedPreviewParams(previewProjectId, { kind: "external", url: found.url });
      label = addressLabel(found.url);
    } else {
      let previewSlug = found.previewSlug;
      if (found.targetId != null && previewProjectId != null) {
        try {
          previewSlug = (await browserApi.createTargetPreview(previewProjectId, found.targetId))
            .slug;
        } catch (err) {
          if (clickContextRef.current === startedIn) {
            useDashboardStore.getState().reportError("Could not open preview", describeError(err));
          }
          return;
        }
        if (clickContextRef.current !== startedIn) return;
      }
      next = retargetedPreviewParams(previewProjectId, {
        previewSlug,
        targetName: found.targetId != null ? found.label : undefined,
        previewPath: found.path === "/" ? undefined : found.path,
      });
      label = found.label;
    }
    setPreviewOverride(next);
    setPreviewEpoch((e) => e + 1);
    onPreviewRetarget?.(next, label);
    onModeChange("preview");
  };

  const toAgentButton = browserEnabled ? (
    <HandoffButton
      target="agent"
      address={toAgent.ok ? toAgent.value : null}
      disabledReason={toAgentReason}
      onClick={openInAgent}
    />
  ) : null;
  const toPreviewButton = browserEnabled ? (
    <HandoffButton
      target="preview"
      address={agentPageUrl}
      disabledReason={toPreview.ok ? null : toPreview.reason}
      onClick={() => void openInPreview()}
    />
  ) : null;

  const agentToolbar = (
    <div className="browser-panel-toolbar">
      {modeSwitch}
      <span className="browser-panel-url" />
      {toPreviewButton}
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
            key={previewEpoch}
            params={previewOverride ?? previewParams}
            api={previewApi}
            toolbarStart={modeSwitch}
            toolbarEnd={
              <>
                {toAgentButton}
                {toolbarEnd}
              </>
            }
            onSourceChange={setPreviewSource}
            onShowInAgentBrowser={browserEnabled && toAgentReason == null ? openInAgent : undefined}
          />
        </div>
      )}
      {attachedId != null && (
        <div className="browser-host-body" hidden={mode !== "agent"}>
          <BrowserPane
            key={attachedId}
            params={{ sessionId: attachedId }}
            toolbarStart={modeSwitch}
            toolbarEnd={
              <>
                {toPreviewButton}
                {toolbarEnd}
              </>
            }
            onUrlChange={setAgentPageUrl}
            navigateTo={agentNav?.sessionId === attachedId ? agentNav : undefined}
          />
        </div>
      )}
      {agentBody && <div className="browser-host-body">{agentBody}</div>}
    </div>
  );
}
