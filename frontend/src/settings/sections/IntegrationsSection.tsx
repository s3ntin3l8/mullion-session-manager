import { useEffect, useState } from "react";
import { api, ApiError } from "../../api/index.js";
import type { GitHubAppStatus, GitHubIntegration, SetGitHubAppResult } from "../../api/index.js";
import { GitHubDeviceFlowModal } from "../../GitHubDeviceFlowModal.js";
import { formatRelativeAge } from "../../relativeTime.js";
import { GitHubIcon } from "../../ui/icons.js";
import {
  GroupHeading,
  ListRow,
  Row,
  SecondaryButton,
  StyledList,
  Toggle,
} from "../../ui/primitives.js";
import { ErrorText } from "../../ui/ErrorText.js";
import { BrowserCookiesSection } from "./BrowserCookiesSection.js";

// One credential for the whole install (issue #27), not per-project — see
// src/services/github-integration.ts. Manages its own fetch rather than
// going through useDashboardStore's settings (unlike most other sections):
// the token itself never round-trips through this client at all (the PUT
// body is write-only), so there's nothing here that belongs in the
// settings-patch debounce/merge machinery HostsSection also skips for the
// same reason.
export function IntegrationsSection() {
  const [integration, setIntegration] = useState<GitHubIntegration | null>(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceFlowOpen, setDeviceFlowOpen] = useState(false);

  useEffect(() => {
    api
      .getGitHubIntegration()
      .then(setIntegration)
      .catch(() => setIntegration(null))
      .finally(() => setLoading(false));
  }, []);

  const connect = () => {
    const t = token.trim();
    if (!t) return;
    setError(null);
    setConnecting(true);
    api
      .setGitHubToken(t)
      .then((summary) => {
        setIntegration(summary);
        setToken("");
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Could not connect to GitHub");
      })
      .finally(() => setConnecting(false));
  };

  const disconnect = () => {
    setError(null);
    void api
      .disconnectGitHub()
      .then(() => api.getGitHubIntegration().then(setIntegration))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  return (
    <>
      <GroupHeading
        title="GitHub"
        desc="Connect a GitHub account to see a project's issues, pull requests, and CI status."
      />
      <StyledList>
        <ListRow
          testId="github-integration-row"
          icon={<GitHubIcon size={16} />}
          dot={integration?.connected ? "on" : "off"}
          title={loading ? "Checking…" : (integration?.login ?? "Not connected")}
          subtitle={
            integration?.connected
              ? integration.tokenType === "oauth"
                ? "Connected via device flow"
                : "Connected via personal access token"
              : "No account connected"
          }
          trailing={
            integration?.connected ? (
              <SecondaryButton onClick={disconnect}>Disconnect</SecondaryButton>
            ) : undefined
          }
        />
      </StyledList>

      {!integration?.connected && integration?.deviceFlowAvailable && (
        <div style={{ marginTop: 10 }}>
          <SecondaryButton onClick={() => setDeviceFlowOpen(true)} icon={<GitHubIcon size={13} />}>
            Connect with GitHub
          </SecondaryButton>
        </div>
      )}

      {!integration?.connected && (
        <div style={{ marginTop: 10 }}>
          <Row
            label="Personal access token"
            desc="A fine-grained PAT with read access to Contents, Issues, and Pull requests."
            align="start"
          >
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div className="settings-numberfield" style={{ width: 260 }}>
                <input
                  type="password"
                  autoComplete="off"
                  style={{ flex: 1, textAlign: "left", width: "auto" }}
                  placeholder="github_pat_…"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") connect();
                  }}
                />
              </div>
              <SecondaryButton onClick={connect} disabled={connecting || !token.trim()}>
                {connecting ? "Connecting…" : "Connect"}
              </SecondaryButton>
            </div>
          </Row>
        </div>
      )}

      {error && <ErrorText style={{ marginTop: 8 }}>{error}</ErrorText>}

      {integration && !integration.deviceFlowAvailable && (
        <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 12 }}>
          "Connect with GitHub" (device flow, no PAT needed) becomes available once this server is
          configured with a GitHub OAuth App client id.
        </div>
      )}

      {deviceFlowOpen && (
        <GitHubDeviceFlowModal
          onClose={() => setDeviceFlowOpen(false)}
          onConnected={() => {
            api
              .getGitHubIntegration()
              .then(setIntegration)
              .catch(() => {});
            setDeviceFlowOpen(false);
          }}
        />
      )}

      <WebhooksSection integration={integration} />

      <GitHubAppSection
        githubApp={integration?.githubApp ?? null}
        onChange={() =>
          api
            .getGitHubIntegration()
            .then(setIntegration)
            .catch(() => {})
        }
      />

      <div style={{ marginTop: 24 }}>
        <BrowserCookiesSection />
      </div>
    </>
  );
}

// #489 remaining scope — independent of the PAT/device-flow connection
// above (a GitHub App can be configured with no PAT connected at all, and
// vice versa), so this deliberately does NOT gate on `integration?.connected`
// the way WebhooksSection does. Write-only for the private key, same
// never-echo-secrets shape as the PAT input above — `githubApp.appId` is
// public (a numeric App id), never the key itself.
//
// #514 — unlike the PAT panel above (which keeps hiding its input once
// connected: disconnect-then-reconnect has no downside there, you just
// paste a fresh token), this panel's form stays reachable via a "Rotate
// key" disclosure even while configured. Rotating a GitHub App key has a
// real hazard the PAT doesn't: the old key still works until you delete it
// on GitHub's side, so destroy-then-reconfigure (the PAT's shape) would
// force a window with no App configured at all, and if the replacement key
// turns out to be wrong you've already thrown the working one away. This
// deliberate divergence from the PAT panel's shape is the point, not
// drift.
function GitHubAppSection({
  githubApp,
  onChange,
}: {
  githubApp: GitHubAppStatus | null;
  onChange: () => void;
}) {
  const [appId, setAppId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [result, setResult] = useState<SetGitHubAppResult | null>(null);

  const formOpen = !githubApp?.configured || rotating;

  const startRotate = () => {
    setError(null);
    setResult(null);
    setAppId(githubApp?.appId ?? "");
    setPrivateKey("");
    setRotating(true);
  };

  const cancelRotate = () => {
    setRotating(false);
    setAppId("");
    setPrivateKey("");
    setError(null);
  };

  const configure = () => {
    const id = appId.trim();
    const key = privateKey.trim();
    if (!id || !key) return;
    setError(null);
    setResult(null);
    setSaving(true);
    api
      .setGitHubApp(id, key)
      .then((res) => {
        setAppId("");
        setPrivateKey("");
        setRotating(false);
        setResult(res);
        onChange();
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Could not configure the GitHub App");
      })
      .finally(() => setSaving(false));
  };

  const clear = () => {
    setError(null);
    setResult(null);
    // Hermes review, PR #519: without this, clearing while the rotate form
    // is open left it open afterward — in "Rotate" mode, with the
    // now-cleared App's id still prefilled, for what is now an
    // unconfigured App.
    setRotating(false);
    setAppId("");
    setPrivateKey("");
    void api
      .clearGitHubApp()
      .then(onChange)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  return (
    <div style={{ marginTop: 24 }}>
      <GroupHeading
        title="GitHub App"
        desc="Optional. Scopes both Task Master's own writes (sync, promote, push, issue ingest) and the repo-status widget/PR & CI poller's reads to a short-lived, repo-scoped installation token instead of the shared PAT/OAuth token above. Repos not covered by an installed App fall back to it automatically."
      />
      <StyledList>
        <ListRow
          testId="github-app-row"
          icon={<GitHubIcon size={16} />}
          dot={githubApp?.configured ? "on" : "off"}
          title={
            githubApp?.configured ? (
              // Full, untruncated fingerprint on hover via the native
              // title attribute — the truncated form in the subtitle is
              // enough to eyeball against GitHub's own display, but a real
              // comparison needs the whole value.
              <span title={githubApp.keyFingerprint ?? undefined}>{`App #${githubApp.appId}`}</span>
            ) : (
              "Not configured"
            )
          }
          subtitle={
            githubApp?.configured
              ? [
                  githubApp.installationCount != null
                    ? `Installed on ${githubApp.installationCount} account${githubApp.installationCount === 1 ? "" : "s"}`
                    : "Installation count unavailable",
                  githubApp.keyFingerprint ? `Key ${githubApp.keyFingerprint.slice(0, 12)}…` : null,
                  githubApp.keyRotatedAt
                    ? `set ${formatRelativeAge(new Date(githubApp.keyRotatedAt).getTime())}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "Task Master writes use the shared PAT/OAuth token"
          }
          trailing={
            githubApp?.configured ? (
              <div style={{ display: "flex", gap: 8 }}>
                <SecondaryButton onClick={startRotate} disabled={rotating}>
                  Rotate key
                </SecondaryButton>
                <SecondaryButton onClick={clear}>Clear</SecondaryButton>
              </div>
            ) : undefined
          }
        />
      </StyledList>

      {formOpen && (
        <div style={{ marginTop: 10 }}>
          <Row label="App id" desc="The numeric id from the App's settings page." align="start">
            <div className="settings-numberfield" style={{ width: 260 }}>
              <input
                type="text"
                autoComplete="off"
                inputMode="numeric"
                style={{ flex: 1, textAlign: "left", width: "auto" }}
                placeholder="123456"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
              />
            </div>
          </Row>
          <Row
            label="Private key"
            desc={
              rotating
                ? "The PEM contents of the NEW key. Generate it on GitHub before deleting the old one — GitHub allows several active keys at once, so there's no need to go without a working key in between."
                : "The PEM contents downloaded when the App's key was generated."
            }
            align="start"
          >
            <textarea
              autoComplete="off"
              rows={4}
              style={{ width: 320, fontFamily: "monospace", fontSize: 11.5 }}
              placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;…&#10;-----END RSA PRIVATE KEY-----" // pragma: allowlist secret
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
            />
          </Row>
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <SecondaryButton
              onClick={configure}
              disabled={saving || !appId.trim() || !privateKey.trim()}
            >
              {saving ? "Verifying…" : rotating ? "Rotate" : "Configure"}
            </SecondaryButton>
            {rotating && (
              <SecondaryButton onClick={cancelRotate} disabled={saving}>
                Cancel
              </SecondaryButton>
            )}
          </div>
        </div>
      )}

      {result && (
        <div
          style={{
            fontSize: 12,
            color: result.verified ? "var(--dim)" : "var(--y)",
            marginTop: 8,
          }}
          role={result.verified ? undefined : "alert"}
        >
          {result.verified
            ? `Verified — ${result.appSlug ?? "App"} (key ${result.keyFingerprint.slice(0, 12)}…)`
            : `Saved, but not yet verified against GitHub: ${result.warning ?? "unknown reason"}`}
        </div>
      )}

      {error && <ErrorText style={{ marginTop: 8 }}>{error}</ErrorText>}
    </div>
  );
}

function WebhooksSection({ integration }: { integration: GitHubIntegration | null }) {
  const [webhookStatus, setWebhookStatus] = useState<{
    enabled: boolean;
    reposSucceeded?: number;
    reposFailed?: number;
  } | null>(null);
  const [webhookLoading, setWebhookLoading] = useState(true);
  const [webhookError, setWebhookError] = useState<string | null>(null);

  useEffect(() => {
    if (!integration?.connected) return;
    api
      .getGitHubWebhookStatus()
      .then(setWebhookStatus)
      .catch(() => setWebhookStatus(null))
      .finally(() => setWebhookLoading(false));
  }, [integration?.connected]);

  if (!integration?.connected) return null;

  const toggle = () => {
    setWebhookError(null);
    const nextEnabled = !(webhookStatus?.enabled ?? false);
    setWebhookLoading(true);
    const promise = nextEnabled ? api.enableGitHubWebhooks() : api.disableGitHubWebhooks();
    promise
      .then((result) => {
        if (nextEnabled) {
          setWebhookStatus({
            enabled: true,
            reposSucceeded: (result as { reposSucceeded: number }).reposSucceeded,
            reposFailed: (result as { reposFailed: number }).reposFailed,
          });
        } else {
          setWebhookStatus({ enabled: false });
        }
      })
      .catch((err: unknown) => {
        setWebhookError(err instanceof ApiError ? err.message : "Webhook operation failed");
      })
      .finally(() => setWebhookLoading(false));
  };

  return (
    <>
      <div style={{ marginTop: 24 }}>
        <GroupHeading
          title="Webhooks"
          desc="Receive real-time PR/CI updates from GitHub when events occur."
        />
        <StyledList>
          <ListRow
            icon={<GitHubIcon size={16} />}
            dot={webhookLoading ? undefined : webhookStatus?.enabled ? "on" : "off"}
            title={
              webhookLoading
                ? "Checking…"
                : webhookStatus?.enabled
                  ? "Webhooks enabled"
                  : "Webhooks disabled"
            }
            subtitle={
              webhookStatus?.reposSucceeded != null
                ? `${webhookStatus.reposSucceeded} repo${webhookStatus.reposSucceeded === 1 ? "" : "s"} registered, ${webhookStatus.reposFailed ?? 0} failed`
                : webhookStatus?.enabled
                  ? "Receiving real-time updates"
                  : "Poll for updates manually"
            }
            trailing={<Toggle on={webhookStatus?.enabled ?? false} onChange={toggle} />}
          />
        </StyledList>
      </div>

      {webhookError && <ErrorText style={{ marginTop: 8 }}>{webhookError}</ErrorText>}
    </>
  );
}
