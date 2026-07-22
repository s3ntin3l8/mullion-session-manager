import { Fragment, useEffect, useMemo, useState } from "react";
import { useDashboardStore } from "./store.js";
import { api, ApiError, LOCAL_HOST_ID } from "./api.js";
import type {
  Agent,
  GitHubIntegration,
  Host,
  ServerInfo,
  SoundName,
  UpdateCheckResult,
  UpdateStatus,
} from "./api.js";
import { CreateHostModal } from "./CreateHostModal.js";
import { GitHubDeviceFlowModal } from "./GitHubDeviceFlowModal.js";
import { KebabMenu } from "./KebabMenu.js";
import { formatRelativeAge } from "./relativeTime.js";
import {
  AppearanceIcon,
  BellIcon,
  BoltIcon,
  CloseIcon,
  FolderIcon,
  GitHubIcon,
  HostsIcon,
  LayersIcon,
  PlusIcon,
  RefreshIcon,
  RenameIcon,
  SearchIcon,
  ServerRackIcon,
  TerminalPromptIcon,
} from "./icons.js";
import {
  Dropdown,
  Eyebrow,
  GroupHeading,
  ListRow,
  NumberField,
  Row,
  Segmented,
  SecondaryButton,
  Slider,
  StyledList,
  Toggle,
} from "./settings/primitives.js";
import { resolveAgentLogo } from "./cliLogos.js";
import { SwatchGrid, TerminalPreview } from "./settings/TerminalPreview.js";

export type SettingsSection =
  | "appearance"
  | "terminal"
  | "projects"
  | "hosts"
  | "launchers"
  | "notifications"
  | "sessions"
  | "integrations"
  | "server";

const SECTIONS: Array<{
  id: SettingsSection;
  title: string;
  desc: string;
  icon: (size: number) => React.ReactNode;
}> = [
  {
    id: "appearance",
    title: "Appearance",
    desc: "Theme, terminal fonts, colors, and cursor.",
    icon: (size) => <AppearanceIcon size={size} />,
  },
  {
    id: "terminal",
    title: "Terminal behavior",
    desc: "Scrollback, clipboard, reconnect, and key capture.",
    icon: (size) => <TerminalPromptIcon size={size} />,
  },
  {
    id: "projects",
    title: "Projects & discovery",
    desc: "Where Tessera scans for repositories.",
    icon: (size) => <FolderIcon size={size} />,
  },
  {
    id: "hosts",
    title: "Hosts",
    desc: "Remote machines Tessera can run sessions on.",
    icon: (size) => <HostsIcon size={size} />,
  },
  {
    id: "launchers",
    title: "Launchers & agents",
    desc: "Detected CLIs and session defaults.",
    icon: (size) => <BoltIcon size={size} />,
  },
  {
    id: "notifications",
    title: "Notifications & status",
    desc: "Attention alerts and how they reach you.",
    icon: (size) => <BellIcon size={size} />,
  },
  {
    id: "sessions",
    title: "Session management",
    desc: "Naming, confirmations, and cleanup.",
    icon: (size) => <LayersIcon size={size} />,
  },
  {
    id: "integrations",
    title: "Integrations",
    desc: "Connect external services like GitHub.",
    icon: (size) => <GitHubIcon size={size} />,
  },
  {
    id: "server",
    title: "Server info",
    desc: "Read-only deployment diagnostics.",
    icon: (size) => <ServerRackIcon size={size} />,
  },
];

// A real (not cosmetic) filter over control labels — the nav rail's search
// box (ported from the reference's 1a nav) narrows to sections that
// actually contain a matching control, not just a section whose title
// matches. Kept as a flat static index rather than scraping the rendered
// DOM: simpler, and stays correct even for a section that isn't currently
// mounted.
const SEARCH_INDEX: Array<{ section: SettingsSection; text: string }> = [
  { section: "appearance", text: "theme dark light system" },
  { section: "appearance", text: "terminal font family geist jetbrains ibm plex sf mono menlo" },
  { section: "appearance", text: "font size" },
  { section: "appearance", text: "pane padding margin inset panel edge" },
  { section: "appearance", text: "color scheme tokyo night dracula solarized gruvbox one dark" },
  { section: "appearance", text: "cursor style block bar underline blink" },
  { section: "appearance", text: "sidebar density comfortable compact" },
  { section: "terminal", text: "scrollback lines" },
  { section: "terminal", text: "copy on select clipboard" },
  { section: "terminal", text: "allow programs set clipboard write osc 52" },
  { section: "terminal", text: "paste on right click" },
  { section: "terminal", text: "auto reconnect drop" },
  { section: "terminal", text: "key conflict handling ctrl r l k reverse search clear kill line" },
  { section: "projects", text: "project roots add root directory" },
  { section: "projects", text: "discover now rescan" },
  { section: "projects", text: "global config directory" },
  { section: "hosts", text: "remote host agent register base url token" },
  { section: "hosts", text: "test connection ping online offline" },
  { section: "hosts", text: "cascade delete host projects" },
  { section: "launchers", text: "detected clis shells agents refresh" },
  { section: "launchers", text: "default shell" },
  { section: "launchers", text: "default agent" },
  { section: "launchers", text: "global launchers manage actions.json" },
  { section: "notifications", text: "attention alerts bell osc" },
  { section: "notifications", text: "delivery channels browser sound ping chime blip" },
  { section: "notifications", text: "idle threshold" },
  { section: "notifications", text: "exited session alerts" },
  { section: "sessions", text: "new session name pattern agent project" },
  { section: "sessions", text: "confirm before kill" },
  { section: "sessions", text: "show exited killed sessions" },
  { section: "sessions", text: "auto reconcile interval" },
  { section: "integrations", text: "github personal access token pat connect disconnect" },
  { section: "integrations", text: "issues pull requests actions device flow oauth" },
  { section: "server", text: "version environment port encryption uptime role primary agent" },
  { section: "server", text: "sessions directory database rate limit" },
  { section: "server", text: "updates update now release latest apply auto-update" },
];

const FONT_FAMILY_OPTIONS = [
  { value: "Geist Mono", label: "Geist Mono" },
  { value: "JetBrains Mono", label: "JetBrains Mono" },
  { value: "SF Mono", label: "SF Mono" },
  { value: "Menlo", label: "Menlo" },
  { value: "IBM Plex Mono", label: "IBM Plex Mono" },
];

// Ported 1:1 from the design's settings modal: an accented nav rail (1a's
// visuals) inside a centered modal (1b's shell already in use here) — see
// .claude/plans/i-work-to-rework-delegated-bonbon.md's "Design — the shell"
// section. No `open` prop — App.tsx only mounts this while open, so
// `initialSection` is read once via a lazy useState initializer.
export function Settings({
  onClose,
  initialSection = "appearance",
}: {
  onClose: () => void;
  initialSection?: SettingsSection;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [query, setQuery] = useState("");
  const meta = SECTIONS.find((s) => s.id === section)!;

  const visibleSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS;
    return SECTIONS.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        SEARCH_INDEX.some((entry) => entry.section === s.id && entry.text.includes(q)),
    );
  }, [query]);

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
            <div className="settings-nav-search">
              <SearchIcon size={15} strokeWidth={1.9} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search settings…"
              />
            </div>
            <div className="settings-nav-items">
              {visibleSections.map((s) => (
                <button
                  key={s.id}
                  className={`settings-nav-item${s.id === section ? " active" : ""}`}
                  onClick={() => setSection(s.id)}
                >
                  {s.icon(16)}
                  <span style={{ flex: 1 }}>{s.title}</span>
                </button>
              ))}
              {visibleSections.length === 0 && (
                <div className="settings-nav-empty">No matching settings.</div>
              )}
            </div>
            <div className="settings-nav-footer">
              <span className="settings-nav-footer-badge">
                {(typeof document !== "undefined" && document.title[0]) || "T"}
              </span>
              <span className="settings-nav-footer-text">single-user</span>
            </div>
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
              {section === "hosts" && <HostsSection />}
              {section === "launchers" && <LaunchersSection />}
              {section === "notifications" && <NotificationsSection />}
              {section === "sessions" && <SessionsSection />}
              {section === "integrations" && <IntegrationsSection />}
              {section === "server" && <ServerInfoSection />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AppearanceSection() {
  const { settings, updateSettings, theme } = useDashboardStore();
  const t = settings.terminal;
  return (
    <>
      <Row label="Theme" desc="Tessera is dark-first. System follows your OS." align="start">
        <Segmented
          value={settings.theme}
          onChange={(v) => updateSettings({ theme: v })}
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
            { value: "system", label: "System" },
          ]}
        />
      </Row>
      <Row label="Terminal font" desc="Applies to xterm rendering." align="start">
        <Dropdown
          value={t.fontFamily}
          onChange={(v) => updateSettings({ terminal: { fontFamily: v } })}
          options={FONT_FAMILY_OPTIONS}
        />
      </Row>
      <Row label="Font size" desc="Terminal glyph size in pixels.">
        <Slider
          min={10}
          max={20}
          value={t.fontSize}
          format={(v) => `${v}px`}
          onChange={(v) => updateSettings({ terminal: { fontSize: v } })}
        />
      </Row>
      <Row label="Pane padding" desc="Inset between the panel edge and terminal content.">
        <Slider
          min={0}
          max={16}
          value={t.padding}
          format={(v) => `${v}px`}
          onChange={(v) => updateSettings({ terminal: { padding: v } })}
        />
      </Row>

      <div style={{ paddingTop: 6 }}>
        <GroupHeading title="Color scheme" />
        <SwatchGrid
          value={t.colorScheme}
          onChange={(v) => updateSettings({ terminal: { colorScheme: v } })}
          theme={theme}
        />
        <TerminalPreview
          schemeId={t.colorScheme}
          fontFamily={t.fontFamily}
          fontSize={t.fontSize}
          cursorStyle={t.cursorStyle}
          theme={theme}
        />
      </div>

      <Row label="Cursor style" desc="Shape of the terminal caret.">
        <Segmented
          value={t.cursorStyle}
          onChange={(v) => updateSettings({ terminal: { cursorStyle: v } })}
          options={[
            { value: "block", label: "Block" },
            { value: "bar", label: "Bar" },
            { value: "underline", label: "Underline" },
          ]}
        />
      </Row>
      <Row label="Cursor blink" desc="Blink the caret when a pane is focused.">
        <Toggle
          on={t.cursorBlink}
          onChange={(v) => updateSettings({ terminal: { cursorBlink: v } })}
        />
      </Row>
      <Row label="Sidebar density" desc="Row height for the workspace & project tree.">
        <Segmented
          value={settings.sidebarDensity}
          onChange={(v) => updateSettings({ sidebarDensity: v })}
          options={[
            { value: "comfortable", label: "Comfortable" },
            { value: "compact", label: "Compact" },
          ]}
        />
      </Row>
    </>
  );
}

function TerminalSection() {
  const { settings, updateSettings } = useDashboardStore();
  const t = settings.terminal;
  return (
    <>
      <Row label="Scrollback" desc="Lines of history kept per pane in the browser.">
        <NumberField
          value={t.scrollback}
          min={100}
          max={100000}
          suffix="lines"
          onChange={(v) => updateSettings({ terminal: { scrollback: v } })}
        />
      </Row>
      <Row label="Copy on select" desc="Selecting text copies it to the clipboard.">
        <Toggle
          on={t.copyOnSelect}
          onChange={(v) => updateSettings({ terminal: { copyOnSelect: v } })}
        />
      </Row>
      <Row label="Paste on right-click" desc="Right-click pastes the clipboard into the terminal.">
        <Toggle
          on={t.pasteOnRightClick}
          onChange={(v) => updateSettings({ terminal: { pasteOnRightClick: v } })}
        />
      </Row>
      <Row
        label="Allow programs to set the clipboard"
        desc="Lets the running CLI copy to your clipboard directly (OSC 52) — this is how Claude Code and opencode's own copy commands work."
      >
        <Toggle
          on={t.clipboardWrite}
          onChange={(v) => updateSettings({ terminal: { clipboardWrite: v } })}
        />
      </Row>
      <Row label="Auto-reconnect on drop" desc="Re-attach the socket with exponential backoff.">
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <NumberField
            value={t.reconnect.maxAttempts}
            min={1}
            max={20}
            width={42}
            suffix="max"
            onChange={(v) => updateSettings({ terminal: { reconnect: { maxAttempts: v } } })}
          />
          <Toggle
            on={t.reconnect.enabled}
            onChange={(v) => updateSettings({ terminal: { reconnect: { enabled: v } } })}
          />
        </div>
      </Row>

      <Eyebrow
        title="Key-conflict handling"
        desc="When on, the terminal captures the shortcut instead of the browser."
      />
      <StyledList>
        <ListRow
          title={<span className="settings-kbd-chip">Ctrl + R</span>}
          subtitle="Reverse search"
          trailing={
            <Toggle
              size="small"
              on={t.keyCapture.ctrlR}
              onChange={(v) => updateSettings({ terminal: { keyCapture: { ctrlR: v } } })}
            />
          }
        />
        <ListRow
          title={<span className="settings-kbd-chip">Ctrl + L</span>}
          subtitle="Clear screen"
          trailing={
            <Toggle
              size="small"
              on={t.keyCapture.ctrlL}
              onChange={(v) => updateSettings({ terminal: { keyCapture: { ctrlL: v } } })}
            />
          }
        />
        <ListRow
          title={<span className="settings-kbd-chip">Ctrl + K</span>}
          subtitle="Reserved for command palette"
          trailing={
            <Toggle
              size="small"
              on={t.keyCapture.ctrlK}
              onChange={(v) => updateSettings({ terminal: { keyCapture: { ctrlK: v } } })}
            />
          }
        />
      </StyledList>
    </>
  );
}

function ProjectsSection() {
  const { settings, updateSettings, projects } = useDashboardStore();
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [rescanStatus, setRescanStatus] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);

  useEffect(() => {
    api
      .getServerInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  const roots = settings.projectRoots;
  const [addingRoot, setAddingRoot] = useState(false);
  const [newRootPath, setNewRootPath] = useState("");

  const commitAddRoot = () => {
    const path = newRootPath.trim();
    if (path) updateSettings({ projectRoots: [...roots, path] });
    setNewRootPath("");
    setAddingRoot(false);
  };

  const removeRoot = (path: string) => {
    updateSettings({ projectRoots: roots.filter((r) => r !== path) });
  };

  const rescan = () => {
    setRescanning(true);
    api
      .discoverProjects()
      .then((found) =>
        setRescanStatus(`${found.length} project${found.length === 1 ? "" : "s"} found`),
      )
      .catch(() => setRescanStatus("Rescan failed"))
      .finally(() => setRescanning(false));
  };

  return (
    <>
      <GroupHeading title="Project roots" desc="Directories scanned for auto-discovery." />
      <StyledList>
        {roots.map((root) => (
          <ListRow
            key={root}
            icon={<FolderIcon size={15} />}
            title={
              <span style={{ fontFamily: "Geist Mono, monospace", fontSize: 12.5 }}>{root}</span>
            }
            trailing={
              <span
                onClick={() => removeRoot(root)}
                style={{ cursor: "pointer", display: "flex", color: "var(--dim)" }}
                title="Remove"
              >
                <CloseIcon size={14} />
              </span>
            }
          />
        ))}
        {roots.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--dim)", padding: "4px 2px" }}>
            No roots configured — falling back to the server's PROJECTS_ROOTS env default (
            {info?.projectsRoots || "empty"}).
          </div>
        )}
      </StyledList>
      <div style={{ marginTop: 7 }}>
        {addingRoot ? (
          <div className="settings-numberfield" style={{ width: "100%" }}>
            <input
              autoFocus
              style={{ flex: 1, textAlign: "left", width: "auto" }}
              placeholder="~/work"
              value={newRootPath}
              onChange={(e) => setNewRootPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitAddRoot();
                if (e.key === "Escape") {
                  setNewRootPath("");
                  setAddingRoot(false);
                }
              }}
              onBlur={commitAddRoot}
            />
          </div>
        ) : (
          <button className="settings-add-btn" onClick={() => setAddingRoot(true)}>
            <PlusIcon size={13} />
            Add a root directory
          </button>
        )}
      </div>

      <Row label="Discover now" desc="Re-scan roots for new git repositories.">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {rescanStatus && (
            <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{rescanStatus}</span>
          )}
          <SecondaryButton onClick={rescan} disabled={rescanning} icon={<RefreshIcon size={13} />}>
            Rescan
          </SecondaryButton>
        </div>
      </Row>

      <Row label="Global config directory" desc="Where global launchers & dock defaults live.">
        <span className="settings-readonly-value">{info?.crsConfigDir ?? "…"}</span>
      </Row>

      <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 10 }}>
        {projects.length} project{projects.length === 1 ? "" : "s"} registered in total.
      </div>
    </>
  );
}

// Per-row connection-test state (Settings -> Hosts' "Test connection"
// button) — deliberately not part of the store's `hosts` state: it's
// ephemeral UI feedback from POST /api/hosts/:id/ping, not data about the
// host itself, same reasoning as LaunchersSection's local `copied` flag.
type PingStatus = "unknown" | "checking" | "online" | "offline";

function HostsSection() {
  const { hosts, refreshHosts, createHost, updateHost, deleteHost, pingHost } = useDashboardStore();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Host | null>(null);
  const [pingStatus, setPingStatus] = useState<Record<string, PingStatus>>({});
  // A host that 409s on delete (still owns projects) — offers a cascade
  // retry inline instead of a second confirm dialog, since the backend's
  // own error message already names the project count.
  const [cascadePrompt, setCascadePrompt] = useState<{ id: string; message: string } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Sidebar.tsx's own mount effect already fetches `hosts` in practice
  // (it's always mounted alongside Settings), but relying on that as a
  // hidden cross-file invariant is fragile — a lone Settings render (or a
  // future change to when Sidebar mounts) would otherwise show a stale
  // list until the next mutation. This fetch is cheap; the duplication is
  // an acceptable cost for not coupling this section's correctness to
  // another file's mount order (Hermes review, PR #35).
  useEffect(() => {
    void refreshHosts();
  }, [refreshHosts]);

  const testConnection = (id: string) => {
    setPingStatus((prev) => ({ ...prev, [id]: "checking" }));
    void pingHost(id)
      .then((online) => setPingStatus((prev) => ({ ...prev, [id]: online ? "online" : "offline" })))
      .catch(() => setPingStatus((prev) => ({ ...prev, [id]: "offline" })));
  };

  const handleDelete = (host: Host) => {
    setDeleteError(null);
    void deleteHost(host.id).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      // 409 is src/routes/hosts.ts's HostHasProjectsError (still owns
      // projects) — branching on the status code rather than matching the
      // message text ("...pass ?cascade=true") keeps this from silently
      // breaking if that wording ever changes; anything else (unreachable,
      // 404) surfaces as a plain inline error instead.
      if (err instanceof ApiError && err.statusCode === 409) {
        setCascadePrompt({ id: host.id, message });
      } else {
        setDeleteError(message);
      }
    });
  };

  const confirmCascadeDelete = () => {
    if (!cascadePrompt) return;
    const { id } = cascadePrompt;
    setCascadePrompt(null);
    void deleteHost(id, { cascade: true }).catch((err: unknown) => {
      setDeleteError(err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <>
      <GroupHeading
        title="Registered hosts"
        desc="Remote Tessera agents this dashboard can proxy sessions to."
      />
      <StyledList>
        <ListRow
          icon={<HostsIcon size={15} />}
          dot="on"
          title="This machine"
          subtitle="local"
          trailing={<span style={{ fontSize: 10.5, color: "var(--dim)" }}>always online</span>}
        />
        {hosts
          .filter((h) => h.id !== LOCAL_HOST_ID)
          .map((host) => {
            const status = pingStatus[host.id] ?? "unknown";
            return (
              <ListRow
                key={host.id}
                testId={`host-row-${host.id}`}
                icon={<HostsIcon size={15} />}
                dot={status === "online" ? "on" : status === "offline" ? "off" : undefined}
                title={host.name}
                subtitle={host.baseUrl ?? ""}
                trailing={
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {status !== "unknown" && (
                      <span
                        style={{
                          fontSize: 10.5,
                          color:
                            status === "online"
                              ? "var(--g)"
                              : status === "checking"
                                ? "var(--dim)"
                                : "var(--r)",
                        }}
                      >
                        {status === "checking" ? "testing…" : status}
                      </span>
                    )}
                    <SecondaryButton
                      onClick={() => testConnection(host.id)}
                      disabled={status === "checking"}
                    >
                      Test
                    </SecondaryButton>
                    <KebabMenu
                      title="More…"
                      items={[
                        {
                          key: "edit",
                          label: "Edit",
                          icon: <RenameIcon size={14} style={{ color: "var(--muted)" }} />,
                          onClick: () => setEditing(host),
                        },
                        {
                          key: "delete",
                          label: "Delete host",
                          armLabel: "Click again to delete",
                          icon: <CloseIcon size={14} />,
                          danger: true,
                          confirm: true,
                          onClick: () => handleDelete(host),
                        },
                      ]}
                    />
                  </div>
                }
              />
            );
          })}
      </StyledList>

      {cascadePrompt && (
        <div className="settings-cascade-warning">
          <span>{cascadePrompt.message}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <SecondaryButton onClick={confirmCascadeDelete}>
              Delete host and its projects
            </SecondaryButton>
            <SecondaryButton onClick={() => setCascadePrompt(null)}>Cancel</SecondaryButton>
          </div>
        </div>
      )}
      {deleteError && !cascadePrompt && (
        <div style={{ fontSize: 12, color: "var(--r)", marginTop: 8 }} role="alert">
          {deleteError}
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        <button className="settings-add-btn" onClick={() => setAddOpen(true)}>
          <PlusIcon size={13} />
          Add a host
        </button>
      </div>

      {hosts.filter((h) => h.id !== LOCAL_HOST_ID).length === 0 && (
        <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 10 }}>
          No remote hosts registered — every project runs on this machine until you add one.
        </div>
      )}

      {addOpen && (
        <CreateHostModal
          onClose={() => setAddOpen(false)}
          onSave={(name, baseUrl, token) => createHost(name, baseUrl, token)}
        />
      )}
      {editing && (
        <CreateHostModal
          mode="edit"
          initialName={editing.name}
          initialBaseUrl={editing.baseUrl ?? ""}
          hasToken={editing.hasToken}
          onClose={() => setEditing(null)}
          onSave={(name, baseUrl, token) =>
            updateHost(editing.id, token ? { name, baseUrl, token } : { name, baseUrl })
          }
        />
      )}
    </>
  );
}

const SHELL_OPTIONS = [
  { value: "zsh", label: "zsh" },
  { value: "bash", label: "bash" },
  { value: "fish", label: "fish" },
];

const AGENT_OPTIONS = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "codex" },
  { value: "opencode", label: "opencode" },
];

function LaunchersSection() {
  const { settings, updateSettings, theme } = useDashboardStore();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [crsConfigDir, setCrsConfigDir] = useState<string | null>(null);

  useEffect(() => {
    api
      .listAgents()
      .then(setAgents)
      .finally(() => setLoading(false));
    api
      .getServerInfo()
      .then((info) => setCrsConfigDir(info.crsConfigDir))
      .catch(() => setCrsConfigDir(null));
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
      <StyledList>
        {agents.map((a) => {
          const agentId = a.id.startsWith("agent:") ? a.id.slice(6) : a.id;
          const logo = a.kind === "agent" ? resolveAgentLogo(agentId, theme) : null;
          const hidden = settings.launchers.hiddenAgents.includes(agentId);
          return (
            <ListRow
              key={a.id}
              dot={a.available ? "on" : "off"}
              icon={logo ? <img src={logo} alt="" width={16} height={16} /> : undefined}
              title={<span style={{ width: 96, display: "inline-block" }}>{a.title}</span>}
              subtitle={a.available ? (a.path ?? "") : "not found on PATH"}
              unavailable={!a.available}
              trailing={
                a.kind === "agent" ? (
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      style={{ fontSize: 10.5, color: a.available ? "var(--g)" : "var(--dim)" }}
                    >
                      {a.available ? "available" : "unavailable"}
                    </span>
                    <Toggle
                      on={!hidden}
                      size="small"
                      onChange={() => {
                        const next = hidden
                          ? settings.launchers.hiddenAgents.filter((id) => id !== agentId)
                          : [...settings.launchers.hiddenAgents, agentId];
                        updateSettings({ launchers: { hiddenAgents: next } });
                      }}
                    />
                  </span>
                ) : (
                  <span style={{ fontSize: 10.5, color: a.available ? "var(--g)" : "var(--dim)" }}>
                    {a.available ? "available" : "unavailable"}
                  </span>
                )
              }
            />
          );
        })}
      </StyledList>

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

const SOUND_OPTIONS: Array<{ value: SoundName; label: string }> = [
  { value: "ping", label: "Ping" },
  { value: "chime", label: "Chime" },
  { value: "blip", label: "Blip" },
];

function NotificationsSection() {
  const { settings, updateSettings } = useDashboardStore();
  const n = settings.notifications;
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "denied",
  );

  return (
    <>
      <Row
        label="Attention alerts"
        desc="Notify when an agent rings for input (the bell / OSC signal)."
      >
        <Toggle
          on={n.attentionAlerts}
          onChange={(v) => {
            updateSettings({ notifications: { attentionAlerts: v } });
            if (v && typeof Notification !== "undefined" && Notification.permission === "default") {
              void Notification.requestPermission().then(setPermission);
            }
          }}
        />
      </Row>
      <Row label="Browser permission" desc="Grant this in your browser's site settings if denied.">
        <span className="settings-readonly-value">{permission}</span>
      </Row>

      <div style={{ paddingTop: 6 }}>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>
          Delivery channels
        </div>
        <StyledList>
          <ListRow
            icon={<BellIcon size={16} />}
            title="Browser notification"
            trailing={
              <Toggle
                size="small"
                on={n.channels.browser}
                onChange={(v) => updateSettings({ notifications: { channels: { browser: v } } })}
              />
            }
          />
          <ListRow
            icon={<BellIcon size={16} />}
            title="Sound"
            trailing={
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Dropdown
                  small
                  value={n.soundName}
                  onChange={(v) => updateSettings({ notifications: { soundName: v } })}
                  options={SOUND_OPTIONS}
                />
                <Toggle
                  size="small"
                  on={n.channels.sound}
                  onChange={(v) => updateSettings({ notifications: { channels: { sound: v } } })}
                />
              </div>
            }
          />
        </StyledList>
      </div>

      <Row label="Idle threshold" desc="Silence before a session reads as idle.">
        <Slider
          min={5}
          max={120}
          step={5}
          value={n.idleThresholdSeconds}
          format={(v) => `${v}s`}
          onChange={(v) => updateSettings({ notifications: { idleThresholdSeconds: v } })}
        />
      </Row>
      <Row label="Exited-session alerts" desc="Notify when a program exits.">
        <Toggle
          on={n.exitedAlerts}
          onChange={(v) => updateSettings({ notifications: { exitedAlerts: v } })}
        />
      </Row>
    </>
  );
}

function SessionsSection() {
  const { settings, updateSettings, hideEndedSessions, setHideEndedSessions } = useDashboardStore();
  const theme = useDashboardStore((s) => s.theme);
  const s = settings.sessions;
  const agentLogoUrl = resolveAgentLogo("claude", theme);
  const namePreviewParts = s.namePattern.split("{agent}");

  return (
    <>
      <div style={{ padding: "6px 0 12px" }}>
        <div style={{ fontSize: 13.5, fontWeight: 500 }}>New-session name pattern</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3 }}>
          Tokens:{" "}
          <span style={{ fontFamily: "Geist Mono, monospace", color: "var(--c)" }}>
            {"{agent}"}
          </span>{" "}
          <span style={{ fontFamily: "Geist Mono, monospace", color: "var(--c)" }}>
            {"{project}"}
          </span>{" "}
          <span style={{ fontFamily: "Geist Mono, monospace", color: "var(--c)" }}>{"{n}"}</span>
        </div>
        <div className="settings-numberfield" style={{ marginTop: 11, width: "100%" }}>
          <input
            style={{ flex: 1, textAlign: "left", width: "auto" }}
            value={s.namePattern}
            onChange={(e) => updateSettings({ sessions: { namePattern: e.target.value } })}
          />
          <span
            className="settings-numberfield-suffix"
            style={{ display: "flex", alignItems: "center", gap: 4 }}
          >
            →{" "}
            {namePreviewParts.map((part, i) => (
              <Fragment key={i}>
                {i > 0 && (
                  <>
                    {agentLogoUrl && <img src={agentLogoUrl} alt="" width={14} height={14} />}
                    <span>Claude Code</span>
                  </>
                )}
                <span>{part.replaceAll("{project}", "tessera-hq").replaceAll("{n}", "1")}</span>
              </Fragment>
            ))}
          </span>
        </div>
      </div>

      <Row label="Confirm before kill" desc="Arm-then-confirm on the kill button.">
        <Toggle
          on={s.confirmBeforeKill}
          onChange={(v) => updateSettings({ sessions: { confirmBeforeKill: v } })}
        />
      </Row>
      <Row
        label="Show exited & killed sessions"
        desc="Keep dead sessions visible in the inventory."
      >
        <Toggle on={!hideEndedSessions} onChange={(v) => setHideEndedSessions(!v)} />
      </Row>
      <Row label="Auto-reconcile interval" desc="How often exited sessions are swept.">
        <NumberField
          value={s.reconcileIntervalSeconds}
          min={5}
          max={3600}
          width={46}
          suffix="seconds"
          onChange={(v) => updateSettings({ sessions: { reconcileIntervalSeconds: v } })}
        />
      </Row>
    </>
  );
}

// One credential for the whole install (issue #27), not per-project — see
// src/services/github-integration.ts. Manages its own fetch rather than
// going through useDashboardStore's settings (unlike most other sections):
// the token itself never round-trips through this client at all (the PUT
// body is write-only), so there's nothing here that belongs in the
// settings-patch debounce/merge machinery HostsSection also skips for the
// same reason.
function IntegrationsSection() {
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
      .then(() => setIntegration({ ...integration!, connected: false, login: null }))
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

      {error && (
        <div style={{ fontSize: 12, color: "var(--r)", marginTop: 8 }} role="alert">
          {error}
        </div>
      )}

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
    </>
  );
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
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
      <div className="settings-health-banner">
        <span className="settings-health-dot" />
        <span className="settings-health-label">Healthy</span>
        <span className="settings-health-status">/health · /ready → 200</span>
        <span className="settings-health-uptime">uptime {formatUptime(info.uptimeSeconds)}</span>
      </div>

      <div className="settings-stat-grid">
        <div className="settings-stat-card">
          <div className="settings-stat-label">Version</div>
          <div className="settings-stat-value">{info.version}</div>
        </div>
        <div className="settings-stat-card">
          <div className="settings-stat-label">Role</div>
          <div className="settings-stat-value">{info.role === "primary" ? "Primary" : "Agent"}</div>
        </div>
        <div className="settings-stat-card">
          <div className="settings-stat-label">Environment</div>
          <div className="settings-stat-value">{info.nodeEnv}</div>
        </div>
        <div className="settings-stat-card">
          <div className="settings-stat-label">Port</div>
          <div className="settings-stat-value">{info.port}</div>
        </div>
        <div className="settings-stat-card">
          <div className="settings-stat-label">Encryption at rest</div>
          <div className={`settings-stat-value${info.encryptionEnabled ? " good" : ""}`}>
            {info.encryptionEnabled && <span className="settings-stat-value-dot" />}
            {info.encryptionEnabled ? "On" : "Off"}
          </div>
        </div>
      </div>

      <div className="settings-info-table">
        <div className="settings-info-row zebra">
          <span className="settings-info-key">Sessions directory</span>
          <span className="settings-info-value">{info.sessionsDir}</span>
        </div>
        <div className="settings-info-row">
          <span className="settings-info-key">Database</span>
          <span className="settings-info-value">{info.dbPath}</span>
        </div>
        <div className="settings-info-row zebra">
          <span className="settings-info-key">Rate limit</span>
          <span className="settings-info-value">
            {info.rateLimit.max} req / {info.rateLimit.window}
          </span>
        </div>
      </div>

      <div className="settings-footer-note">
        Read-only diagnostics from deploy-time configuration. Values reflect the running process and
        cannot be edited here.
      </div>

      <UpdatesSubsection />
    </>
  );
}

const UPDATE_STATUS_POLL_MS = 2000;

function UpdatesSubsection() {
  const [check, setCheck] = useState<UpdateCheckResult | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  // No setState call at the top level (only inside .then/.catch, deferred)
  // so this is safe to call directly from the mount effect below without
  // tripping react-hooks/set-state-in-effect.
  const fetchCheck = (force?: boolean) =>
    api
      .checkForUpdate(force)
      .then((result) => {
        setCheck(result);
        setCheckError(null);
      })
      .catch((err: unknown) => {
        setCheckError(err instanceof ApiError ? err.message : "Could not check for updates");
      });

  useEffect(() => {
    fetchCheck();
  }, []);

  const runCheck = () => {
    // Deliberately doesn't clear `check` first (Hermes review, PR #130) —
    // clearing it would hide the stat grid, "Last checked" label, and the
    // whole action row (gated on `check &&`) for the duration of the
    // refetch. Keeping the stale result on screen while `checking` is true
    // reads better than a flash of "Checking…" on every re-check.
    setCheckError(null);
    setChecking(true);
    fetchCheck(true).finally(() => setChecking(false));
  };

  // Polls only while an update is actually running — matches the
  // poll-until-terminal-state pattern in GitHubDeviceFlowModal.tsx.
  useEffect(() => {
    if (!applying) return;
    const timer = setInterval(() => {
      api
        .getUpdateStatus()
        .then((s) => {
          setStatus(s);
          if (s.phase === "done" || s.phase === "failed") {
            clearInterval(timer);
            setApplying(false);
            // The server just restarted itself into the new release —
            // reload so every other tab/websocket reconnects against it
            // too, rather than leaving this whole dashboard talking to a
            // stale in-memory app state.
            if (s.phase === "done") setTimeout(() => window.location.reload(), 1500);
          }
        })
        .catch(() => {
          // A transient poll failure keeps the last known state on screen
          // rather than flashing an error for one missed beat.
        });
    }, UPDATE_STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [applying]);

  const apply = () => {
    if (!check?.latestVersion || !check.assetUrl || !check.checksumUrl) return;
    setApplyError(null);
    setStatus({ phase: "downloading", version: check.latestVersion });
    setApplying(true);
    api
      .applyUpdate(check.latestVersion, check.assetUrl, check.checksumUrl)
      .catch((err: unknown) => {
        setApplying(false);
        setApplyError(err instanceof ApiError ? err.message : "Could not start the update");
      });
  };

  return (
    <>
      <Eyebrow title="Updates" desc="Checks this project's GitHub releases for a newer version." />

      {checkError && (
        <div style={{ fontSize: 12, color: "var(--r)" }} role="alert">
          {checkError}
        </div>
      )}

      {!checkError && !check && <div className="settings-readonly-value">Checking…</div>}

      {check && (
        <div className="settings-stat-grid">
          <div className="settings-stat-card">
            <div className="settings-stat-label">Current</div>
            <div className="settings-stat-value">{check.currentVersion}</div>
          </div>
          <div className="settings-stat-card">
            <div className="settings-stat-label">Latest</div>
            <div
              className={`settings-stat-value${check.updateAvailable ? " warn" : check.latestVersion ? " good" : ""}`}
            >
              {check.updateAvailable && <span className="settings-stat-value-dot warn" />}
              {check.releaseUrl ? (
                <a href={check.releaseUrl} target="_blank" rel="noreferrer">
                  {check.latestVersion ?? "unknown"}
                </a>
              ) : (
                (check.latestVersion ?? "unknown")
              )}
            </div>
          </div>
        </div>
      )}

      {/* Distinguishes "checked just now" from "showing an hour-old cached
          result" — previously both looked identical (issue #123). */}
      {check && (
        <div className="settings-footer-note">
          Last checked: {formatRelativeAge(check.checkedAt)}
        </div>
      )}

      {check && !check.applyAvailable && (
        <div className="settings-footer-note">
          Auto-update requires a versioned-release install (<code>TESSERA_HOME</code>) — see{" "}
          <code>deploy/README.md</code>.
          {check.updateAvailable && " A newer version is available; update this host manually."}
        </div>
      )}

      {check && (
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10 }}>
          {check.applyAvailable && check.updateAvailable && (
            <SecondaryButton
              onClick={apply}
              disabled={applying || !check.assetUrl || !check.checksumUrl}
            >
              {applying ? "Updating…" : "Update now"}
            </SecondaryButton>
          )}
          {/* Always available (not gated on applyAvailable) so a dev checkout
              can still force a fresh check, not just versioned-release
              installs (issue #123). */}
          <SecondaryButton onClick={runCheck} disabled={applying || checking}>
            {checking ? "Checking…" : "Check again"}
          </SecondaryButton>
          {check.applyAvailable &&
            check.updateAvailable &&
            (!check.assetUrl || !check.checksumUrl) && (
              <span className="settings-footer-note" style={{ marginTop: 0 }}>
                No installable release asset yet.
              </span>
            )}
          {applying && status && (
            <span className="settings-info-value" style={{ flex: "unset" }}>
              {status.phase}…
            </span>
          )}
        </div>
      )}

      {status?.phase === "failed" && (
        <div style={{ fontSize: 12, color: "var(--r)", marginTop: 8 }} role="alert">
          Update failed: {status.error || "unknown error"}
        </div>
      )}
      {status?.phase === "done" && <div className="settings-footer-note">Updated — reloading…</div>}
      {applyError && (
        <div style={{ fontSize: 12, color: "var(--r)", marginTop: 8 }} role="alert">
          {applyError}
        </div>
      )}
    </>
  );
}
