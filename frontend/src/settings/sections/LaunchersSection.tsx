import { useEffect, useState } from "react";
import { useDashboardStore } from "../../store.js";
import { api, normalizeAgentId } from "../../api.js";
import type { Agent } from "../../api.js";
import { resolveAgentLogo } from "../../cliLogos.js";
import { RefreshIcon } from "../../icons.js";
import { Dropdown, Eyebrow, Row, SecondaryButton, Toggle } from "../../ui/primitives.js";

const SHELL_OPTIONS = [
  { value: "zsh", label: "zsh" },
  { value: "bash", label: "bash" },
  { value: "fish", label: "fish" },
];

const AGENT_OPTIONS = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "codex" },
  { value: "opencode", label: "opencode" },
  // Rich statuses (issue: extend surfaced session statuses) — was missing
  // entirely, so agy could never be picked as the launcher's default agent
  // even though agent-detect.ts's KNOWN_AGENTS and its own hook adapter have
  // supported it since PR #301.
  { value: "agy", label: "agy" },
];

export function LaunchersSection() {
  const { settings, updateSettings, theme } = useDashboardStore();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [crsConfigDir, setCrsConfigDir] = useState<string | null>(null);
  const [skipPermissionFlags, setSkipPermissionFlags] = useState<Record<string, string>>({});

  useEffect(() => {
    api
      .listAgents()
      .then(setAgents)
      .finally(() => setLoading(false));
    api
      .getServerInfo()
      .then((info) => setCrsConfigDir(info.crsConfigDir))
      .catch(() => setCrsConfigDir(null));
    api
      .getSkipPermissionFlags()
      .then(setSkipPermissionFlags)
      .catch(() => {});
  }, []);

  const refresh = () => {
    setLoading(true);
    api
      .listAgents(true)
      .then(setAgents)
      .finally(() => setLoading(false));
  };

  // No in-browser filesystem access to actually open .crs/actions.json (see
  // the plan's "drop Reveal" decision for the sibling Projects section) —
  // copying the resolved path to the clipboard is the closest reasonable
  // adaptation of the reference's "Manage" button.
  const manageGlobalLaunchers = () => {
    void navigator.clipboard
      ?.writeText(`${crsConfigDir ?? "~/.config/crs"}/actions.json`)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };

  return (
    <>
      <Row label="Detected CLIs" desc="Shells & agents found on PATH.">
        <SecondaryButton onClick={refresh} disabled={loading} icon={<RefreshIcon size={12} />}>
          Refresh
        </SecondaryButton>
      </Row>
      <div className="settings-launcher-table">
        <div className="settings-launcher-head">
          <span />
          <span />
          <span>Launcher</span>
          <span>Config</span>
          <span className="settings-launcher-col-center">Skip perms</span>
          <span className="settings-launcher-col-center">Status</span>
          <span className="settings-launcher-col-center">Show</span>
        </div>
        {(["shell", "agent"] as const).map((kind) => {
          const rows = agents.filter((a) => a.kind === kind);
          if (rows.length === 0) return null;
          return (
            <div key={kind}>
              <Eyebrow title={kind === "shell" ? "Shells" : "AI agents"} />
              {rows.map((a) => {
                const agentId = normalizeAgentId(a.id);
                const logo = a.kind === "agent" ? resolveAgentLogo(agentId, theme) : null;
                const hidden = settings.launchers.hiddenAgents.includes(agentId);
                const hookTrustPending = a.hookTrust === "pending";
                const skipFlag = skipPermissionFlags[agentId];
                const configText =
                  (hookTrustPending
                    ? "Hook trust pending — run /hooks in a Codex session to enable structured events"
                    : a.available
                      ? (a.path ?? "")
                      : "not found on PATH") + (skipFlag ? `  •  ${skipFlag}` : "");
                return (
                  <div
                    key={a.id}
                    className={`settings-launcher-row${a.available ? "" : " unavailable"}`}
                    data-testid={`launcher-row-${agentId}`}
                  >
                    <span className="settings-launcher-icon">
                      {logo && <img src={logo} alt="" width={16} height={16} />}
                    </span>
                    <span className={`settings-status-dot${a.available ? "" : " off"}`} />
                    <span className="settings-launcher-name" title={a.title}>
                      {a.title}
                    </span>
                    <span className="settings-launcher-config" title={configText}>
                      {configText}
                    </span>
                    <span className="settings-launcher-cell">
                      {a.kind === "agent" && skipFlag && (
                        <Toggle
                          on={settings.launchers.skipPermissionsAgents?.includes(agentId) ?? false}
                          size="small"
                          ariaLabel={`Skip permissions for ${a.title}`}
                          onChange={() => {
                            const current = settings.launchers.skipPermissionsAgents ?? [];
                            const next = current.includes(agentId)
                              ? current.filter((id) => id !== agentId)
                              : [...current, agentId];
                            updateSettings({ launchers: { skipPermissionsAgents: next } });
                          }}
                        />
                      )}
                    </span>
                    <span
                      className={`settings-launcher-status${a.available ? " available" : " unavailable"}`}
                    >
                      {hookTrustPending ? (
                        <span className="hook-trust-badge">trust pending</span>
                      ) : a.available ? (
                        "available"
                      ) : (
                        "unavailable"
                      )}
                    </span>
                    <span className="settings-launcher-cell">
                      {a.kind === "agent" && (
                        <Toggle
                          on={!hidden}
                          size="small"
                          ariaLabel={`Show ${a.title} in launcher`}
                          onChange={() => {
                            const next = hidden
                              ? settings.launchers.hiddenAgents.filter((id) => id !== agentId)
                              : [...settings.launchers.hiddenAgents, agentId];
                            updateSettings({ launchers: { hiddenAgents: next } });
                          }}
                        />
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <Row label="Default shell" desc={'Used by a plain "new session".'}>
        <Dropdown
          value={settings.launchers.defaultShell}
          onChange={(v) => updateSettings({ launchers: { defaultShell: v } })}
          options={SHELL_OPTIONS}
        />
      </Row>
      <Row label="Default agent" desc="Pre-selected in the launcher.">
        <Dropdown
          value={settings.launchers.defaultAgent}
          onChange={(v) => updateSettings({ launchers: { defaultAgent: v } })}
          options={AGENT_OPTIONS}
        />
      </Row>
      <Row label="Global launchers" desc=".crs/actions.json">
        <SecondaryButton onClick={manageGlobalLaunchers}>
          {copied ? "Copied path" : "Manage"}
        </SecondaryButton>
      </Row>
    </>
  );
}
