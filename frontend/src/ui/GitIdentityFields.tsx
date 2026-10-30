import { useState } from "react";
import { api } from "../api/index.js";
import { SecondaryButton, TextInput } from "./primitives.js";

export interface GitIdentityValue {
  name: string;
  email: string;
}

/**
 * Name + email inputs for a git identity, with a "Use this server's git
 * config" prefill (the primary's `git config --global user.name/user.email`).
 * Controlled: `onChange` fires on every edit with both halves, so the caller
 * decides how to persist (settings debounce, a project PATCH on blur, ...).
 */
export function GitIdentityFields({
  value,
  onChange,
  onCommit,
}: {
  value: GitIdentityValue;
  onChange: (next: GitIdentityValue) => void;
  /** Optional: called when an input loses focus or the prefill lands. */
  onCommit?: (next: GitIdentityValue) => void;
}) {
  const [prefillFailed, setPrefillFailed] = useState(false);

  const prefill = async () => {
    try {
      const primary = await api.getGitIdentityDefault();
      setPrefillFailed(primary.name === "" && primary.email === "");
      if (primary.name !== "" || primary.email !== "") {
        onChange(primary);
        onCommit?.(primary);
      }
    } catch {
      setPrefillFailed(true);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <TextInput
        className="ui-input-fill"
        aria-label="Git author name"
        placeholder="Name"
        value={value.name}
        onChange={(e) => onChange({ ...value, name: e.target.value })}
        onBlur={() => onCommit?.(value)}
      />
      <TextInput
        className="ui-input-fill"
        aria-label="Git author email"
        placeholder="Email"
        value={value.email}
        onChange={(e) => onChange({ ...value, email: e.target.value })}
        onBlur={() => onCommit?.(value)}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <SecondaryButton onClick={() => void prefill()}>
          Use this server's git config
        </SecondaryButton>
        {prefillFailed && (
          <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
            No global git identity is set on this server.
          </span>
        )}
      </div>
    </div>
  );
}
