import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api/index.js";
import type { BridgePairingResponse } from "./api/index.js";
import { CloseIcon, HostsIcon } from "./ui/icons.js";
import { usePolling } from "./hooks/usePolling.js";
import { SecondaryButton } from "./ui/primitives.js";
import { ErrorText } from "./ui/ErrorText.js";

const POLL_INTERVAL_MS = 2000;

// Issue #820 PR7c — same create-modal-* shell and "starts the flow the
// moment this mounts, polls until the other side finishes" shape as
// GitHubDeviceFlowModal.tsx, adapted for a one-paste CLI credential instead
// of a short user-facing code: `mullion helper pair <payload>` runs on the
// laptop out of band (there's no verification_uri for this app to open —
// see agent-bridge.ts's own comment on why the payload bundles the
// server's base URL), so this modal's only job is showing the payload to
// copy and then noticing, via polling GET /api/bridges, once that bridge id
// shows up connected.
export function PairBridgeModal({
  onClose,
  onPaired,
}: {
  onClose: () => void;
  onPaired: () => void;
}) {
  const [pairing, setPairing] = useState<BridgePairingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [connected, setConnected] = useState(false);

  // Same stable-ref reasoning as GitHubDeviceFlowModal.tsx's own
  // onConnectedRef — keeps the polling effect's deps at a fixed shape so a
  // fresh inline `onPaired` closure each render doesn't tear down and
  // recreate the interval.
  const onPairedRef = useRef(onPaired);
  useEffect(() => {
    onPairedRef.current = onPaired;
  });

  useEffect(() => {
    api
      .pairBridge()
      .then(setPairing)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Could not generate a pairing code");
      });
  }, []);

  // Stops polling the moment this bridge id shows connected — `enabled`
  // recomputes to `false` on that transition, same "tear down via
  // usePolling's own effect cleanup, no extra state needed" shape as
  // GitHubDeviceFlowModal.tsx's `state.status !== "pending"` gate.
  usePolling(
    () => {
      if (!pairing) return;
      api
        .listBridges()
        .then((bridges) => {
          const mine = bridges.find((b) => b.id === pairing.bridge_id);
          if (mine?.connected) {
            setConnected(true);
            onPairedRef.current();
          }
        })
        .catch(() => {
          // A transient poll failure just keeps waiting — the pairing
          // payload itself doesn't expire for another several minutes (see
          // the footer hint below), so one missed beat isn't worth
          // surfacing as an error.
        });
    },
    POLL_INTERVAL_MS,
    { enabled: pairing !== null && !connected, immediate: false },
  );

  const copyPayload = () => {
    if (!pairing) return;
    void navigator.clipboard
      ?.writeText(pairing.pairing_payload)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };

  return (
    <div className="create-modal-backdrop" onClick={onClose}>
      <div className="create-modal" onClick={(e) => e.stopPropagation()}>
        <div className="create-modal-header">
          <span className="create-modal-icon">
            <HostsIcon size={16} />
          </span>
          <span className="create-modal-header-text">
            <span className="create-modal-title">Pair an SSH agent bridge</span>
            <span className="create-modal-subtitle">
              Run this on your laptop to forward its SSH agent to every enrolled host.
            </span>
          </span>
          <button className="create-modal-close" onClick={onClose}>
            <CloseIcon size={15} />
          </button>
        </div>

        <div className="create-modal-body">
          {error && <ErrorText>{error}</ErrorText>}
          {!error && !pairing && (
            <div className="settings-readonly-value">Generating a pairing code…</div>
          )}
          {!error && pairing && !connected && (
            <>
              <div className="bridge-pairing-command">
                mullion helper pair {pairing.pairing_payload}
              </div>
              <div style={{ marginTop: 10 }}>
                <SecondaryButton onClick={copyPayload}>
                  {copied ? "Copied" : "Copy command"}
                </SecondaryButton>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 12 }}>
                Waiting for the helper to connect…
              </div>
            </>
          )}
          {!error && connected && (
            <div style={{ fontSize: 12.5, color: "var(--g)" }}>
              Connected — this bridge is ready to forward SSH-agent requests.
            </div>
          )}
        </div>

        <div className="create-modal-footer">
          <span className="create-modal-footer-hint">
            {pairing && !connected
              ? "The pairing code expires after 10 minutes if left unused."
              : "You can close this at any time."}
          </span>
          <button className="create-modal-cancel" onClick={onClose}>
            {connected ? "Done" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}
