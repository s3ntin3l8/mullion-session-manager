import { useState } from "react";
import { api } from "../../api/index.js";
import type { HostPairingCreated, HostPairingSummary } from "../../api/index.js";
import { useDashboardStore } from "../../store/index.js";
import { formatRelativeUntil } from "../../relativeTime.js";
import { usePolling } from "../../hooks/usePolling.js";
import { HostsIcon, PlusIcon } from "../../ui/icons.js";
import { GroupHeading, ListRow, SecondaryButton, StyledList } from "../../ui/primitives.js";
import { ErrorText } from "../../ui/ErrorText.js";
import {
  derivePairingStage,
  HELPER_DOWNLOAD_URL,
  PAIRING_STAGE_LABEL,
  type PairingStage,
} from "../../hostPairing.js";

// Issue #2449 — pair a desktop execution host with the Mullion Helper. The
// link carries the primary URL and a 10-minute one-time code only; pairing
// grants execution permission, never SSH-key sharing.

const PAIRINGS_POLL_MS = 3000;

const STAGE_COLOR: Record<PairingStage, string> = {
  pending: "var(--y)",
  paired: "var(--y)",
  connected: "var(--g)",
  expired: "var(--dim)",
  revoked: "var(--dim)",
};

export function PairDesktopSection() {
  const hosts = useDashboardStore((s) => s.hosts);
  const refreshHosts = useDashboardStore((s) => s.refreshHosts);
  const [pairings, setPairings] = useState<HostPairingSummary[]>([]);
  const [created, setCreated] = useState<HostPairingCreated | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = (isCancelled: () => boolean = () => false) => {
    api
      .listHostPairings()
      .then((rows) => {
        if (isCancelled()) return;
        setPairings(rows);
        // A redeem adds a host; pick it up without waiting for the host poll.
        if (rows.some((p) => p.state === "paired" && !hosts.some((h) => h.id === p.host_id))) {
          void refreshHosts();
        }
      })
      // Best effort: an older primary has no pairing route.
      .catch(() => undefined);
  };
  usePolling(load, PAIRINGS_POLL_MS, { pauseWhenHidden: true });

  const generate = () => {
    setBusy(true);
    setError(null);
    api
      .createHostPairing()
      .then((c) => {
        setCreated(c);
        load();
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Could not create a pairing link."),
      )
      .finally(() => setBusy(false));
  };

  const cancel = (id: string) => {
    setError(null);
    api
      .cancelHostPairing(id)
      .then(() => {
        if (created?.id === id) setCreated(null);
        load();
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Could not cancel the code."),
      );
  };

  const copy = (key: string, value: string) => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(key);
        window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
      })
      .catch(() => undefined);
  };

  const live = created && pairings.find((p) => p.id === created.id)?.state === "pending";
  const visible = pairings.filter((p) => p.state !== "revoked" && p.state !== "expired");

  return (
    <>
      <GroupHeading
        title="Pair a desktop"
        desc="Connect a Mac or Windows machine running the Mullion Helper. The link is good for 10 minutes and one use; it lets the machine run sessions, nothing more — it does not share SSH keys."
      />
      <div data-testid="pair-desktop">
        <button className="settings-add-btn" onClick={generate} disabled={busy}>
          <PlusIcon size={13} />
          Generate pairing link
        </button>
      </div>
      {error && <ErrorText style={{ marginTop: 8 }}>{error}</ErrorText>}

      {created && live && (
        <div className="settings-cascade-warning" data-testid="pairing-link-panel">
          <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <a className="settings-secondary-btn" href={created.pairing_link}>
                Open in Helper
              </a>
              <a
                className="settings-secondary-btn"
                href={HELPER_DOWNLOAD_URL}
                target="_blank"
                rel="noreferrer"
              >
                Helper not installed? Download it
              </a>
            </div>
            <div style={{ fontSize: "0.71875rem", color: "var(--dim)" }}>
              If the link does nothing, install the Helper, then retry — or paste the link (or this
              server address and code) into the Helper by hand.
            </div>
            {(
              [
                ["link", "Link", created.pairing_link],
                ["url", "Server", created.url],
                ["code", "Code", created.code],
              ] as const
            ).map(([key, label, value]) => (
              <div key={key} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ width: 48, color: "var(--dim)" }}>{label}</span>
                <code style={{ flex: 1, overflowWrap: "anywhere", fontSize: "0.6875rem" }}>
                  {value}
                </code>
                <SecondaryButton onClick={() => copy(key, value)}>
                  {copied === key ? "Copied" : "Copy"}
                </SecondaryButton>
              </div>
            ))}
          </div>
        </div>
      )}

      {visible.length > 0 && (
        <StyledList>
          {visible.map((p) => {
            const stage = derivePairingStage(p, hosts);
            const host = p.host_id ? hosts.find((h) => h.id === p.host_id) : undefined;
            return (
              <ListRow
                key={p.id}
                testId={`pairing-row-${p.id}`}
                icon={<HostsIcon size={15} />}
                dot={stage === "connected" ? "on" : "warn"}
                title={host?.name ?? p.label ?? "Desktop pairing"}
                subtitle={
                  stage === "pending"
                    ? `code expires ${formatRelativeUntil(Date.parse(p.expires_at))}`
                    : stage === "paired"
                      ? "Identity issued. The primary cannot reach this host yet."
                      : "Helper connected"
                }
                trailing={
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      data-testid={`pairing-stage-${p.id}`}
                      style={{ fontSize: "0.65625rem", color: STAGE_COLOR[stage] }}
                    >
                      {PAIRING_STAGE_LABEL[stage]}
                    </span>
                    {stage === "pending" && (
                      <SecondaryButton onClick={() => cancel(p.id)}>Cancel</SecondaryButton>
                    )}
                  </div>
                }
              />
            );
          })}
        </StyledList>
      )}
    </>
  );
}
