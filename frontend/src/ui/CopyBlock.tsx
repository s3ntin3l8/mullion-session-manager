import { useState } from "react";

export function CopyBlock({
  label,
  text,
  compact = false,
}: {
  label: string;
  text: string;
  compact?: boolean;
}) {
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
    <div
      className="create-modal-field"
      style={
        compact
          ? { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "center" }
          : undefined
      }
    >
      <span className="create-modal-field-label">{label}</span>
      <pre
        className="mono"
        style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          margin: compact ? 0 : "4px 0",
          gridColumn: compact ? "1 / -1" : undefined,
          userSelect: "all",
        }}
      >
        {text}
      </pre>
      <button
        className="settings-secondary-btn"
        onClick={copy}
        aria-label={`Copy ${label}`}
        style={compact ? { gridColumn: 2, gridRow: 1 } : undefined}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
