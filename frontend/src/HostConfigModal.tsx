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

// Issue #820 PR7a's `source` tag, rendered as a short trailing label — see
// HostConfig.sshAuthSock's own comment for why "none" never appears here
// (that tier is the `null` case renderSshAuthSock's own caller handles
// separately). Absent entirely for a `source`-predating build (see
// renderSshAuthSock below), which returns "" here so the base path/present
// string renders unchanged rather than growing a stray trailing space.
function renderSshAuthSockSource(source: NonNullable<HostConfig["sshAuthSock"]>["source"]): string {
  if (source === "configured") return " — configured via MULLION_SSH_AUTH_SOCK";
  if (source === "ambient") return " — ambient (inherited on that host, not managed by Mullion)";
  if (source === "bridge") return " — SSH agent bridge (Settings > Hosts)";
  return "";
}

// Hermes review, PR #828 — pulled out of the render body since it's three
// genuinely distinct states (see HostConfig.sshAuthSock's own comment),
// not two nested booleans; a helper reads better than the nested ternary
// as-inline. PR7a/PR7c added a fourth, `source`, layered onto the
// configured/present state rather than a fifth top-level branch — a build
// that predates PR7a reports `sshAuthSock` with no `source` key at all
// (still a normal, non-`undefined` object), which renderSshAuthSockSource
// above turns into "" so this renders exactly what it always did.
function renderSshAuthSock(sshAuthSock: HostConfig["sshAuthSock"]): string {
  if (sshAuthSock === undefined) return "unknown (agent predates this field)";
  if (sshAuthSock === null) return "not configured";
  const presence = sshAuthSock.present ? "present" : "not present — no tunnel up?";
  return `${sshAuthSock.path} (${presence})${renderSshAuthSockSource(sshAuthSock.source)}`;
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
                  {renderSshAuthSock(config.sshAuthSock)}
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
