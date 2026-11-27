import { useRef, useState } from "react";
import { HostsIcon } from "./ui/icons.js";
import { ErrorText } from "./ui/ErrorText.js";
import { Modal } from "./ui/Modal.js";

interface CreateHostModalProps {
  onClose: () => void;
  // `token` is "" when editing without rotating it (the field is left blank on
  // purpose — see `hasToken` below), which the caller must treat as "leave
  // unchanged."
  onSave: (name: string, baseUrl: string, token: string) => Promise<unknown>;
  initialName?: string;
  initialBaseUrl?: string;
  // Whether this host already has a token set — shown as a placeholder hint
  // since the real token is never sent back from the API (see api/types.ts).
  hasToken?: boolean;
  // Issue #3091 — the host has a live machine identity, so it connects out and
  // its address may be cleared (an empty Base URL is then sent as a clear).
  // Without one the address is how the host is reached.
  canClearBaseUrl?: boolean;
}

// Sibling to CreateProjectModal, same create-modal-* shell/CSS (issue #26's
// Settings -> Hosts panel) — edits a remote Mullion "agent" host.
export function CreateHostModal({
  onClose,
  onSave,
  initialName = "",
  initialBaseUrl = "",
  hasToken = false,
  canClearBaseUrl = false,
}: CreateHostModalProps) {
  const [name, setName] = useState(initialName);
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const confirm = () => {
    // Re-entry guard. `saving` is state, so it is still `false` inside
    // this closure until React re-renders — but a second Enter press is a
    // separate event, and React flushes between two events, so the second
    // one does see `saving === true`. Without this, a double Enter
    // submitted twice (audit finding 18).
    if (saving) return;
    const trimmedName = name.trim();
    const trimmedBaseUrl = baseUrl.trim();
    if (!trimmedName) {
      setError("A name is required.");
      nameInputRef.current?.focus();
      return;
    }
    // An empty Base URL is either a clear (the caller sends it as one, #3091)
    // or, for a host that is reached by that address, a mistake.
    if (!trimmedBaseUrl && initialBaseUrl.trim() && !canClearBaseUrl) {
      setError(
        "Base URL can't be cleared: this agent has no live machine identity, so the primary reaches it " +
          "only by this address. Upgrade the agent first.",
      );
      return;
    }
    setSaving(true);
    setError(null);
    void onSave(trimmedName, trimmedBaseUrl, token.trim())
      .then(() => {
        onClose();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setSaving(false);
      });
  };

  return (
    <Modal
      onClose={onClose}
      icon={<HostsIcon size={16} />}
      title="Edit host"
      subtitle="Update this host's name, address, or token."
      initialFocusRef={nameInputRef}
      footer={
        <>
          <span className="create-modal-footer-hint">
            Existing sessions on this host keep working; a rotated token applies immediately.
          </span>
          <button className="create-modal-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="create-modal-submit" onClick={confirm} disabled={saving}>
            Save changes
          </button>
        </>
      }
    >
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
          {canClearBaseUrl
            ? "Clear it to make this host outbound-only: the agent connects out and needs no address. " +
              "Also stop the agent advertising one (unset MULLION_AGENT_ADVERTISE_URL, bind HOST to " +
              "loopback), or its next registration puts it back."
            : "Where the primary reaches this agent (MULLION_ROLE=agent). Leave empty to let the agent " +
              "report it when it registers."}
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
            placeholder={hasToken ? "Leave blank to keep the current token" : ""}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirm();
            }}
          />
        </span>
        <span className="create-modal-field-hint">
          Must match the agent's MULLION_AGENT_TOKEN exactly.
        </span>
      </label>

      {error && <ErrorText>{error}</ErrorText>}
    </Modal>
  );
}
