import { useState } from "react";
import { HostsIcon } from "./ui/icons.js";
import { Modal } from "./ui/Modal.js";
import {
  envUpdateSnippet,
  staticEnvUpdateSnippet,
  unixInstallCommand,
  windowsInstallCommand,
} from "./lib/agentInstallCommand.js";

// The second step of Add host, and the result of Rotate token: the token the
// primary just minted (shown once — the DB keeps it encrypted and no API
// returns it again) plus what to run with it.

interface AgentInstallInstructionsProps {
  onClose: () => void;
  token: string;
  hostName: string;
  /**
   * "install": a new agent (Add host). "rotate": an agent that is already
   * installed and must have its .env updated.
   */
  kind: "install" | "rotate";
  primaryUrl: string;
  baseUrl?: string;
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };
  return (
    <div className="create-modal-field">
      <span className="create-modal-field-label">{label}</span>
      <pre
        className="mono"
        style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          margin: "4px 0",
          userSelect: "all",
        }}
      >
        {text}
      </pre>
      <button className="settings-secondary-btn" onClick={copy} aria-label={`Copy ${label}`}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function AgentInstallInstructions({
  onClose,
  token,
  hostName,
  kind,
  primaryUrl,
  baseUrl,
}: AgentInstallInstructionsProps) {
  const params = { token, primaryUrl, name: hostName, baseUrl };
  return (
    <Modal
      onClose={onClose}
      icon={<HostsIcon size={16} />}
      title={kind === "install" ? `Connect ${hostName}` : `New token for ${hostName}`}
      subtitle="This token is shown once. Copy it before closing."
      footer={
        <button className="create-modal-submit" onClick={onClose}>
          Done
        </button>
      }
    >
      <CopyBlock label="Token" text={token} />
      {kind === "install" ? (
        <>
          <CopyBlock label="Windows (PowerShell)" text={windowsInstallCommand(params)} />
          <CopyBlock label="Linux / macOS" text={unixInstallCommand(params)} />
          <span className="create-modal-field-hint">
            The host shows as pending until the agent registers. On Windows, set HOST in the agent's
            .env to a LAN address and allow the firewall prompt so the primary can reach it.
          </span>
        </>
      ) : (
        <>
          <CopyBlock
            label="Agent's .env (installed with the Add host command)"
            text={envUpdateSnippet(token, primaryUrl)}
          />
          <CopyBlock
            label="Agent's .env (host added with “Use my own token”)"
            text={staticEnvUpdateSnippet(token)}
          />
          <span className="create-modal-field-hint">
            Use the one that matches how this host was added, then restart the agent. Until you do,
            it can no longer reach this primary. Re-running the installer would not apply it: the
            installer never rewrites an existing .env.
          </span>
        </>
      )}
    </Modal>
  );
}
