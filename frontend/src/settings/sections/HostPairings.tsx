import { useState } from "react";
import { api } from "../../api/index.js";
import type { HostPairingCreated, HostPairingSummary } from "../../api/index.js";
import { useDashboardStore } from "../../store/index.js";
import { formatRelativeUntil } from "../../relativeTime.js";
import { usePolling } from "../../hooks/usePolling.js";
import { HostsIcon } from "../../ui/icons.js";
import { GroupHeading, ListRow, SecondaryButton, StyledList } from "../../ui/primitives.js";
import { ErrorText } from "../../ui/ErrorText.js";
import { Modal } from "../../ui/Modal.js";
import { CopyBlock } from "../../ui/CopyBlock.js";
import { pairingInstallCommand } from "../../lib/agentInstallCommand.js";
import {
  derivePairingStage,
  HELPER_DOWNLOAD_URL,
  PAIRING_STAGE_LABEL,
  type PairingStage,
} from "../../hostPairing.js";

const PAIRINGS_POLL_MS = 3000;

const STAGE_COLOR: Record<PairingStage, string> = {
  pending: "var(--y)",
  paired: "var(--y)",
  unclaimed: "var(--y)",
  connected: "var(--g)",
  expired: "var(--dim)",
  revoked: "var(--dim)",
};

interface HostPairingDialogProps {
  host?: { id: string; name: string };
  onClose: () => void;
}

export function HostPairingDialog({ host, onClose }: HostPairingDialogProps) {
  const [created, setCreated] = useState<HostPairingCreated | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    if (!busy) onClose();
  };

  const generate = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      setCreated(await api.createHostPairing(host ? { hostId: host.id } : undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create a pairing code.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      onClose={close}
      closeDisabled={busy}
      icon={<HostsIcon size={16} />}
      title={host ? `Re-pair ${host.name}` : "Add host"}
      subtitle={
        created
          ? `This code works once and expires ${formatRelativeUntil(Date.parse(created.expires_at))}.`
          : undefined
      }
      footer={
        <>
          {!created && (
            <button
              className="create-modal-cancel"
              onClick={close}
              aria-disabled={busy || undefined}
            >
              Cancel
            </button>
          )}
          <button
            className="create-modal-submit"
            onClick={created ? close : generate}
            aria-disabled={busy || undefined}
          >
            {created ? "Done" : busy ? "Generating…" : "Generate pairing code"}
          </button>
        </>
      }
    >
      {created ? (
        <div className="create-modal-field" data-testid="pairing-link-panel">
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
              Download Mullion Helper
            </a>
          </div>
          <span className="create-modal-field-hint">
            On macOS or Windows, open the link on the machine you want to pair. You can also paste
            the server address and code into the Helper. Pairing grants permission to run sessions.
            SSH key sharing is configured separately.
          </span>
          <CopyBlock compact label="Pairing link" text={created.pairing_link} />
          <CopyBlock compact label="Server address" text={created.url} />
          <CopyBlock compact label="Pairing code" text={created.code} />
          <CopyBlock
            compact
            label="Install command (Linux / macOS)"
            text={pairingInstallCommand(created.url, created.code, host !== undefined)}
          />
          {host && (
            <span className="create-modal-field-hint">
              For an existing install, replace "$HOME/mullion" in the command with its install
              directory. If its .env has no MULLION_PRIMARY_URL, set it to the server address above
              before running the command.
            </span>
          )}
        </div>
      ) : host ? (
        <span>
          Redeeming the code disconnects the running agent immediately. The replacement agent
          connects to this same host entry.
        </span>
      ) : (
        <span>Pair a machine to let it run sessions on this server.</span>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </Modal>
  );
}

export function HostPairings() {
  const hosts = useDashboardStore((s) => s.hosts);
  const refreshHosts = useDashboardStore((s) => s.refreshHosts);
  const [pairings, setPairings] = useState<HostPairingSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  const cancel = (id: string) => {
    setError(null);
    api
      .cancelHostPairing(id)
      .then(() => load())
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Could not cancel the code."),
      );
  };

  const visible = pairings.filter((p) => p.state !== "revoked" && p.state !== "expired");

  return (
    <>
      {error && <ErrorText style={{ marginTop: 8 }}>{error}</ErrorText>}
      {visible.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <GroupHeading title="Pairing activity" />
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
                  title={host?.name ?? p.label ?? "Host pairing"}
                  subtitle={
                    stage === "pending"
                      ? `code expires ${formatRelativeUntil(Date.parse(p.expires_at))}`
                      : stage === "revoked"
                        ? "The agent can no longer connect. Re-pair this host to reconnect."
                        : stage === "paired"
                          ? "Identity issued. The primary cannot reach this host yet."
                          : stage === "unclaimed"
                            ? "The agent never picked up its identity. Revoke or remove the host."
                            : "Agent connected"
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
        </div>
      )}
    </>
  );
}
