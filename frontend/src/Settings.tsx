import { useEffect, useState } from "react";
import { useDashboardStore } from "./store.js";
import { api } from "./api.js";
import type { Agent, ServerInfo } from "./api.js";
import { CloseIcon, MoonIcon, RefreshIcon, SunIcon } from "./icons.js";

export type SettingsSection =
  "appearance" | "terminal" | "projects" | "launchers" | "notifications" | "sessions" | "server";

const SECTIONS: Array<{ id: SettingsSection; title: string; desc: string }> = [
  { id: "appearance", title: "Appearance", desc: "Theme, terminal fonts, colors, and cursor." },
  {
    id: "terminal",
    title: "Terminal behavior",
    desc: "Scrollback, clipboard, reconnect, and key capture.",
  },
  { id: "projects", title: "Projects & discovery", desc: "Where cmux scans for repositories." },
  { id: "launchers", title: "Launchers & agents", desc: "Detected CLIs and session defaults." },
  {
    id: "notifications",
    title: "Notifications & status",
    desc: "Attention alerts and how they reach you.",
  },
  { id: "sessions", title: "Session management", desc: "Naming, confirmations, and cleanup." },
  { id: "server", title: "Server info", desc: "Read-only deployment diagnostics." },
];

// Ported 1:1 from the design's settings modal: a left nav of 7 sections, a
// scrollable content pane on the right. Per the plan's honest v1/v2 split —
// Appearance/Terminal/Sessions/Notifications are real, wired, client-only
// prefs; Projects/Launchers are read-only displays of server-side config
// (editing PROJECTS_ROOTS/global launchers from the browser is out of scope
// for this pass); Server info is a read-only diagnostics panel.
//
// No `open` prop — same reason as CommandPalette (App.tsx only mounts this
// while open, so `initialSection` is read once via a lazy useState
// initializer rather than synced in via an effect, e.g. so the discovery
// empty state's "Configure search roots" button can force-open straight to
// the Projects tab).
export function Settings({
  onClose,
  initialSection = "appearance",
}: {
  onClose: () => void;
  initialSection?: SettingsSection;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const meta = SECTIONS.find((s) => s.id === section)!;

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-modal-header">
          <span className="settings-modal-title">Settings</span>
          <button className="settings-modal-close" style={{ marginLeft: "auto" }} onClick={onClose}>
            <CloseIcon size={15} />
          </button>
        </div>
        <div className="settings-modal-body">
          <div className="settings-nav">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                className={`settings-nav-item${s.id === section ? " active" : ""}`}
                onClick={() => setSection(s.id)}
              >
                {s.title}
              </button>
            ))}
          </div>
          <div className="settings-content">
            <div className="settings-content-header">
              <div className="settings-content-title">{meta.title}</div>
              <div className="settings-content-desc">{meta.desc}</div>
            </div>
            <div className="cmux-scroll settings-content-body">
              {section === "appearance" && <AppearanceSection />}
              {section === "terminal" && <TerminalSection />}
              {section === "projects" && <ProjectsSection />}
              {section === "launchers" && <LaunchersSection />}
              {section === "notifications" && <NotificationsSection />}
              {section === "sessions" && <SessionsSection />}
              {section === "server" && <ServerInfoSection />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`settings-toggle${on ? " on" : ""}`} onClick={() => onChange(!on)}>
      <span className="settings-toggle-knob" />
    </button>
  );
}

function Row({
  label,
  desc,
  children,
}: {
  label: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-row">
      <div>
        <div className="settings-row-label">{label}</div>
        {desc && <div className="settings-row-desc">{desc}</div>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function AppearanceSection() {
  const { theme, toggleTheme, terminalPrefs, setTerminalPrefs } = useDashboardStore();
  return (
    <>
      <Row label="Theme" desc="Dark is the default; light overrides every color token.">
        <button onClick={toggleTheme} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {theme === "dark" ? <MoonIcon size={14} /> : <SunIcon size={14} />}
          {theme === "dark" ? "Dark" : "Light"}
        </button>
      </Row>
      <Row label="Terminal font size">
        <select
          value={terminalPrefs.fontSize}
          onChange={(e) => setTerminalPrefs({ fontSize: Number(e.target.value) })}
        >
          {[12, 13, 14, 15, 16, 18].map((size) => (
            <option key={size} value={size}>
              {size}px
            </option>
          ))}
        </select>
      </Row>
      <Row label="Cursor style">
        <select
          value={terminalPrefs.cursorStyle}
          onChange={(e) =>
            setTerminalPrefs({ cursorStyle: e.target.value as "block" | "bar" | "underline" })
          }
        >
          <option value="block">Block</option>
          <option value="bar">Bar</option>
          <option value="underline">Underline</option>
        </select>
      </Row>
    </>
  );
}

function TerminalSection() {
  const { terminalPrefs, setTerminalPrefs } = useDashboardStore();
  return (
    <>
      <Row
        label="Scrollback lines"
        desc="How much history xterm keeps per pane, applied to newly opened panes."
      >
        <select
          value={terminalPrefs.scrollback}
          onChange={(e) => setTerminalPrefs({ scrollback: Number(e.target.value) })}
        >
          {[500, 1000, 5000, 10000].map((n) => (
            <option key={n} value={n}>
              {n.toLocaleString()}
            </option>
          ))}
        </select>
      </Row>
      <Row
        label="Auto-reconnect on drop"
        desc="Capped exponential backoff (500ms–8s, 6 attempts) — always on."
      >
        <Toggle on={true} onChange={() => {}} />
      </Row>
      <Row
        label="Capture Ctrl+R/L/K"
        desc="Prevents the browser from intercepting readline reverse-search, clear-screen, and kill-line — always on."
      >
        <Toggle on={true} onChange={() => {}} />
      </Row>
    </>
  );
}

function ProjectsSection() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  useEffect(() => {
    api
      .getServerInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);
  return (
    <>
      <Row
        label="Project roots (PROJECTS_ROOTS)"
        desc="Scanned for GET /api/projects/discover. Deploy-time config; editing here isn't wired up yet."
      >
        <span className="settings-readonly-value">{info?.projectsRoots || "(empty)"}</span>
      </Row>
      <Row
        label="Global config dir (CRS_CONFIG_DIR)"
        desc="Global launcher/dock defaults; a project's own .crs/ always wins."
      >
        <span className="settings-readonly-value">{info?.crsConfigDir ?? "…"}</span>
      </Row>
    </>
  );
}

function LaunchersSection() {
  const [agents, setAgents] = useState<Agent[]>([]);
  // Starts true (the mount effect below is already fetching) instead of
  // being flipped to true synchronously from inside that effect.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .listAgents()
      .then(setAgents)
      .finally(() => setLoading(false));
  }, []);

  const refresh = () => {
    setLoading(true);
    api
      .listAgents(true)
      .then(setAgents)
      .finally(() => setLoading(false));
  };

  return (
    <>
      <Row
        label="Detected shells & agents"
        desc="Probed with the same shell/env pty-manager spawns sessions with."
      >
        <button
          onClick={refresh}
          disabled={loading}
          style={{ display: "flex", alignItems: "center", gap: 6 }}
        >
          <RefreshIcon size={12} />
          Refresh
        </button>
      </Row>
      {agents.map((a) => (
        <div key={a.id} className="settings-row">
          <div className="settings-row-label" style={{ fontFamily: "Geist Mono, monospace" }}>
            {a.title}
          </div>
          <span className={`cmd-row-availability${a.available ? " available" : ""}`}>
            <span className="cmd-row-availability-dot" />
            {a.available ? `installed · ${a.path}` : "not installed"}
          </span>
        </div>
      ))}
    </>
  );
}

function NotificationsSection() {
  const { notificationsEnabled, setNotificationsEnabled } = useDashboardStore();
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "denied",
  );

  return (
    <>
      <Row
        label="Attention alerts"
        desc="Browser notification when a session's attention signal (bell/OSC) fires. Requires browser permission."
      >
        <Toggle
          on={notificationsEnabled}
          onChange={(v) => {
            setNotificationsEnabled(v);
            if (v && typeof Notification !== "undefined" && Notification.permission === "default") {
              void Notification.requestPermission().then(setPermission);
            }
          }}
        />
      </Row>
      <Row label="Browser permission" desc="Grant this in your browser's site settings if denied.">
        <span className="settings-readonly-value">{permission}</span>
      </Row>
      <Row label="Idle threshold" desc="Fixed at 2s server-side — not yet user-configurable.">
        <span className="settings-readonly-value">2000ms</span>
      </Row>
    </>
  );
}

function SessionsSection() {
  const { hideEndedSessions, setHideEndedSessions } = useDashboardStore();
  return (
    <>
      <Row
        label="Hide exited/killed sessions"
        desc="Show only active sessions in the Projects tree."
      >
        <Toggle on={hideEndedSessions} onChange={setHideEndedSessions} />
      </Row>
      <Row
        label="Confirm before kill"
        desc="Arm-then-confirm on the overflow menu's Kill session — always on."
      >
        <Toggle on={true} onChange={() => {}} />
      </Row>
    </>
  );
}

function ServerInfoSection() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  useEffect(() => {
    api
      .getServerInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  if (!info) return <div className="settings-readonly-value">Loading…</div>;

  return (
    <>
      <Row label="Version">
        <span className="settings-readonly-value">{info.version}</span>
      </Row>
      <Row label="Environment">
        <span className="settings-readonly-value">{info.nodeEnv}</span>
      </Row>
      <Row label="Port">
        <span className="settings-readonly-value">{info.port}</span>
      </Row>
      <Row label="Encryption at rest">
        <span className="settings-readonly-value">
          {info.encryptionEnabled ? "enabled" : "disabled"}
        </span>
      </Row>
      <Row label="Sessions directory">
        <span className="settings-readonly-value">{info.sessionsDir}</span>
      </Row>
      <Row label="Rate limit">
        <span className="settings-readonly-value">
          {info.rateLimit.max} / {info.rateLimit.window}
        </span>
      </Row>
    </>
  );
}
