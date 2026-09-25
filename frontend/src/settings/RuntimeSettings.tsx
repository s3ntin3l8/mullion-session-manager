import { useDashboardStore, FALLBACK_RUNTIME_ENV } from "../store/index.js";
import { LOG_LEVELS, type LogLevel } from "../api/index.js";
import { Dropdown, GroupHeading, Row } from "../ui/primitives.js";
import { ServerDefaultNumberRow } from "./ServerDefaultNumberRow.js";
import { useServerInfo } from "./useServerInfo.js";

// Settings that override a server env default at runtime (the backend's
// services/runtime-config.ts). Each stores -1 / "inherit" for "use the
// server default".

export function GitHubPollingSettings() {
  const { settings, updateSettings } = useDashboardStore();
  const env = useServerInfo()?.runtimeEnv ?? FALLBACK_RUNTIME_ENV;
  const g = settings.github;
  return (
    <div style={{ marginTop: 24 }}>
      <GroupHeading
        title="Update checks"
        desc="How often Mullion checks GitHub for pull request and CI changes. Webhooks, when on, deliver changes sooner."
      />
      <ServerDefaultNumberRow
        label="Active repositories"
        desc="Repositories with open pull requests or running CI."
        value={g.pollActiveSeconds}
        serverDefault={env.githubPollActiveSeconds}
        min={5}
        max={3600}
        suffix="seconds"
        onChange={(v) => updateSettings({ github: { pollActiveSeconds: v } })}
      />
      <ServerDefaultNumberRow
        label="Quiet repositories"
        desc="Repositories with nothing in progress."
        value={g.pollQuietSeconds}
        serverDefault={env.githubPollQuietSeconds}
        min={5}
        max={3600}
        suffix="seconds"
        onChange={(v) => updateSettings({ github: { pollQuietSeconds: v } })}
      />
      <ServerDefaultNumberRow
        label="Webhook silence limit"
        desc="Check more often when no webhook has arrived for this long."
        value={g.pollStaleThresholdSeconds}
        serverDefault={env.githubPollStaleThresholdSeconds}
        min={30}
        max={86400}
        width={62}
        suffix="seconds"
        onChange={(v) => updateSettings({ github: { pollStaleThresholdSeconds: v } })}
      />
    </div>
  );
}

export function HostHeartbeatSetting() {
  const { settings, updateSettings } = useDashboardStore();
  const env = useServerInfo()?.runtimeEnv ?? FALLBACK_RUNTIME_ENV;
  return (
    <ServerDefaultNumberRow
      label="Health check interval"
      desc="How often remote hosts are checked for online status. 0 turns checks off."
      value={settings.hosts.heartbeatSeconds}
      serverDefault={env.hostHeartbeatSeconds}
      min={0}
      max={3600}
      suffix="seconds"
      onChange={(v) => updateSettings({ hosts: { heartbeatSeconds: v } })}
    />
  );
}

function RestartRequiredHint() {
  return (
    <div className="settings-footer-note" style={{ marginTop: 0, marginBottom: 12 }}>
      Restart required: this change takes effect the next time the Mullion server restarts.
    </div>
  );
}

// Boot-time settings (read once while the server starts). A saved value that
// resolves differently from what the server booted with needs a restart.
export function BrowserPoolSizeSetting() {
  const { settings, updateSettings } = useDashboardStore();
  const info = useServerInfo();
  const env = info?.runtimeEnv ?? FALLBACK_RUNTIME_ENV;
  const saved = settings.browser.maxInstances;
  const effective = Math.max(1, saved === -1 ? env.browserMaxInstances : saved);
  const pending = info !== null && effective !== info.running.browserMaxInstances;
  return (
    <>
      <ServerDefaultNumberRow
        label="Browser pool size"
        desc="Most browsers running at once, one per project. Each one uses memory even when idle. Takes effect after a server restart."
        value={saved}
        serverDefault={env.browserMaxInstances}
        min={1}
        max={32}
        suffix="browsers"
        width={62}
        onChange={(v) => updateSettings({ browser: { maxInstances: v } })}
      />
      {pending && <RestartRequiredHint />}
    </>
  );
}

export function DeviceDiscoverySetting() {
  const { settings, updateSettings } = useDashboardStore();
  const info = useServerInfo();
  const env = info?.runtimeEnv ?? FALLBACK_RUNTIME_ENV;
  const saved = settings.devices.discoveryEnabled;
  const effective = saved === "inherit" ? env.deviceDiscoveryEnabled : saved === "on";
  const pending = info !== null && effective !== info.running.deviceDiscoveryEnabled;
  return (
    <>
      <Row
        label="Find phones on the network"
        desc="Lists phones that have wireless debugging on, so you can pair without typing an address. Takes effect after a server restart."
      >
        <Dropdown<"inherit" | "on" | "off">
          value={saved}
          onChange={(v) => updateSettings({ devices: { discoveryEnabled: v } })}
          options={[
            {
              value: "inherit",
              label: `Server default (${env.deviceDiscoveryEnabled ? "On" : "Off"})`,
            },
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
        />
      </Row>
      {pending && <RestartRequiredHint />}
    </>
  );
}

export function BrowserFramerateSetting() {
  const { settings, updateSettings } = useDashboardStore();
  const info = useServerInfo();
  const env = info?.runtimeEnv ?? FALLBACK_RUNTIME_ENV;
  return (
    <>
      {info && !info.features.browser && (
        <div className="settings-footer-note" style={{ marginTop: 0, marginBottom: 12 }}>
          The browser pane is turned off on this server. The server administrator can enable it.
        </div>
      )}
      <ServerDefaultNumberRow
        label="Stream frame rate"
        desc="Frames per second for the browser pane. Higher is smoother but uses more bandwidth. Applies to newly opened panes for projects on this machine."
        value={settings.browser.framerate}
        serverDefault={env.browserFramerate}
        min={1}
        max={30}
        suffix="fps"
        onChange={(v) => updateSettings({ browser: { framerate: v } })}
      />
    </>
  );
}

const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
  fatal: "Fatal",
  error: "Error",
  warn: "Warning",
  info: "Info",
  debug: "Debug",
  trace: "Trace",
};

export function LogLevelSetting() {
  const { settings, updateSettings } = useDashboardStore();
  const env = useServerInfo()?.runtimeEnv ?? FALLBACK_RUNTIME_ENV;
  return (
    <Row
      label="Log level"
      desc="How much detail the server writes to its log. Takes effect immediately."
    >
      <Dropdown<"inherit" | LogLevel>
        value={settings.server.logLevel}
        onChange={(v) => updateSettings({ server: { logLevel: v } })}
        options={[
          { value: "inherit", label: `Server default (${LOG_LEVEL_LABELS[env.logLevel]})` },
          ...LOG_LEVELS.map((level) => ({ value: level, label: LOG_LEVEL_LABELS[level] })),
        ]}
      />
    </Row>
  );
}
