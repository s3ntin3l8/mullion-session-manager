import { useEffect, useState } from "react";
import { useDashboardStore } from "../store/index.js";
import { api, ApiError } from "../api/index.js";
import type { AgentRuleAgent, BundleSyncStatus, SyncStatus } from "../api/index.js";
import { resolveAgentLogo } from "../cliLogos.js";
import { ConfirmButton } from "../ui/ConfirmButton.js";
import { ErrorText } from "../ui/ErrorText.js";
import { RefreshIcon } from "../ui/icons.js";
import { Row, SecondaryButton } from "../ui/primitives.js";

// Issues #944 (status/re-sync) and #945 (remove) — a sub-panel of the
// "Inject Mullion tooling bundle" toggle in SessionsSection, surfacing S4's
// (#941) host-local, manifest-driven sync. Deliberately NOT a gate: per
// #944's own framing, the integration keeps working correctly even if this
// panel is never opened — it exists purely for status visibility and
// troubleshooting (re-sync after a hand-deleted file, or immediately after
// an upgrade), and for a clean uninstall path.
//
// Multi-host scoping (#944's own explicit decision requirement): the route
// contract this panel consumes (GET/POST /api/bundle-sync/*) has no host
// parameter at all — it only ever reports on the local Mullion process's own
// filesystem, matching project-setup.ts's existing "hostId === local only"
// precedent for actions that only make sense on the host that owns the
// filesystem. A remote host's own bundle sync status is out of scope here;
// see issue #944's own text for the alternative (wiring
// RemoteHostClient.detectAgents() -> /internal/agents) if that's ever taken
// up as a follow-up.

// Claude Code and opencode have a per-session fallback (content is injected
// directly into a session's own context at SessionStart) — codex and agy
// have no such fallback, so "not-synced" means something meaningfully
// different for each pair. Kept as a local lookup rather than trusting the
// API to spell this out per-row: the distinction is a property of each
// CLI's own delivery mechanism, not something that varies per response.
const HAS_SESSION_FALLBACK: Record<AgentRuleAgent, boolean> = {
  "claude-code": true,
  opencode: true,
  codex: false,
  agy: false,
};

const CLI_META: Record<AgentRuleAgent, { label: string; logoBinary: string }> = {
  "claude-code": { label: "Claude Code", logoBinary: "claude" },
  codex: { label: "codex", logoBinary: "codex" },
  opencode: { label: "opencode", logoBinary: "opencode" },
  agy: { label: "agy", logoBinary: "agy" },
};

function fieldDotClass(status: SyncStatus): "on" | "off" | "warn" | null {
  switch (status) {
    case "synced":
      return "on";
    case "stale":
      return "warn";
    case "not-synced":
      return "off";
    default:
      // "n-a" renders as a bare dash (no dot at all); "disabled" is never
      // reached per-row — the panel renders one top-level banner instead
      // (see the `isOff` branch below).
      return null;
  }
}

function fieldStatusText(status: SyncStatus): string {
  switch (status) {
    case "synced":
      return "Synced";
    case "stale":
      return "Stale";
    case "not-synced":
      return "Not synced";
    case "n-a":
      return "—";
    case "disabled":
      return "Off";
  }
}

function fieldNote(
  cli: AgentRuleAgent,
  kind: "skills" | "agents",
  status: SyncStatus,
): string | null {
  if (status === "stale") {
    return "Drifted since the last sync — a file was edited or deleted by hand. Re-sync now to fix.";
  }
  if (status === "not-synced") {
    return HAS_SESSION_FALLBACK[cli]
      ? "Not synced to the global directory yet — this CLI still receives this content via a per-session fallback, so nothing is actually missing."
      : `Nothing is currently delivered to this CLI's ${kind === "skills" ? "skills" : "agents"} — click Re-sync now.`;
  }
  return null;
}

function BundleSyncField({
  label,
  cli,
  kind,
  field,
}: {
  label: string;
  cli: AgentRuleAgent;
  kind: "skills" | "agents";
  field: { status: SyncStatus; root: string | null; count: number };
}) {
  const isNA = field.status === "n-a";
  const dot = fieldDotClass(field.status);
  const note = isNA ? null : fieldNote(cli, kind, field.status);
  const unit = kind === "skills" ? "skill" : "agent";

  return (
    <div className="bundle-sync-field">
      <span className="bundle-sync-field-label">{label}</span>
      <span className="bundle-sync-field-value">
        {dot && <span className={`settings-status-dot ${dot}`} />}
        <span>{fieldStatusText(field.status)}</span>
        {!isNA && field.root && (
          <span className="bundle-sync-field-root" title={field.root}>
            {field.root}
          </span>
        )}
        {!isNA && (
          <span className="bundle-sync-field-count">
            {field.count} {unit}
            {field.count === 1 ? "" : "s"}
          </span>
        )}
      </span>
      {note && <div className="bundle-sync-field-note">{note}</div>}
    </div>
  );
}

export function BundleSyncPanel() {
  const { settings, updateSettings } = useDashboardStore();
  const theme = useDashboardStore((s) => s.theme);
  const s = settings.sessions;

  const [status, setStatus] = useState<BundleSyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [resyncing, setResyncing] = useState(false);
  const [resyncError, setResyncError] = useState<string | null>(null);

  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Split from `refresh` below so the mount/toggle effect's body never
  // synchronously calls a state setter (react-hooks/set-state-in-effect) —
  // every setState here happens inside a .then/.catch/.finally callback,
  // same shape as LaunchersSection's own mount effect (which gets away with
  // not calling setLoading(true) at all by relying on useState(true)'s
  // initial value instead).
  //
  // `isCancelled` is only ever supplied by the toggle-driven effect below —
  // same "let cancelled = false" idiom as BrowserPanel.tsx's and
  // WorkflowConventionsWizardModal.tsx's own fetch effects, guarding against
  // an out-of-order response (a fast ON->OFF->ON toggle sequence can fire
  // more than one of these concurrently) pinning a stale snapshot. The
  // manual Refresh/Re-sync/Remove call sites below don't pass one: they're
  // plain event handlers, not effects, so there's no superseding re-run to
  // race against.
  const loadStatus = (isCancelled: () => boolean = () => false) =>
    api
      .getBundleSyncStatus()
      .then((data) => {
        if (isCancelled()) return;
        setStatus(data);
        setFetchError(null);
      })
      .catch((err: unknown) => {
        if (isCancelled()) return;
        setFetchError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (isCancelled()) return;
        setLoading(false);
      });

  // Manual "Refresh" click — a plain event handler, so synchronously
  // resetting loading/error state here (unlike inside the effect below) is
  // fine.
  const refresh = () => {
    setLoading(true);
    setFetchError(null);
    void loadStatus();
  };

  // Fetch on mount, and again whenever the toggle above flips. This can race
  // the settings PATCH debounce (SETTINGS_PATCH_DEBOUNCE_MS in
  // store/slices/ui.ts) and briefly return the server's PRE-flip `enabled` —
  // see the `isOff` comment below for why the "off" gating deliberately does
  // NOT trust `status.enabled` for this reason. The "Refresh" button next to
  // the heading below is always enabled, regardless of on/off state, as a
  // manual way to reconcile the per-CLI rows once the PATCH has actually
  // landed.
  useEffect(() => {
    let cancelled = false;
    void loadStatus(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [s.injectMullionBundle]);

  const handleResync = () => {
    setResyncing(true);
    setResyncError(null);
    api
      .resyncBundle()
      .then(() => refresh())
      .catch((err: unknown) => {
        setResyncError(
          err instanceof ApiError && err.statusCode === 409
            ? "Bundle delivery is currently off — turn the toggle above back on before re-syncing."
            : err instanceof Error
              ? err.message
              : String(err),
        );
      })
      .finally(() => setResyncing(false));
  };

  const handleRemove = () => {
    setRemoving(true);
    setRemoveError(null);
    api
      .removeBundleContent()
      .then((result) => {
        // The backend also flips sessions.injectMullionBundle to false
        // server-side (hence `settingDisabled` in the response) —
        // updateSettings() applies to this local zustand store
        // synchronously (store/slices/ui.ts), so the toggle above re-reads
        // as off immediately without waiting on a fresh GET /api/settings.
        // The PATCH this queues is a harmless no-op against a backend that
        // already agrees.
        if (result.settingDisabled) {
          updateSettings({ sessions: { injectMullionBundle: false } });
        }
        refresh();
      })
      .catch((err: unknown) => setRemoveError(err instanceof Error ? err.message : String(err)))
      .finally(() => setRemoving(false));
  };

  // Gated on the LOCAL toggle value alone, not `status?.enabled` — the two
  // can disagree while the settings PATCH debounce (SETTINGS_PATCH_DEBOUNCE_MS
  // in store/slices/ui.ts) is still in flight (see the effect above). OR-ing
  // in `status.enabled === false` would fix the "just turned it off" case
  // but break the more common "just turned it on" case: the effect's
  // immediate refetch would still see the server's pre-flip `enabled: false`
  // and hide this whole panel (Re-sync now included) behind the "off"
  // banner, with nothing left to trigger a further refetch once the PATCH
  // actually lands — a persistent contradiction with the toggle right above
  // it. Trusting the local value alone means turning it on shows rows
  // immediately (a transient row may read "Off" via fieldStatusText until
  // the next Refresh/re-render) instead.
  const isOff = !s.injectMullionBundle;
  const detectedClis = status?.clis.filter((c) => c.detected) ?? [];

  return (
    <div className="bundle-sync-panel">
      <Row
        label="Bundle sync status"
        desc={
          "What's actually installed on this host right now — this panel is" +
          " never a precondition for the integration working; skills and" +
          " agents sync automatically at boot regardless of whether this is" +
          " ever opened. Use Re-sync now for troubleshooting (e.g. you" +
          " deleted a synced file by hand) or impatience right after an" +
          " upgrade."
        }
      >
        <div style={{ display: "flex", gap: 8 }}>
          <SecondaryButton onClick={refresh} disabled={loading} icon={<RefreshIcon size={12} />}>
            Refresh
          </SecondaryButton>
          {!isOff && (
            <SecondaryButton
              onClick={handleResync}
              disabled={resyncing || loading}
              icon={<RefreshIcon size={12} />}
            >
              {resyncing ? "Re-syncing…" : "Re-sync now"}
            </SecondaryButton>
          )}
        </div>
      </Row>

      {fetchError && <ErrorText style={{ marginTop: 4 }}>{fetchError}</ErrorText>}
      {resyncError && <ErrorText style={{ marginTop: 4 }}>{resyncError}</ErrorText>}

      {loading && !status && (
        <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 4 }}>
          Loading sync status…
        </div>
      )}

      {status && isOff && (
        <div className="bundle-sync-off-note">
          Bundle delivery is off — turn "Inject Mullion tooling bundle" above back on to resume
          syncing skills and agents into Claude Code, Codex, opencode, and agy's own global
          directories.
        </div>
      )}

      {status && !isOff && (
        <div className="bundle-sync-cli-list">
          {detectedClis.length === 0 && (
            <div style={{ fontSize: 11.5, color: "var(--dim)" }}>
              No supported CLI detected on this host yet.
            </div>
          )}
          {detectedClis.map((c) => {
            const meta = CLI_META[c.cli];
            const logo = resolveAgentLogo(meta.logoBinary, theme);
            return (
              <div
                key={c.cli}
                className="bundle-sync-cli-card"
                data-testid={`bundle-sync-row-${c.cli}`}
              >
                <div className="bundle-sync-cli-name">
                  {logo && <img src={logo} alt="" width={16} height={16} />}
                  <span>{meta.label}</span>
                </div>
                <BundleSyncField label="Skills" cli={c.cli} kind="skills" field={c.skills} />
                <BundleSyncField label="Agents" cli={c.cli} kind="agents" field={c.agents} />
              </div>
            );
          })}
        </div>
      )}

      <div className="bundle-sync-remove-row">
        <div className="bundle-sync-remove-desc">
          {s.injectMullionBundle
            ? "Removes every skill/agent file Mullion has synced to this host" +
              " (plus known leftovers from older install shapes), and turns" +
              " bundle delivery off until you re-enable the toggle above."
            : "Bundle delivery is already off — this sweeps any skills," +
              " agents, or older-shape leftovers Mullion may have left" +
              " behind on this host."}
        </div>
        <ConfirmButton
          title="Remove all Mullion-synced content from this host"
          onConfirm={handleRemove}
          disabled={removing}
        >
          {removing ? "Removing…" : "Remove Mullion content"}
        </ConfirmButton>
      </div>
      {removeError && <ErrorText style={{ marginTop: 4 }}>{removeError}</ErrorText>}
    </div>
  );
}
