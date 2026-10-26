import { useState } from "react";
import { CloseIcon, HostsIcon, PlusIcon } from "./ui/icons.js";
import { api, LOCAL_HOST_ID } from "./api/index.js";
import type { HostConfig } from "./api/index.js";
import { useAsyncData } from "./hooks/useAsyncData.js";
import { ErrorText } from "./ui/ErrorText.js";
import { Modal } from "./ui/Modal.js";

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

  // Issue #1951 follow-up — editing this (remote) host's project roots.
  // `rootsDraft` is the list being edited, null when not editing.
  const [rootsDraft, setRootsDraft] = useState<string[] | null>(null);
  const [rootsSaving, setRootsSaving] = useState(false);
  const [rootsError, setRootsError] = useState<string | null>(null);

  const saveRoots = async (roots: string[] | null) => {
    setRootsSaving(true);
    setRootsError(null);
    try {
      setConfig(await api.setHostProjectsRoots(hostId, roots));
      setRootsDraft(null);
    } catch (err) {
      setRootsError(err instanceof Error ? err.message : String(err));
    } finally {
      setRootsSaving(false);
    }
  };

  const submitRootsDraft = () => {
    const cleaned = (rootsDraft ?? []).map((r) => r.trim()).filter((r) => r !== "");
    if (cleaned.length === 0) {
      setRootsError('Add at least one directory, or use "Reset to default".');
      return;
    }
    void saveRoots(cleaned);
  };

  useAsyncData(
    () => api.getHostConfig(hostId),
    (result) => setConfig(result),
    (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    [hostId, attempt],
  );

  return (
    <Modal
      onClose={onClose}
      icon={<HostsIcon size={16} />}
      title={<>{hostName} — config</>}
      // The title is a fragment, so the shared Modal cannot derive a name
      // from it — pass one explicitly.
      ariaLabel={`${hostName} — config`}
      subtitle="This host's own effective configuration, read live."
      footer={
        <>
          <span className="create-modal-footer-hint">Pulled live on open — not cached.</span>
          <button className="create-modal-cancel" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
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
      {!config && !error && (
        <div style={{ fontSize: "0.75rem", color: "var(--dim)" }}>Loading…</div>
      )}
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
          <div className="create-modal-field" role="group" aria-label="Projects roots">
            <span className="create-modal-field-label">Projects roots</span>
            {rootsDraft === null ? (
              <>
                <span className="settings-readonly-value">
                  {config.projectsRoots.length > 0
                    ? config.projectsRoots.join(", ")
                    : "(none configured)"}
                </span>
                {/* Only a remote host whose Mullion reports the lock flag can be
                    edited from here: an older build omits it (and has no route to
                    save to), and this machine's roots live in Settings → Projects
                    & discovery. */}
                {hostId !== LOCAL_HOST_ID && config.projectsRootsLocked === undefined && (
                  <span className="create-modal-field-hint">
                    This host's Mullion is too old to change its roots from here — upgrade it.
                  </span>
                )}
                {hostId !== LOCAL_HOST_ID && config.projectsRootsLocked === true && (
                  <>
                    <span className="create-modal-field-hint">
                      Pinned by that host's operator (PROJECTS_ROOTS_LOCKED) — it cannot be changed
                      from here.
                    </span>
                    {config.projectsRootsOverrideIgnored && (
                      <>
                        <span className="create-modal-field-hint">
                          A roots list saved from here earlier is being ignored while the host is
                          pinned; it would apply again if the pin were lifted.
                        </span>
                        <span className="create-modal-input-row">
                          <button
                            className="create-modal-cancel"
                            disabled={rootsSaving}
                            onClick={() => void saveRoots(null)}
                          >
                            Reset to default
                          </button>
                        </span>
                      </>
                    )}
                  </>
                )}
                {hostId !== LOCAL_HOST_ID && config.projectsRootsLocked === false && (
                  <>
                    <span className="create-modal-field-hint">
                      {config.projectsRootsSource === "override"
                        ? "Set from this dialog. Reset goes back to the host's own setting"
                        : "From the host's own PROJECTS_ROOTS"}
                      {config.projectsRootsSource === "override" && config.projectsRootsEnv
                        ? ` (${config.projectsRootsEnv.length > 0 ? config.projectsRootsEnv.join(", ") : "none"}).`
                        : "."}
                    </span>
                    <span className="create-modal-input-row">
                      <button
                        className="create-modal-cancel"
                        onClick={() => {
                          setRootsError(null);
                          setRootsDraft(
                            config.projectsRoots.length > 0 ? [...config.projectsRoots] : [""],
                          );
                        }}
                      >
                        Edit roots
                      </button>
                      {config.projectsRootsSource === "override" && (
                        <button
                          className="create-modal-cancel"
                          disabled={rootsSaving}
                          onClick={() => void saveRoots(null)}
                        >
                          Reset to default
                        </button>
                      )}
                    </span>
                  </>
                )}
                {rootsError && <ErrorText>{rootsError}</ErrorText>}
              </>
            ) : (
              <>
                {rootsDraft.map((root, i) => (
                  <span key={i} className="create-modal-input-row">
                    <input
                      className="mono"
                      aria-label={`Root ${i + 1}`}
                      value={root}
                      placeholder="/Users/you/projects"
                      onChange={(e) =>
                        setRootsDraft((prev) =>
                          (prev ?? []).map((r, j) => (j === i ? e.target.value : r)),
                        )
                      }
                    />
                    <button
                      className="create-modal-cancel"
                      aria-label={`Remove root ${i + 1}`}
                      onClick={() =>
                        setRootsDraft((prev) => (prev ?? []).filter((_, j) => j !== i))
                      }
                    >
                      <CloseIcon size={12} />
                    </button>
                  </span>
                ))}
                <button
                  className="settings-add-btn"
                  onClick={() => setRootsDraft((prev) => [...(prev ?? []), ""])}
                >
                  <PlusIcon size={13} />
                  Add a root directory
                </button>
                <span className="create-modal-field-hint">
                  Directories on that host. They must already exist; the host refuses anything too
                  broad (its home directory, or a folder containing it). Projects outside these
                  roots stop being reachable on that host. Applies immediately, no restart.
                </span>
                {rootsError && <ErrorText>{rootsError}</ErrorText>}
                <span className="create-modal-input-row">
                  <button
                    className="create-modal-submit"
                    disabled={rootsSaving}
                    onClick={submitRootsDraft}
                  >
                    {rootsSaving ? "Saving…" : "Save roots"}
                  </button>
                  <button
                    className="create-modal-cancel"
                    disabled={rootsSaving}
                    onClick={() => {
                      setRootsDraft(null);
                      setRootsError(null);
                    }}
                  >
                    Cancel
                  </button>
                </span>
              </>
            )}
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
            <span className="settings-readonly-value">{renderSshAuthSock(config.sshAuthSock)}</span>
          </div>
        </>
      )}
    </Modal>
  );
}
