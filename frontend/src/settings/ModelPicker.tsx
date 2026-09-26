import { useState } from "react";
import { Dropdown, Row } from "../ui/primitives.js";
import { ErrorText } from "../ui/ErrorText.js";

export interface ModelOption {
  value: string;
  label?: string;
}

const CUSTOM = "__custom__";

// Mirror of CLI_MODEL_RE in src/services/task-model-resolve.ts — the backend
// is the source of truth. A value that fails it is only logged and skipped at
// launch, so rejecting it here is what keeps the user from saving a model
// that silently never applies.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;

export function ModelPicker({
  label,
  ariaLabel = label,
  desc,
  value,
  options,
  defaultLabel,
  allowCustom,
  onChange,
}: {
  label: string;
  // The visible label repeats across CLIs ("Default model"), so callers pass a
  // distinct accessible name for the select.
  ariaLabel?: string;
  desc?: string;
  value: string | null;
  options: ModelOption[];
  defaultLabel: string;
  allowCustom: boolean;
  onChange: (value: string | null) => void;
}) {
  const inList = value === null || options.some((o) => o.value === value);
  // `customOpen` is only the user's explicit choice of Custom…. A stored value
  // the list doesn't know (a full model ID, a model newer than the catalog)
  // shows in custom mode via `!inList` instead, derived on every render, so a
  // catalog that finishes loading after mount flips it back to the select.
  const [customOpen, setCustomOpen] = useState(false);
  const [draft, setDraft] = useState(inList ? "" : (value ?? ""));
  const [error, setError] = useState<string | null>(null);

  // Keep the field in step with the stored value when it changes underneath
  // us (settings finishing their load, another tab). Typing doesn't touch
  // `value` until a commit, so this never fights the user's edit. Done during
  // render (React's "adjust state on prop change" pattern), not in an effect.
  const [syncedValue, setSyncedValue] = useState(value);
  if (syncedValue !== value) {
    setSyncedValue(value);
    setDraft(value ?? "");
    setError(null);
  }

  const customMode = allowCustom && (customOpen || !inList);
  const selectValue = customMode ? CUSTOM : (value ?? "");

  // Only a real list entry or the default may be stored from the select; the
  // custom entry just reveals the text field.
  const handleSelect = (v: string) => {
    setError(null);
    if (v === CUSTOM) {
      // Seed from the stored value so opening Custom… and leaving the field
      // again is a no-op rather than a silent reset to the CLI default.
      setDraft(value ?? "");
      setCustomOpen(true);
      return;
    }
    setCustomOpen(false);
    onChange(v === "" ? null : v);
  };

  // Commit on blur/Enter rather than per keystroke: updateSettings debounces
  // its PATCH, but a half-typed ID would still be saved once the debounce fires.
  const commit = () => {
    const next = draft.trim();
    // Blur fires whenever focus leaves the field, edited or not.
    if (next === (value ?? "")) {
      setError(null);
      return;
    }
    if (next === "") {
      setError(null);
      onChange(null);
      return;
    }
    if (!MODEL_RE.test(next)) {
      setError("Use letters, digits and . _ : / @ [ ] - only, starting with a letter or digit.");
      return;
    }
    setError(null);
    onChange(next);
  };

  return (
    <>
      <Row label={label} desc={desc}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
          <Dropdown
            ariaLabel={ariaLabel}
            value={selectValue}
            onChange={handleSelect}
            options={[
              { value: "", label: defaultLabel },
              ...options.map((o) => ({ value: o.value, label: o.label ?? o.value })),
              ...(allowCustom ? [{ value: CUSTOM, label: "Custom…" }] : []),
            ]}
          />
          {customMode && (
            <div className="settings-numberfield" style={{ width: "100%" }}>
              <input
                aria-label={`${ariaLabel} (custom model ID)`}
                style={{ flex: 1, textAlign: "left", width: "auto" }}
                value={draft}
                placeholder="model ID"
                spellCheck={false}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit();
                }}
              />
            </div>
          )}
        </div>
      </Row>
      {error && <ErrorText style={{ paddingLeft: 6 }}>{error}</ErrorText>}
    </>
  );
}
