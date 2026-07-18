import { useRef, useState } from "react";
import { GlobeIcon, CloseIcon } from "./icons.js";

interface OpenUrlModalProps {
  onClose: () => void;
  // Resolves once the preview is created and the panel opened — errors
  // (e.g. this server rejecting a private/loopback URL — see url-guard.ts)
  // are caught here and shown inline rather than propagating.
  onOpen: (url: string) => Promise<unknown>;
}

// The "general-purpose browser tile" half of issue #28: opens an arbitrary
// external URL in a new browser pane (BrowserPanel.tsx, kind: "external"),
// proxied same-origin the same way a project's dev server is. Sibling to
// CreateHostModal's minimal single-field shell.
export function OpenUrlModal({ onClose, onOpen }: OpenUrlModalProps) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const confirm = () => {
    const trimmed = url.trim();
    if (!trimmed) {
      inputRef.current?.focus();
      return;
    }
    setOpening(true);
    setError(null);
    void onOpen(trimmed)
      .then(onClose)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setOpening(false);
      });
  };

  return (
    <div className="create-modal-backdrop" onClick={onClose}>
      <div className="create-modal" onClick={(e) => e.stopPropagation()}>
        <div className="create-modal-header">
          <span className="create-modal-icon">
            <GlobeIcon size={16} />
          </span>
          <span className="create-modal-header-text">
            <span className="create-modal-title">Open URL</span>
            <span className="create-modal-subtitle">
              Embed any external site in a browser pane.
            </span>
          </span>
          <button className="create-modal-close" onClick={onClose}>
            <CloseIcon size={15} />
          </button>
        </div>

        <div className="create-modal-body">
          <label className="create-modal-field">
            <span className="create-modal-field-label">URL</span>
            <span className="create-modal-input-row">
              <input
                ref={inputRef}
                className="mono"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirm();
                }}
              />
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
            Loopback and private-network addresses are rejected.
          </span>
          <button className="create-modal-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="create-modal-submit" onClick={confirm} disabled={opening}>
            Open
          </button>
        </div>
      </div>
    </div>
  );
}
