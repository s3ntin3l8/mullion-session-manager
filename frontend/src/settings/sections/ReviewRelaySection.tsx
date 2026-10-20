import { useEffect, useState } from "react";
import { api, ApiError } from "../../api/index.js";
import type { HermesIntegration, ReviewRun } from "../../api/index.js";
import { useDashboardStore } from "../../store/index.js";
import {
  GroupHeading,
  ListRow,
  NumberField,
  Row,
  SecondaryButton,
  Segmented,
  StyledList,
} from "../../ui/primitives.js";
import { ErrorText } from "../../ui/ErrorText.js";
import { ConfirmButton } from "../../ui/ConfirmButton.js";

// Hermes review relay (src/services/hermes-review.ts): lets an agent's
// `request_review` ask the Mullion server to POST a review request straight to
// the Hermes API instead of going through a GitHub workflow. The URL/model/
// prompt repo are ordinary settings; the API key is write-only and never
// round-trips through this client (same shape as the GitHub token input), so
// it is managed here with its own fetch rather than through the settings store.

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
function CooldownField({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(value);
  return (
    <NumberField
      value={draft}
      onChange={setDraft}
      onCommit={onCommit}
      min={0}
      max={1440}
      suffix="minutes"
    />
  );
}

// A run Hermes can still be asked to stop.
const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);

// Runs this Mullion dispatched (in memory server-side, so a restart empties the
// list). Loaded once and on demand — a review takes minutes, so no polling.
function RecentReviews() {
  const [runs, setRuns] = useState<ReviewRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchRuns = () =>
    api
      .listReviews()
      .then((r) => {
        setRuns(r.runs);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Could not load recent reviews");
      });

  // setState only happens in the promise callbacks, never synchronously in the
  // effect body.
  useEffect(() => {
    void fetchRuns();
  }, []);

  const load = () => {
    setLoading(true);
    return fetchRuns().finally(() => setLoading(false));
  };

  const stop = (runId: string) =>
    api
      .stopReview(runId)
      .then(load)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Could not stop the review");
      });

  return (
    <div style={{ marginTop: 16 }} data-testid="review-relay-recent">
      <GroupHeading
        title="Recent reviews"
        desc="Review runs requested from this Mullion since it last started. Stop cancels a run that is stuck or was requested by mistake."
      />
      {runs && runs.length === 0 && (
        <div style={{ opacity: 0.7, fontSize: 12 }}>No reviews requested yet.</div>
      )}
      {runs && runs.length > 0 && (
        <StyledList>
          {runs.map((run) => (
            <ListRow
              key={run.runId}
              testId={`review-run-${run.runId}`}
              dot={
                run.status === "completed"
                  ? "on"
                  : ACTIVE_RUN_STATUSES.has(run.status)
                    ? "warn"
                    : "off"
              }
              title={`${run.repo}#${run.number ?? run.prNumber}${
                run.kind === "issue" ? " (issue)" : ""
              }`}
              subtitle={`${run.status} · ${new Date(run.dispatchedAt).toLocaleTimeString()}${
                run.error ? ` · ${run.error}` : ""
              }`}
              trailing={
                ACTIVE_RUN_STATUSES.has(run.status) ? (
                  <ConfirmButton
                    title={`Stop the ${run.kind === "issue" ? "triage" : "review"} of ${
                      run.repo
                    }#${run.number ?? run.prNumber}`}
                    armedLabel="Confirm stop"
                    onConfirm={() => void stop(run.runId)}
                  >
                    Stop
                  </ConfirmButton>
                ) : undefined
              }
            />
          ))}
        </StyledList>
      )}
      <div style={{ marginTop: 8 }}>
        <SecondaryButton onClick={() => void load()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </SecondaryButton>
      </div>
      {error && <ErrorText style={{ marginTop: 8 }}>{error}</ErrorText>}
    </div>
  );
}

export function ReviewRelaySection() {
  const { settings, updateSettings } = useDashboardStore();
  const relay = settings.reviewRelay;
  const [integration, setIntegration] = useState<HermesIntegration | null>(null);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getHermesIntegration()
      .then(setIntegration)
      .catch(() => setIntegration(null));
  }, []);

  const saveKey = () => {
    const k = key.trim();
    if (!k) return;
    setError(null);
    setSaving(true);
    api
      .setHermesKey(k)
      .then((summary) => {
        setIntegration(summary);
        setKey("");
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Could not save the key");
      })
      .finally(() => setSaving(false));
  };

  const clearKey = () => {
    setError(null);
    void api
      .clearHermesKey()
      .then(() => api.getHermesIntegration().then(setIntegration))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  const test = () => {
    setError(null);
    setTestResult(null);
    setTesting(true);
    api
      .testHermesConnection()
      .then(() => setTestResult("Hermes API is reachable"))
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Connection test failed");
      })
      .finally(() => setTesting(false));
  };

  const ready = relay.apiUrl !== "" && !!integration?.hasKey;

  const providerRow = (
    <Row
      label="Reviewer"
      desc="Who handles review requests from agents (mullion review / request_review)."
    >
      <Segmented
        options={[
          { value: "none", label: "None" },
          { value: "hermes", label: "Hermes" },
        ]}
        value={relay.provider}
        onChange={(v) => {
          setError(null);
          setTestResult(null);
          updateSettings({ reviewRelay: { provider: v } });
        }}
      />
    </Row>
  );

  return (
    <div style={{ marginTop: 24 }} data-testid="review-relay-section">
      <GroupHeading
        title="Review relay"
        desc="Let agents request a pull request review from a reviewer bot with its own GitHub identity, instead of through a GitHub workflow. Agents never see the API key."
      />
      {providerRow}
      {relay.provider === "none" ? (
        <div style={{ opacity: 0.7, fontSize: 12 }} data-testid="review-relay-none">
          Agents cannot request reviews through Mullion; reviews come from your repository&apos;s
          own workflow.
        </div>
      ) : (
        <>
          <StyledList>
            <ListRow
              testId="review-relay-row"
              dot={ready ? "on" : "off"}
              title={ready ? "Review relay ready" : "Review relay not configured"}
              subtitle={integration?.hasKey ? "API key set" : "Set the API URL and API key below"}
              trailing={
                integration?.hasKey ? (
                  <SecondaryButton onClick={clearKey}>Clear key</SecondaryButton>
                ) : undefined
              }
            />
          </StyledList>

          <TextSettingRow
            label="API URL"
            desc="Base URL of the Hermes API server (a review-bot profile whose GitHub App can post reviews)."
            key={relay.apiUrl}
            value={relay.apiUrl}
            placeholder="http://hermes.local:8643"
            onCommit={(v) => updateSettings({ reviewRelay: { apiUrl: v } })}
          />
          <TextSettingRow
            label="Model"
            desc="The model name the API server advertises."
            key={relay.model}
            value={relay.model}
            width={180}
            onCommit={(v) => updateSettings({ reviewRelay: { model: v } })}
          />
          <TextSettingRow
            label="Prompt repository"
            desc="Optional. Public owner/repo holding a custom review prompt; leave empty for Mullion's built-in prompt."
            key={relay.promptRepo}
            value={relay.promptRepo}
            placeholder="owner/repo"
            width={220}
            onCommit={(v) => updateSettings({ reviewRelay: { promptRepo: v } })}
          />
          <TextSettingRow
            label="Prompt path"
            desc="Path of the review prompt inside that repository."
            key={relay.promptPath}
            value={relay.promptPath}
            onCommit={(v) => updateSettings({ reviewRelay: { promptPath: v } })}
          />
          <TextSettingRow
            label="Triage prompt repository"
            desc="Optional. Public owner/repo holding a custom issue-triage prompt; leave empty for Mullion's built-in triage prompt."
            key={relay.triagePromptRepo}
            value={relay.triagePromptRepo}
            placeholder="owner/repo"
            width={220}
            onCommit={(v) => updateSettings({ reviewRelay: { triagePromptRepo: v } })}
          />
          <TextSettingRow
            label="Triage prompt path"
            desc="Path of the issue-triage prompt inside that repository."
            key={relay.triagePromptPath}
            value={relay.triagePromptPath}
            onCommit={(v) => updateSettings({ reviewRelay: { triagePromptPath: v } })}
          />
          <Row
            label="Cooldown"
            desc="Minimum time between two requests for the same target — the same commit for a review, the same issue for a triage."
          >
            <CooldownField
              key={relay.cooldownMinutes}
              value={relay.cooldownMinutes}
              onCommit={(v) => updateSettings({ reviewRelay: { cooldownMinutes: v } })}
            />
          </Row>
          <Row
            label="API key"
            desc="Stored encrypted on the server; never shown again."
            align="start"
          >
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div className="settings-numberfield" style={{ width: 260 }}>
                <input
                  type="password"
                  autoComplete="off"
                  style={{ flex: 1, textAlign: "left", width: "auto" }}
                  placeholder={integration?.hasKey ? "Replace key…" : "Hermes API key"}
                  value={key}
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
          <div style={{ marginTop: 10 }}>
            <SecondaryButton onClick={test} disabled={testing || relay.apiUrl === ""}>
              {testing ? "Testing…" : "Test connection"}
            </SecondaryButton>
            {testResult && (
              <span style={{ marginLeft: 10, fontSize: 11.5, color: "var(--dim)" }}>
                {testResult}
              </span>
            )}
          </div>
          {error && <ErrorText style={{ marginTop: 8 }}>{error}</ErrorText>}
          {ready && <RecentReviews />}
        </>
      )}
    </div>
  );
}
