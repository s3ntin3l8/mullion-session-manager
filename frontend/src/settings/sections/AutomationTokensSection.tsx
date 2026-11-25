import { useEffect, useState } from "react";
import { api } from "../../api/index.js";
import type {
  AutomationTokenCreated,
  AutomationTokenState,
  AutomationTokenSummary,
} from "../../api/index.js";
import { formatRelativeAge, formatRelativeUntil } from "../../relativeTime.js";
import { HostsIcon, PlusIcon } from "../../ui/icons.js";
import { GroupHeading, ListRow, SecondaryButton, StyledList } from "../../ui/primitives.js";
import { ErrorText } from "../../ui/ErrorText.js";

const LIFETIME_OPTIONS = [
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 365, label: "365 days" },
] as const;

const STATE_COLOR: Record<AutomationTokenState, string> = {
  active: "var(--g)",
  expired: "var(--dim)",
  revoked: "var(--dim)",
};

export function AutomationTokensSection() {
  const [tokens, setTokens] = useState<AutomationTokenSummary[]>([]);
  const [created, setCreated] = useState<AutomationTokenCreated | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [enrollScope, setEnrollScope] = useState(true);
  const [repairScope, setRepairScope] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState<number>(90);
  const [allowedCidrs, setAllowedCidrs] = useState("");
  const [requireApproval, setRequireApproval] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () => {
    api
      .listAutomationTokens()
      .then((rows) => setTokens(rows))
      .catch(() => undefined);
  };

  useEffect(() => {
    load();
  }, []);

  const resetForm = () => {
    setLabel("");
    setEnrollScope(true);
    setRepairScope(false);
    setExpiresInDays(90);
    setAllowedCidrs("");
    setRequireApproval(false);
  };

  const handleCreate = (event: React.FormEvent) => {
    event.preventDefault();
    const scopes: ("enroll" | "repair")[] = [];
    if (enrollScope) scopes.push("enroll");
    if (repairScope) scopes.push("repair");
    if (!label.trim()) {
      setError("Label is required.");
      return;
    }
    if (scopes.length === 0) {
      setError("Select at least one scope.");
      return;
    }
    setBusy(true);
    setError(null);
    api
      .createAutomationToken({
        label: label.trim(),
        scopes,
        expiresInDays,
        allowedCidrs: allowedCidrs.trim() || null,
        requireApproval,
      })
      .then((res) => {
        setCreated(res);
        setFormOpen(false);
        resetForm();
        load();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Could not create automation token.");
      })
      .finally(() => setBusy(false));
  };

  const handleRevoke = (id: string) => {
    setError(null);
    api
      .revokeAutomationToken(id)
      .then(() => {
        if (created?.id === id) setCreated(null);
        load();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Could not revoke automation token.");
      });
  };

  const handleCopy = (value: string) => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  return (
    <>
      <GroupHeading
        title="Automation tokens"
        desc="Scoped bearer tokens (for Ansible or CI) that can only mint one-off pairing codes on POST /api/host-pairings."
      />
      <div data-testid="automation-tokens">
        {!formOpen && (
          <button
            type="button"
            className="settings-add-btn"
            onClick={() => {
              setError(null);
              setFormOpen(true);
            }}
          >
            <PlusIcon size={13} />
            Create automation token
          </button>
        )}

        {formOpen && (
          <form
            onSubmit={handleCreate}
            data-testid="automation-token-form"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              padding: 12,
              border: "1px solid var(--border)",
              borderRadius: 6,
              marginBottom: 10,
            }}
          >
            <label
              style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.75rem" }}
            >
              <span>Label</span>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. ansible-prod"
                disabled={busy}
              />
            </label>

            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: "0.75rem" }}>
              <span style={{ color: "var(--dim)" }}>Scopes:</span>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={enrollScope}
                  onChange={(e) => setEnrollScope(e.target.checked)}
                  disabled={busy}
                />
                enroll (new hosts)
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={repairScope}
                  onChange={(e) => setRepairScope(e.target.checked)}
                  disabled={busy}
                />
                repair (existing hosts)
              </label>
            </div>

            <label
              style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.75rem" }}
            >
              <span>Lifetime</span>
              <select
                aria-label="Lifetime"
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(Number(e.target.value))}
                disabled={busy}
              >
                {LIFETIME_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>

            <label
              style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.75rem" }}
            >
              <span>Allowed CIDRs (optional)</span>
              <input
                type="text"
                value={allowedCidrs}
                onChange={(e) => setAllowedCidrs(e.target.value)}
                placeholder="e.g. 10.0.0.0/8, 192.168.1.0/24"
                disabled={busy}
              />
            </label>

            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: "0.75rem" }}>
              <input
                type="checkbox"
                checked={requireApproval}
                onChange={(e) => setRequireApproval(e.target.checked)}
                disabled={busy}
              />
              Require operator approval for minted hosts
            </label>

            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" className="settings-secondary-btn" disabled={busy}>
                {busy ? "Creating…" : "Create token"}
              </button>
              <SecondaryButton
                disabled={busy}
                onClick={() => {
                  setFormOpen(false);
                  setError(null);
                }}
              >
                Cancel
              </SecondaryButton>
            </div>
          </form>
        )}
      </div>

      {error && <ErrorText style={{ marginTop: 8 }}>{error}</ErrorText>}

      {created && (
        <div
          className="settings-cascade-warning"
          data-testid="automation-token-created"
          style={{ marginTop: 10 }}
        >
          <div
            style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0, width: "100%" }}
          >
            <div style={{ fontSize: "0.75rem", fontWeight: 500 }}>
              Token for <strong>{created.label}</strong> — copy it now; it will not be shown again.
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <code
                data-testid="automation-token-secret"
                style={{ flex: 1, overflowWrap: "anywhere", fontSize: "0.6875rem" }}
              >
                {created.token}
              </code>
              <SecondaryButton onClick={() => handleCopy(created.token)}>
                {copied ? "Copied" : "Copy"}
              </SecondaryButton>
              <SecondaryButton onClick={() => setCreated(null)}>Dismiss</SecondaryButton>
            </div>
          </div>
        </div>
      )}

      {tokens.length > 0 && (
        <StyledList>
          {tokens.map((t) => {
            const lastUsed = t.last_used_at
              ? `last used ${formatRelativeAge(Date.parse(t.last_used_at))}`
              : "never used";
            const expiryText =
              t.state === "revoked"
                ? "revoked"
                : t.state === "expired"
                  ? "expired"
                  : `expires ${formatRelativeUntil(Date.parse(t.expires_at))}`;
            const details = [
              `scopes: ${t.scopes.join(", ")}`,
              lastUsed,
              expiryText,
              t.allowed_cidrs ? `CIDRs: ${t.allowed_cidrs}` : null,
              t.require_approval ? "approval required" : null,
            ]
              .filter((part): part is string => part !== null)
              .join(" · ");
            return (
              <ListRow
                key={t.id}
                testId={`automation-token-row-${t.id}`}
                icon={<HostsIcon size={15} />}
                dot={t.state === "active" ? "on" : undefined}
                title={t.label}
                subtitle={details}
                trailing={
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      data-testid={`automation-token-state-${t.id}`}
                      style={{ fontSize: "0.65625rem", color: STATE_COLOR[t.state] }}
                    >
                      {t.state}
                    </span>
                    {t.state === "active" && (
                      <SecondaryButton onClick={() => handleRevoke(t.id)}>Revoke</SecondaryButton>
                    )}
                  </div>
                }
              />
            );
          })}
        </StyledList>
      )}
    </>
  );
}
