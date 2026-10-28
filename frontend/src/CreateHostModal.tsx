import { useRef, useState } from "react";
import { HostsIcon } from "./ui/icons.js";
import { ErrorText } from "./ui/ErrorText.js";
import { Modal } from "./ui/Modal.js";
import { AgentInstallInstructions } from "./AgentInstallInstructions.js";

interface CreateHostModalProps {
  onClose: () => void;
  // Same (name, baseUrl, token) shape either way — edit mode's caller
  // (Settings -> Hosts) decides create vs. update, matching
  // CreateProjectModal's onCreate contract. `token` is "" when editing
  // without rotating it (the field is left blank on purpose — see
  // `hasToken` below), which the caller must treat as "leave unchanged."
  // In create mode `baseUrl`/`token` are "" when left empty, and the caller
  // omits them: no token means the primary mints one, which comes back as
  // `{ token }` on the resolved value and is shown once on a second step.
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
  // Create mode: bring-your-own token (a manual / ansible-provisioned agent)
  // instead of letting the primary mint one.
  const [ownToken, setOwnToken] = useState(false);
  // The address the AGENT calls to register. Defaults to the address this
  // dashboard was opened on, which a login gateway in front of the primary
  // may block for /api/internal/register — hence it is editable.
  const [primaryUrl, setPrimaryUrl] = useState(() => window.location.origin);
  const [minted, setMinted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const isEdit = mode === "edit";
  const nameInputRef = useRef<HTMLInputElement>(null);

  const confirm = () => {
    // Re-entry guard. `saving` is state, so it is still `false` inside
    // this closure until React re-renders — but a second Enter press is a
    // separate event, and React flushes between two events, so the second
    // one does see `saving === true`. Without this, a double Enter
    // registered the same host twice (audit finding 18).
    //
    // `CreateProjectModal.tsx` has the same guard on its own `submitting`
    // flag, and the same shape.
    if (saving) return;
    const trimmedName = name.trim();
    const trimmedBaseUrl = baseUrl.trim();
    if (!trimmedName) {
      setError("A name is required.");
      nameInputRef.current?.focus();
      return;
    }
    if (!isEdit && ownToken && !token.trim()) {
      setError("Enter the token, or turn off “Use my own token” to have one generated.");
      return;
    }
    setSaving(true);
    setError(null);
    void onSave(trimmedName, trimmedBaseUrl, !isEdit && !ownToken ? "" : token.trim())
      .then((result) => {
        const generated = (result as { token?: unknown } | undefined)?.token;
        if (typeof generated === "string" && generated !== "") {
          setMinted(generated);
          setSaving(false);
          return;
        }
        onClose();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setSaving(false);
      });
  };

  if (minted !== null) {
    return (
      <AgentInstallInstructions
        kind="install"
        token={minted}
        hostName={name.trim()}
        baseUrl={baseUrl.trim() || undefined}
        primaryUrl={primaryUrl.trim() || window.location.origin}
        onClose={onClose}
      />
    );
  }

  return (
    <Modal
      onClose={onClose}
      icon={<HostsIcon size={16} />}
      title={isEdit ? "Edit host" : "Add host"}
      subtitle={
        isEdit
          ? "Update this host's name, address, or token."
          : "Register a remote Mullion agent this dashboard can run sessions on."
      }
      initialFocusRef={nameInputRef}
      footer={
        <>
          <span className="create-modal-footer-hint">
            {isEdit
              ? "Existing sessions on this host keep working; a rotated token applies immediately."
              : ownToken
                ? "Connection isn't verified until you test it from the hosts list."
                : "A token is generated next, along with the command to run on the agent."}
          </span>
          <button className="create-modal-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="create-modal-submit" onClick={confirm} disabled={saving}>
            {isEdit ? "Save changes" : "Add host"}
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
        <span className="create-modal-field-label">Base URL{isEdit ? "" : " (optional)"}</span>
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
          Where the primary reaches this agent (MULLION_ROLE=agent). Leave empty to let the agent
          report it when it registers.
        </span>
      </label>

      {!isEdit && (
        <>
          <div className="create-modal-field">
            <label className="create-modal-input-row">
              <input
                type="checkbox"
                checked={ownToken}
                onChange={(e) => setOwnToken(e.target.checked)}
              />{" "}
              Use my own token
            </label>
            <span className="create-modal-field-hint">
              For an agent already set up with MULLION_AGENT_TOKEN. Otherwise a token is generated
              for you.
            </span>
          </div>
          {!ownToken && (
            <label className="create-modal-field">
              <span className="create-modal-field-label">Primary URL the agent calls</span>
              <span className="create-modal-input-row">
                <input
                  className="mono"
                  value={primaryUrl}
                  onChange={(e) => setPrimaryUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") confirm();
                  }}
                />
              </span>
              <span className="create-modal-field-hint">
                Used in the install command. A login gateway in front of this dashboard blocks the
                agent's registration call, so use the primary's direct address (e.g.
                http://dev-01:3100) if so.
              </span>
            </label>
          )}
        </>
      )}

      {(isEdit || ownToken) && (
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
      )}

      {error && <ErrorText>{error}</ErrorText>}
    </Modal>
  );
}
