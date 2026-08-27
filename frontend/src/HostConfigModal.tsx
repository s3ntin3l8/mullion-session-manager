import { useState } from "react";
import { HostsIcon, CloseIcon } from "./ui/icons.js";
import { api } from "./api/index.js";
import type { HostConfig } from "./api/index.js";
import { useAsyncData } from "./hooks/useAsyncData.js";
import { ErrorText } from "./ui/ErrorText.js";

interface HostConfigModalProps {
  hostId: string;
  hostName: string;
  onClose: () => void;
}

// Issue #247 / roadmap 7.4 — read-only view of GET /api/hosts/:id/config.
// Same create-modal-* shell as CreateHostModal (Settings -> Hosts), but
// fetches on open rather than collecting input; works identically for
// `local` and a registered remote host (see hosts.ts's own local special
// case for why).
export function HostConfigModal({ hostId, hostName, onClose }: HostConfigModalProps) {
  const [config, setConfig] = useState<HostConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the Retry button below to re-run the fetch effect (Hermes
  // review, PR #527: originally no way to retry a failed fetch short of
  // closing and reopening the modal).
  const [attempt, setAttempt] = useState(0);

  useAsyncData(
    () => api.getHostConfig(hostId),
    (result) => setConfig(result),
    (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    [hostId, attempt],
  );

  return (
    <div className="create-modal-backdrop" onClick={onClose}>
      <div className="create-modal" onClick={(e) => e.stopPropagation()}>
        <div className="create-modal-header">
          <span className="create-modal-icon">
            <HostsIcon size={16} />
          </span>
          <span className="create-modal-header-text">
            <span className="create-modal-title">{hostName} — config</span>
            <span className="create-modal-subtitle">
              This host's own effective configuration, read live.
            </span>
          </span>
          <button className="create-modal-close" onClick={onClose}>
            <CloseIcon size={15} />
          </button>
        </div>

        <div className="create-modal-body">
          {error && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <ErrorText style={{ flex: 1 }}>{error}</ErrorText>
              <button
                className="create-modal-cancel"
                onClick={() => {
                  setError(null);
                  setAttempt((n) => n + 1);
                }}
              >
                Retry
              </button>
            </div>
          )}
          {!config && !error && <div style={{ fontSize: 12, color: "var(--dim)" }}>Loading…</div>}
          {config && (
            <>
              <div className="create-modal-field">
                <span className="create-modal-field-label">Role</span>
                <span className="settings-readonly-value">{config.role}</span>
              </div>
              <div className="create-modal-field">
                <span className="create-modal-field-label">Version</span>
                <span className="settings-readonly-value">{config.version}</span>
              </div>
              <div className="create-modal-field">
                <span className="create-modal-field-label">Projects roots</span>
                <span className="settings-readonly-value">
                  {config.projectsRoots.length > 0
                    ? config.projectsRoots.join(", ")
                    : "(none configured)"}
                </span>
              </div>
              <div className="create-modal-field">
                <span className="create-modal-field-label">Sessions directory</span>
                <span className="settings-readonly-value">{config.sessionsDir}</span>
              </div>
              <div className="create-modal-field">
                <span className="create-modal-field-label">Global config directory</span>
                <span className="settings-readonly-value">{config.crsConfigDir}</span>
              </div>
              <div className="create-modal-field">
                <span className="create-modal-field-label">Browser automation</span>
                <span className="settings-readonly-value">
                  {config.browserEnabled ? "enabled" : "disabled"}
                </span>
              </div>
              <div className="create-modal-field">
                <span className="create-modal-field-label">SSH agent socket</span>
                <span className="settings-readonly-value">
                  {config.sshAuthSock === undefined
                    ? "unknown (agent predates this field)"
                    : config.sshAuthSock === null
                      ? "not configured"
                      : `${config.sshAuthSock.path} (${
                          config.sshAuthSock.present ? "present" : "not present — no tunnel up?"
                        })`}
                </span>
              </div>
            </>
          )}
        </div>

        <div className="create-modal-footer">
          <span className="create-modal-footer-hint">Pulled live on open — not cached.</span>
          <button className="create-modal-cancel" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
