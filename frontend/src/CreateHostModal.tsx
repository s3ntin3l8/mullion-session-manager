import { useRef, useState } from "react";
import { HostsIcon, CloseIcon } from "./icons.js";

interface CreateHostModalProps {
  onClose: () => void;
  // Same (name, baseUrl, token) shape either way — edit mode's caller
  // (Settings -> Hosts) decides create vs. update, matching
  // CreateProjectModal's onCreate contract. `token` is "" when editing
  // without rotating it (the field is left blank on purpose — see
  // `hasToken` below), which the caller must treat as "leave unchanged."
  onSave: (name: string, baseUrl: string, token: string) => Promise<unknown>;
  mode?: "create" | "edit";
  initialName?: string;
  initialBaseUrl?: string;
  // Whether this host already has a token set (edit mode only) — shown as a
  // placeholder hint since the real token is never sent back from the API
  // (see api.ts's Host interface).
  hasToken?: boolean;
}

// Sibling to CreateProjectModal, same create-modal-* shell/CSS (issue #26's
// Settings -> Hosts panel) — registers/edits a remote Mullion "agent" host
// this primary can proxy sessions to.
export function CreateHostModal({
  onClose,
  onSave,
  mode = "create",
  initialName = "",
  initialBaseUrl = "",
  hasToken = false,
}: CreateHostModalProps) {
  const [name, setName] = useState(initialName);
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const isEdit = mode === "edit";
  const nameInputRef = useRef<HTMLInputElement>(null);

  const confirm = () => {
    const trimmedName = name.trim();
    const trimmedBaseUrl = baseUrl.trim();
    if (!trimmedName || !trimmedBaseUrl) {
      setError("Name and base URL are both required.");
      nameInputRef.current?.focus();
      return;
    }
    if (!isEdit && !token.trim()) {
      setError("A shared secret token is required — must match this agent's MULLION_AGENT_TOKEN.");
      return;
    }
    setSaving(true);
    setError(null);
    void onSave(trimmedName, trimmedBaseUrl, token.trim())
      .then(onClose)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setSaving(false);
      });
  };

  return (
    <div className="create-modal-backdrop" onClick={onClose}>
      <div className="create-modal" onClick={(e) => e.stopPropagation()}>
        <div className="create-modal-header">
          <span className="create-modal-icon">
            <HostsIcon size={16} />
          </span>
          <span className="create-modal-header-text">
            <span className="create-modal-title">{isEdit ? "Edit host" : "Add host"}</span>
            <span className="create-modal-subtitle">
              {isEdit
                ? "Update this host's name, address, or token."
                : "Register a remote Mullion agent this dashboard can run sessions on."}
            </span>
          </span>
          <button className="create-modal-close" onClick={onClose}>
            <CloseIcon size={15} />
          </button>
        </div>

        <div className="create-modal-body">
          <label className="create-modal-field">
            <span className="create-modal-field-label">Name</span>
            <span className="create-modal-input-row">
              <input
                ref={nameInputRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="home-server"
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirm();
                }}
              />
            </span>
          </label>

          <label className="create-modal-field">
            <span className="create-modal-field-label">Base URL</span>
            <span className="create-modal-input-row">
              <input
                className="mono"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://192.168.1.20:4000"
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirm();
                }}
              />
            </span>
            <span className="create-modal-field-hint">
              Where this agent's Mullion process is reachable (MULLION_ROLE=agent).
            </span>
          </label>

          <label className="create-modal-field">
            <span className="create-modal-field-label">Token</span>
            <span className="create-modal-input-row">
              <input
                className="mono"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={isEdit && hasToken ? "Leave blank to keep the current token" : ""}
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirm();
                }}
              />
            </span>
            <span className="create-modal-field-hint">
              Must match the agent's MULLION_AGENT_TOKEN exactly.
            </span>
          </label>

          {error && (
            <div style={{ fontSize: 12, color: "var(--r)" }} role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="create-modal-footer">
          <span className="create-modal-footer-hint">
            {isEdit
              ? "Existing sessions on this host keep working; a rotated token applies immediately."
              : "Connection isn't verified until you test it from the hosts list."}
          </span>
          <button className="create-modal-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="create-modal-submit" onClick={confirm} disabled={saving}>
            {isEdit ? "Save changes" : "Add host"}
          </button>
        </div>
      </div>
    </div>
  );
}
