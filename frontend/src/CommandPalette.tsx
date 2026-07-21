import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";
import type { Launcher, Session } from "./api.js";
import { useDashboardStore } from "./store.js";
import {
  ChevronDownIcon,
  FolderIcon,
  GitBranchIcon,
  GitHubIcon,
  GlobeIcon,
  SearchIcon,
} from "./icons.js";
import { resolveLauncherLogo } from "./cliLogos.js";

// The unified launcher menu — one component backs the toolbar's "New
// session"/⌘K entry (scope: "global", needs a project-target picker to
// resolve a working directory) AND a project row's own "+ session" trigger
// (scope: "project", cwd is already implicit). GET /api/projects/:id/actions
// already returns the fully merged list (detected shells/agents + npm
// scripts + tasks.json + .crs/actions.json) for whichever project is the
// current target, so both scopes hit the exact same endpoint once a target
// is resolved — the only difference is whether the target strip is
// read-only ("Runs in") or clickable ("Launch in" + picker).
const SOURCE_LABEL: Record<Launcher["kind"], string | null> = {
  shell: null,
  agent: null,
  "npm-script": "package.json",
  task: "tasks.json",
  custom: ".crs/actions.json",
};

const LAST_PROJECT_KEY = "crs.lastLaunchProjectId";

// Expands Settings -> Session management's naming-pattern tokens
// ({agent} {project} {n}) into a concrete session name at launch time — see
// settings.sessions.namePattern (default "{agent} · {project}"). A falsy
// result (empty pattern, or a pattern that expands to only whitespace)
// yields `undefined` so callers fall back to the sessions route's own
// "name ?? command" display convention rather than persisting an empty name.
function expandSessionNamePattern(
  pattern: string,
  tokens: { agent: string; project: string; n: number },
): string | undefined {
  const expanded = pattern
    .replaceAll("{agent}", tokens.agent)
    .replaceAll("{project}", tokens.project)
    .replaceAll("{n}", String(tokens.n))
    .trim();
  return expanded.length > 0 ? expanded : undefined;
}

interface CommandPaletteProps {
  scope: "global" | "project";
  projectId: number | null;
  onClose: () => void;
  onLaunched: (session: Session) => void;
  // Issue #27: the palette's own "Integrations" section, opening the
  // per-project GitHub panel or the Settings -> Integrations section
  // (App.tsx owns both dockviewApi and the Settings modal, neither of
  // which this component has direct access to).
  onOpenGitHub: (projectId: number) => void;
  // Issue #76: same section, opening the (GitHub-independent) local git
  // status panel — branch, ahead/behind, and changed files.
  onOpenGit: (projectId: number) => void;
  onOpenIntegrationsSettings: () => void;
  // Issue #28: same section, opening a browser preview pane for this
  // project's dev server.
  onOpenBrowser: (projectId: number) => void;
  // Issue #28's "general-purpose browser tile" — project-independent
  // (unlike the two above), so always shown regardless of scope. Opens an
  // empty browser pane (BrowserPanel's own "empty" state, address bar
  // auto-focused) for typing a URL straight in, no modal detour.
  onOpenBlankBrowser: () => void;
  // Issue #109: opens a browser pane for a specific saved URL (favorited).
  // The same BrowserPanel component handles navigation once opened.
  onOpenBrowserUrl: (projectId: number, url: string, label: string) => void;
}

// The parent (App.tsx) only mounts this component while the palette is
// open — a fresh mount per open is what resets all local state below, so
// there's no "reset on open" effect to write (and no
// react-hooks/set-state-in-effect violation from one).
export function CommandPalette({
  scope,
  projectId: initialProjectId,
  onClose,
  onLaunched,
  onOpenGitHub,
  onOpenGit,
  onOpenBrowser,
  onOpenIntegrationsSettings,
  onOpenBlankBrowser,
  onOpenBrowserUrl,
}: CommandPaletteProps) {
  const { projects, sessions, createSession, theme, settings, projectUrls, refreshProjectUrls } =
    useDashboardStore();
  const [targetProjectId] = useState<number | null>(() => {
    if (scope === "project") return initialProjectId;
    const stored = Number(localStorage.getItem(LAST_PROJECT_KEY));
    return (projects.find((p) => p.id === stored) ?? projects[0] ?? null)?.id ?? null;
  });
  const [manualTargetProjectId, setManualTargetProjectId] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [launchers, setLaunchers] = useState<Launcher[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const effectiveProjectId = manualTargetProjectId ?? targetProjectId;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (effectiveProjectId === null) return;
    api
      .listProjectActions(effectiveProjectId)
      .then((fetched) => {
        setLaunchers(fetched);
        // Settings -> Launchers & agents "Default agent" — pre-select the
        // matching launcher (by id, since a shell/agent launcher's id is
        // `${kind}:${bin}`, e.g. "agent:claude" — see agent-detect.ts) so
        // hitting Enter immediately launches it instead of defaulting to
        // whatever GET /api/projects/:id/actions happened to list first.
        const defaultIndex = fetched.findIndex(
          (l) => l.id === `agent:${settings.launchers.defaultAgent}`,
        );
        setSelectedIndex(defaultIndex >= 0 ? defaultIndex : 0);
      })
      .catch(() => setLaunchers([]));
    // Only re-resolve the default on a genuine project switch — re-running
    // this whenever `settings.launchers.defaultAgent` itself changes would
    // yank the current selection out from under a mid-search user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveProjectId]);

  useEffect(() => {
    if (effectiveProjectId === null) return;
    void refreshProjectUrls(effectiveProjectId);
  }, [effectiveProjectId, refreshProjectUrls]);

  // Hidden-agent filtering: strip the "agent:" prefix from launcher IDs
  // (detected agents have ids like "agent:claude") and compare against the
  // bare names stored in settings.launchers.hiddenAgents.  A
  // .crs/actions.json override with a non-standard id (no "agent:" prefix)
  // falls through to a raw id lookup, which won't match the Settings toggle's
  // always-bare stored names — an acknowledged edge case that only affects
  // projects with custom actions.json overrides.
  const filtered = useMemo(
    () =>
      launchers.filter(
        (l) =>
          (!(l.kind === "agent") ||
            !settings.launchers.hiddenAgents?.includes(
              l.id.startsWith("agent:") ? l.id.slice(6) : l.id,
            )) &&
          (query.trim() === "" ||
            l.title.toLowerCase().includes(query.toLowerCase()) ||
            l.command.toLowerCase().includes(query.toLowerCase())),
      ),
    [launchers, query, settings.launchers.hiddenAgents],
  );

  const target = projects.find((p) => p.id === effectiveProjectId) ?? null;

  const launch = (launcher: Launcher) => {
    if (effectiveProjectId === null) return;
    localStorage.setItem(LAST_PROJECT_KEY, String(effectiveProjectId));
    const name = expandSessionNamePattern(settings.sessions.namePattern, {
      agent: launcher.title,
      project: target?.name ?? "",
      n: sessions.filter((s) => s.projectId === effectiveProjectId).length + 1,
    });
    void createSession(effectiveProjectId, launcher.command, { cwd: launcher.cwd, name }).then(
      (session) => {
        onLaunched(session);
        onClose();
      },
    );
  };

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()}>
        <div className="cmd-palette-search">
          <SearchIcon size={17} strokeWidth={1.9} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Launch a session or run a command…"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                onClose();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelectedIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                const picked = filtered[selectedIndex];
                if (picked) launch(picked);
              }
            }}
          />
          <span className="kbd">esc</span>
        </div>

        <div className={`cmd-palette-target-strip${scope === "global" ? " global" : ""}`}>
          {scope === "project" ? (
            <>
              <div className="cmd-palette-target-row">
                <FolderIcon size={14} style={{ color: "var(--dim)" }} />
                <span className="cmd-palette-target-label">Runs in</span>
                <span className="cmd-palette-target-chip" title={target?.cwd ?? ""}>
                  <span className="cmd-palette-target-name">{target?.name ?? "…"}</span>
                </span>
              </div>
              <div className="cmd-palette-target-hint indent">
                Working directory bound from this project — no target step needed.
              </div>
            </>
          ) : (
            <div className="cmd-palette-target-row">
              <span className="cmd-palette-target-label">Launch in</span>
              <button
                className="cmd-palette-target-chip clickable"
                title={target?.cwd ?? ""}
                onClick={() => setPickerOpen((v) => !v)}
              >
                <FolderIcon size={13} style={{ color: "var(--accent-solid)" }} />
                <span className="cmd-palette-target-name">
                  {target?.name ?? "choose a project"}
                </span>
                <ChevronDownIcon size={13} strokeWidth={2.2} />
              </button>
              <span className="cmd-palette-change-target">⌘↓ change target</span>
            </div>
          )}
          {scope === "global" && (
            <div className="cmd-palette-target-hint">
              A global command needs a project to resolve its working directory.
            </div>
          )}
        </div>

        {pickerOpen ? (
          <div className="cmux-scroll cmd-palette-list">
            <div className="cmd-palette-group-label">Choose a project</div>
            {projects.map((p) => (
              <button
                key={p.id}
                className="cmd-row"
                onClick={() => {
                  setManualTargetProjectId(p.id);
                  setPickerOpen(false);
                }}
              >
                <span
                  className="cmd-row-icon"
                  style={{ background: "color-mix(in srgb, var(--fg) 8%, transparent)" }}
                >
                  <FolderIcon size={14} style={{ color: "var(--muted)" }} />
                </span>
                <span className="cmd-row-body">
                  <span className="cmd-row-title">{p.name}</span>
                  <span className="cmd-row-subtitle">{p.cwd}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="cmux-scroll cmd-palette-list">
            {/* Not filtered by `query` — these are fixed navigation
                entries, not launchers to search over, same reason the
                target strip above ignores it too. Hidden while mid-search
                so they don't compete with actual command results. */}
            {query.trim() === "" && (
              <>
                <div className="cmd-palette-group-label">Integrations</div>
                {effectiveProjectId !== null && (
                  <button
                    className="cmd-row"
                    onClick={() => {
                      onOpenGitHub(effectiveProjectId);
                      onClose();
                    }}
                  >
                    <span
                      className="cmd-row-icon"
                      style={{ background: "color-mix(in srgb, var(--fg) 8%, transparent)" }}
                    >
                      <GitHubIcon size={13} style={{ color: "var(--muted)" }} />
                    </span>
                    <span className="cmd-row-body">
                      <span className="cmd-row-title">
                        GitHub: {target?.name ?? "this project"}
                      </span>
                      <span className="cmd-row-subtitle">
                        Open issues, pull requests, and status
                      </span>
                    </span>
                  </button>
                )}
                {effectiveProjectId !== null && (
                  <button
                    className="cmd-row"
                    onClick={() => {
                      onOpenGit(effectiveProjectId);
                      onClose();
                    }}
                  >
                    <span
                      className="cmd-row-icon"
                      style={{ background: "color-mix(in srgb, var(--fg) 8%, transparent)" }}
                    >
                      <GitBranchIcon size={13} style={{ color: "var(--muted)" }} />
                    </span>
                    <span className="cmd-row-body">
                      <span className="cmd-row-title">Git: {target?.name ?? "this project"}</span>
                      <span className="cmd-row-subtitle">Branch, status, and changed files</span>
                    </span>
                  </button>
                )}
                {effectiveProjectId !== null && (
                  <button
                    className="cmd-row"
                    onClick={() => {
                      onOpenBrowser(effectiveProjectId);
                      onClose();
                    }}
                  >
                    <span
                      className="cmd-row-icon"
                      style={{ background: "color-mix(in srgb, var(--fg) 8%, transparent)" }}
                    >
                      <GlobeIcon size={13} style={{ color: "var(--muted)" }} />
                    </span>
                    <span className="cmd-row-body">
                      <span className="cmd-row-title">
                        Preview: {target?.name ?? "this project"}
                      </span>
                      <span className="cmd-row-subtitle">Open this project's dev server</span>
                    </span>
                  </button>
                )}
                {effectiveProjectId !== null &&
                  (projectUrls[effectiveProjectId] ?? [])
                    .filter((u) => u.favorite)
                    .map((u) => (
                      <button
                        key={u.id}
                        className="cmd-row"
                        onClick={() => {
                          onOpenBrowserUrl(effectiveProjectId, u.url, u.label);
                          onClose();
                        }}
                      >
                        <span
                          className="cmd-row-icon"
                          style={{ background: "color-mix(in srgb, var(--fg) 8%, transparent)" }}
                        >
                          <GlobeIcon size={13} style={{ color: "var(--muted)" }} />
                        </span>
                        <span className="cmd-row-body">
                          <span className="cmd-row-title">
                            {u.label}: {target?.name ?? "this project"}
                          </span>
                          <span className="cmd-row-subtitle">{u.url}</span>
                        </span>
                      </button>
                    ))}
                <button
                  className="cmd-row"
                  onClick={() => {
                    onOpenIntegrationsSettings();
                    onClose();
                  }}
                >
                  <span
                    className="cmd-row-icon"
                    style={{ background: "color-mix(in srgb, var(--fg) 8%, transparent)" }}
                  >
                    <GitHubIcon size={13} style={{ color: "var(--muted)" }} />
                  </span>
                  <span className="cmd-row-body">
                    <span className="cmd-row-title">Manage integrations…</span>
                    <span className="cmd-row-subtitle">Settings → Integrations</span>
                  </span>
                </button>
                <button
                  className="cmd-row"
                  onClick={() => {
                    onOpenBlankBrowser();
                    onClose();
                  }}
                >
                  <span
                    className="cmd-row-icon"
                    style={{ background: "color-mix(in srgb, var(--fg) 8%, transparent)" }}
                  >
                    <GlobeIcon size={13} style={{ color: "var(--muted)" }} />
                  </span>
                  <span className="cmd-row-body">
                    <span className="cmd-row-title">New browser tab</span>
                    <span className="cmd-row-subtitle">
                      Embed any external site — type an address directly
                    </span>
                  </span>
                </button>
              </>
            )}
            <div className="cmd-palette-group-label">Matching commands</div>
            {filtered.length === 0 && (
              <div style={{ padding: "12px 11px", fontSize: 12.5, color: "var(--muted)" }}>
                No matching launchers.
              </div>
            )}
            {filtered.map((launcher, i) => {
              const logo = resolveLauncherLogo(launcher, theme);
              return (
                <button
                  key={launcher.id}
                  className={`cmd-row${i === selectedIndex ? " selected" : ""}`}
                  onMouseEnter={() => setSelectedIndex(i)}
                  onClick={() => launch(launcher)}
                >
                  {logo ? (
                    <span className="cmd-row-icon cmd-row-icon-logo">
                      <img src={logo} alt="" width={16} height={16} />
                    </span>
                  ) : (
                    <span
                      className="cmd-row-icon"
                      style={{
                        background:
                          launcher.kind === "agent" || launcher.kind === "shell"
                            ? "color-mix(in srgb, var(--b) 22%, transparent)"
                            : "color-mix(in srgb, var(--g) 18%, transparent)",
                        color:
                          launcher.kind === "agent" || launcher.kind === "shell"
                            ? "var(--b)"
                            : "var(--g)",
                      }}
                    >
                      {launcher.kind === "agent" ? "✳" : "›"}
                    </span>
                  )}
                  <span className="cmd-row-body">
                    <span className="cmd-row-title">{launcher.title}</span>
                    <span className="cmd-row-subtitle">{launcher.command}</span>
                  </span>
                  {SOURCE_LABEL[launcher.kind] && (
                    <span className="cmd-row-source-badge">{SOURCE_LABEL[launcher.kind]}</span>
                  )}
                  {i === selectedIndex && <span className="kbd">↵</span>}
                </button>
              );
            })}
          </div>
        )}

        <div className="cmd-palette-footer">
          <span className="cmd-palette-footer-item">
            <span className="kbd">↑↓</span>navigate
          </span>
          <span className="cmd-palette-footer-item">
            <span className="kbd">↵</span>Launch in {target?.name ?? "…"}
          </span>
        </div>
      </div>
    </div>
  );
}
