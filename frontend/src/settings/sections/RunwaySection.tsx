import { useEffect, useState } from "react";
import { api, ApiError } from "../../api/index.js";
import type { RunwayIntegration } from "../../api/index.js";
import { useDashboardStore } from "../../store/index.js";
import {
  GroupHeading,
  ListRow,
  NumberField,
  Row,
  SecondaryButton,
  StyledList,
} from "../../ui/primitives.js";
import { ErrorText } from "../../ui/ErrorText.js";

// Runway quota (issue #29): Runway is a SEPARATE AI-usage tracker that
// Mullion polls to learn how much quota each provider has left, so Mullion
// never claims a task onto an agent whose provider is out of quota. The
// server URL, the poll interval and the provider map are ordinary settings;
// the admin key is write-only and never round-trips through this client
// (same shape as the Hermes review relay's key), so it is managed here with
// its own fetch rather than through the settings store.

function TextSettingRow({
  label,
  desc,
  value,
  placeholder,
  width = 260,
  onCommit,
}: {
  label: string;
  desc: string;
  value: string;
  placeholder?: string;
  width?: number;
  onCommit: (v: string) => void;
}) {
  // Call sites pass `key={value}`, so a value changed from outside (e.g. the
  // settings refetch) remounts this with a fresh draft — no effect needed to
  // sync state from props.
  const [draft, setDraft] = useState(value);
  const commit = () => {
    const next = draft.trim();
    if (next !== value) onCommit(next);
  };
  return (
    <Row label={label} desc={desc} align="start">
      <div className="settings-numberfield" style={{ width }}>
        <input
          type="text"
          autoComplete="off"
          style={{ flex: 1, textAlign: "left", width: "auto" }}
          placeholder={placeholder}
          value={draft}
          aria-label={label}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </div>
    </Row>
  );
}

// Local draft so typing doesn't PATCH on every keystroke; remounted via `key`
// when the committed value changes (same reasoning as TextSettingRow).
function PollField({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(value);
  return (
    <NumberField
      value={draft}
      onChange={setDraft}
      onCommit={onCommit}
      min={5}
      max={3600}
      suffix="seconds"
    />
  );
}

// A provider map is a JSON object of "runway provider id" -> "Mullion agent
// name" ("anthropic" -> "claude"). It is edited as TEXT because the
// mapping is small, hand-written and rarely touched — a key/value editor
// would be more machinery than the setting deserves.
function ProviderMapField({
  value,
  onCommit,
}: {
  value: Record<string, string>;
  onCommit: (v: Record<string, string>) => void;
}) {
  // Same `key`-remount trick as TextSettingRow: the draft is the JSON text,
  // the committed value is the parsed object, and a change made elsewhere
  // (the settings refetch) remounts this with a fresh draft.
  const [draft, setDraft] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);

  const commit = () => {
    const text = draft.trim();
    if (text === "") {
      setError(null);
      onCommit({});
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Invalid JSON is NOT a reason to guess: the setting stays as it was
      // and the operator is told what went wrong.
      setError("Not valid JSON — the provider map is unchanged.");
      return;
    }
    if (!isProviderMap(parsed)) {
      setError('The provider map must be a JSON object of "provider id" -> "agent name".');
      return;
    }
    setError(null);
    if (JSON.stringify(parsed) !== JSON.stringify(value)) onCommit(parsed);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 320 }}>
      <div className="settings-numberfield" style={{ width: "100%" }}>
        <input
          type="text"
          autoComplete="off"
          style={{ flex: 1, textAlign: "left", width: "auto" }}
          placeholder='{"anthropic": "claude"}'
          value={draft}
          aria-label="Provider map"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </div>
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}

// A provider map only maps provider ids to agent names — anything else (an
// array, a nested object, a number as a value) is a typo, not a mapping.
function isProviderMap(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

export function RunwaySection() {
  const { settings, updateSettings } = useDashboardStore();
  const runway = settings.runway;
  const [integration, setIntegration] = useState<RunwayIntegration | null>(null);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getRunwayIntegration()
      .then(setIntegration)
      .catch(() => setIntegration(null));
  }, []);

  const saveKey = () => {
    const k = key.trim();
    if (!k) return;
    setError(null);
    setSaving(true);
    api
      .setRunwayKey(k)
      // The key is write-only, so the summary is re-read rather than kept:
      // the server owns the "is a key set" answer (same shape as the clear
      // path below).
      .then(() => api.getRunwayIntegration().then(setIntegration))
      .then(() => setKey(""))
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Could not save the key");
      })
      .finally(() => setSaving(false));
  };

  const clearKey = () => {
    setError(null);
    void api
      .clearRunwayKey()
      .then(() => api.getRunwayIntegration().then(setIntegration))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  // "Ready" needs BOTH halves: a server to poll and a key to poll it with.
  // The key is write-only, so the store can't tell us whether it is set —
  // only the integration summary can.
  const ready = runway.apiUrl !== "" && !!integration?.hasKey;

  return (
    <div style={{ marginTop: 24 }} data-testid="runway-section">
      <GroupHeading
        title="Runway quota"
        desc="Runway is a separate AI-usage tracker. Mullion polls it to learn each provider's remaining quota and will not claim a task onto an agent whose provider is out of quota. Agents never see the API key."
      />
      <StyledList>
        <ListRow
          testId="runway-row"
          dot={ready ? "on" : "off"}
          title={ready ? "Runway quota ready" : "Runway quota not configured"}
          subtitle={
            integration?.hasKey ? "API key set" : "Set the Runway URL and the API key below"
          }
          trailing={
            integration?.hasKey ? (
              <SecondaryButton onClick={clearKey}>Clear key</SecondaryButton>
            ) : undefined
          }
        />
      </StyledList>

      <TextSettingRow
        label="Runway server URL"
        desc="Base URL of the Runway server — the base URL with no trailing path, e.g. https://runway.example.com"
        // The key is prefixed rather than being the raw value: an empty
        // value would make the key "" and collide with a sibling row's
        // (React rejects duplicate keys).
        key={`runway-url:${runway.apiUrl}`}
        value={runway.apiUrl}
        placeholder="https://runway.example.com"
        onCommit={(v) => updateSettings({ runway: { apiUrl: v } })}
      />
      <Row
        label="Admin key"
        desc="Stored encrypted on the server; never shown again. Used only to read quota — agents never see it."
        align="start"
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div className="settings-numberfield" style={{ width: 260 }}>
            <input
              type="password"
              autoComplete="off"
              style={{ flex: 1, textAlign: "left", width: "auto" }}
              placeholder={integration?.hasKey ? "Replace key…" : "Runway admin key"}
              value={key}
              aria-label="Admin key"
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveKey();
              }}
            />
          </div>
          <SecondaryButton onClick={saveKey} disabled={saving || !key.trim()}>
            {saving ? "Saving…" : "Save key"}
          </SecondaryButton>
        </div>
      </Row>
      <Row
        label="Poll interval (seconds)"
        desc="How often Mullion asks Runway for fresh quota readings."
      >
        <PollField
          key={`runway-poll:${runway.pollSeconds}`}
          value={runway.pollSeconds}
          onCommit={(v) => updateSettings({ runway: { pollSeconds: v } })}
        />
      </Row>
      <Row
        label="Provider map"
        desc="Runway's provider ids name PROVIDERS (anthropic, opencode, chatgpt, minimax, gemini, github, ollama, xai, zai, deepseek, kimi_*, …) while Mullion's agents are CLIs (claude, codex, opencode, agy) — the RESOLVED command, which is what the backend matches on — so the correspondence is per-install and has to be told to Mullion here. An agent that is not in the map is never quarantined."
        align="start"
      >
        <ProviderMapField
          key={`runway-provider-map:${JSON.stringify(runway.providerMap)}`}
          value={runway.providerMap}
          onCommit={(v) => updateSettings({ runway: { providerMap: v } })}
        />
      </Row>
      {error && <ErrorText style={{ marginTop: 8 }}>{error}</ErrorText>}
    </div>
  );
}
