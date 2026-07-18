import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api.js";
import type { DeviceFlowStatus } from "./api.js";
import { CloseIcon, GitHubIcon } from "./icons.js";
import { SecondaryButton } from "./settings/primitives.js";

const POLL_INTERVAL_MS = 2000;

// Same create-modal-* shell as CreateHostModal.tsx — a device-flow attempt
// starts the moment this mounts (no form to fill in first), shows the
// user_code/verification_uri GitHub returns, and polls this app's own
// status endpoint until the user finishes authorizing on github.com in
// another tab (issue #27, phase 4).
export function GitHubDeviceFlowModal({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: () => void;
}) {
  const [state, setState] = useState<DeviceFlowStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // A stable handle to the latest onConnected, read from inside the interval
  // callback below — keeps that effect's own deps at `[]` so the interval
  // isn't torn down and recreated on every poll tick just because the
  // caller passed a fresh inline closure this render (Hermes review, PR #41).
  const onConnectedRef = useRef(onConnected);
  useEffect(() => {
    onConnectedRef.current = onConnected;
  });

  useEffect(() => {
    api
      .startGitHubDeviceFlow()
      .then(setState)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Could not start device flow");
      });
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      api
        .getGitHubDeviceFlowStatus()
        .then((summary) => {
          setState(summary);
          if (summary.status === "connected") onConnectedRef.current();
          // Stop polling once the attempt reaches any terminal state —
          // the interval id is captured in this same closure, so clearing
          // it here (rather than via effect cleanup) doesn't need `state`
          // in the dependency array either.
          if (summary.status !== "pending") clearInterval(timer);
        })
        .catch(() => {
          // A transient poll failure (or a stray 404 before the initial
          // start request has resolved yet) just keeps the last known
          // state on screen rather than flashing an error for one missed
          // beat.
        });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const copyCode = () => {
    if (!state) return;
    void navigator.clipboard
      ?.writeText(state.userCode)
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
            <GitHubIcon size={16} />
          </span>
          <span className="create-modal-header-text">
            <span className="create-modal-title">Connect with GitHub</span>
            <span className="create-modal-subtitle">
              Enter this code at the link below to finish connecting.
            </span>
          </span>
          <button className="create-modal-close" onClick={onClose}>
            <CloseIcon size={15} />
          </button>
        </div>

        <div className="create-modal-body">
          {error && (
            <div style={{ fontSize: 12, color: "var(--r)" }} role="alert">
              {error}
            </div>
          )}
          {!error && !state && <div className="settings-readonly-value">Starting device flow…</div>}
          {!error && state?.status === "pending" && (
            <>
              <div className="device-flow-code">{state.userCode}</div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <SecondaryButton onClick={copyCode}>
                  {copied ? "Copied" : "Copy code"}
                </SecondaryButton>
                <a
                  className="create-modal-submit"
                  style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}
                  href={state.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open GitHub
                </a>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 12 }}>
                Waiting for authorization…
              </div>
            </>
          )}
          {!error && state?.status === "expired" && (
            <div style={{ fontSize: 12, color: "var(--r)" }} role="alert">
              This code expired before it was used — close this and try again.
            </div>
          )}
          {!error && state?.status === "denied" && (
            <div style={{ fontSize: 12, color: "var(--r)" }} role="alert">
              Authorization was denied on GitHub.
            </div>
          )}
          {!error && state?.status === "error" && (
            <div style={{ fontSize: 12, color: "var(--r)" }} role="alert">
              {state.errorMessage ?? "Something went wrong connecting to GitHub."}
            </div>
          )}
        </div>

        <div className="create-modal-footer">
          <span className="create-modal-footer-hint">
            {state?.status === "pending"
              ? `Code expires if left unused for a while.`
              : "You can close this and start over at any time."}
          </span>
          <button className="create-modal-cancel" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
