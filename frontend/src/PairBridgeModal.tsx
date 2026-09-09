import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api/index.js";
import type { BridgePairingResponse } from "./api/index.js";
import { CloseIcon, HostsIcon } from "./ui/icons.js";
import { usePolling } from "./hooks/usePolling.js";
import { SecondaryButton } from "./ui/primitives.js";
import { ErrorText } from "./ui/ErrorText.js";

const POLL_INTERVAL_MS = 2000;
const HELPER_RELEASES_URL = "https://github.com/s3ntin3l8/mullion-helper/releases/latest";

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
  const [paired, setPaired] = useState(false);
  const [connected, setConnected] = useState(false);
  const [expiresInMinutes, setExpiresInMinutes] = useState<number | null>(null);
  const onPairedRef = useRef(onPaired);

  useEffect(() => {
    onPairedRef.current = onPaired;
  });
  useEffect(() => {
    api
      .pairBridge()
      .then((response) => {
        setPairing(response);
        const remaining = new Date(response.expires_at).getTime() - Date.now();
        setExpiresInMinutes(Math.max(1, Math.round(remaining / 60000)));
      })
      .catch((reason: unknown) => {
        setError(reason instanceof ApiError ? reason.message : "Could not generate a pairing code");
      });
  }, []);

  usePolling(
    () => {
      if (!pairing) return;
      api
        .listBridges()
        .then((bridges) => {
          const bridge = bridges.find((candidate) => candidate.id === pairing.bridge_id);
          if (bridge?.hasLiveSession) setPaired(true);
          if (bridge?.connected) {
            setConnected(true);
            onPairedRef.current();
          }
        })
        .catch(() => {});
    },
    POLL_INTERVAL_MS,
    { enabled: pairing !== null && !connected, immediate: false },
  );

  function copyPayload() {
    if (!pairing) return;
    void navigator.clipboard
      ?.writeText(pairing.pairing_payload)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }

  return (
    <div className="create-modal-backdrop" onClick={onClose}>
      <div className="create-modal" onClick={(event) => event.stopPropagation()}>
        <div className="create-modal-header">
          <span className="create-modal-icon">
            <HostsIcon size={16} />
          </span>
          <span className="create-modal-header-text">
            <span className="create-modal-title">Pair an SSH agent bridge</span>
            <span className="create-modal-subtitle">Connect Mullion Helper on your laptop.</span>
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
              <ol
                style={{
                  margin: "0 0 14px",
                  paddingLeft: 20,
                  color: "var(--dim)",
                  lineHeight: 1.7,
                }}
              >
                <li>
                  <a href={HELPER_RELEASES_URL} target="_blank" rel="noreferrer">
                    Install Mullion Helper
                  </a>{" "}
                  on the laptop whose SSH agent you want to use.
                </li>
                <li>Open its tray window and paste this pairing payload.</li>
              </ol>
              <div className="bridge-pairing-command">{pairing.pairing_payload}</div>
              <div style={{ marginTop: 10 }}>
                <SecondaryButton onClick={copyPayload}>
                  {copied ? "Copied" : "Copy payload"}
                </SecondaryButton>
              </div>
              <div
                style={{ fontSize: 11.5, color: paired ? "var(--g)" : "var(--dim)", marginTop: 12 }}
              >
                {paired
                  ? "Pairing accepted — waiting for Mullion Helper to connect…"
                  : "Waiting for Mullion Helper…"}
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
            {pairing && !connected && !paired
              ? `The pairing code expires in about ${expiresInMinutes} minute${expiresInMinutes === 1 ? "" : "s"}.`
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
