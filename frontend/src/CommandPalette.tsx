import { useEffect, useMemo, useRef, useState } from "react";
import { api, normalizeAgentId } from "./api.js";
import type { Launcher, Session, Workspace } from "./api.js";
import { useDashboardStore } from "./store.js";
import { useShallow } from "zustand/react/shallow";
import {
  ChevronDownIcon,
  FileTextIcon,
  FolderIcon,
  GitBranchIcon,
  GitHubIcon,
  GlobeIcon,
  GridIcon,
  LayersIcon,
  SearchIcon,
  SkillIcon,
  TerminalPromptIcon,
} from "./icons.js";
import { resolveLauncherLogo } from "./cliLogos.js";
import { Dropdown } from "./settings/primitives.js";
import { matchesQuery } from "./matchQuery.js";

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
  // U2 (audit finding: "⌘K is a launcher, not a switcher") — selecting a
  // Sessions-group result below activates that session's existing pane
  // rather than creating a new one, so this needs its own callback distinct
  // from onLaunched above. App.tsx passes its own onOpenSession straight
  // through (the same open-or-focus-existing-panel handler Sidebar.tsx's
  // session rows use), not handleLaunched (which additionally knows about
  // split-request/new-panel placement — irrelevant here, the panel already
  // exists).
  onOpenSession: (session: Session) => void;
  // Phase 6 (6.5/#218) — same "Integrations" section, opening the task
  // board. Project-independent (unlike every other entry below): the task
  // board is the first *global* panel, so this is the only handler here
  // that takes no argument.
  onOpenTasks: () => void;
  // Issue #27: the palette's own "Integrations" section, opening the
  // per-project GitHub panel or the Settings -> Integrations section
  // (App.tsx owns both dockviewApi and the Settings modal, neither of
  // which this component has direct access to).
  onOpenGitHub: (projectId: number) => void;
  // Issue #76: same section, opening the (GitHub-independent) local git
  // status panel — branch, ahead/behind, and changed files.
  onOpenGit: (projectId: number) => void;
  // Issue #431: same section, opening the CLAUDE.md/AGENTS.md/GEMINI.md
  // editor for this project.
  onOpenAgentRules: (projectId: number) => void;
  // Issue #432: same section, opening the (read-only) skills panel for this
  // project.
  onOpenSkills: (projectId: number) => void;
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
  onOpenSession,
  onOpenTasks,
  onOpenGitHub,
  onOpenGit,
  onOpenAgentRules,
  onOpenSkills,
  onOpenBrowser,
  onOpenIntegrationsSettings,
  onOpenBlankBrowser,
  onOpenBrowserUrl,
}: CommandPaletteProps) {
  // P1 perf fix — was a single bare `useDashboardStore()` (whole-store
  // subscription). `createSession`/`refreshProjectUrls` are pure
  // action-callers (used inside a handler and an effect below, never read
  // as a value) — see the useDashboardStore.getState() calls at their own
  // call sites instead of subscribing to them here.
  const { projects, sessions, theme, settings, projectUrls, workspaces } = useDashboardStore(
    useShallow((s) => ({
      projects: s.projects,
      sessions: s.sessions,
      theme: s.theme,
      settings: s.settings,
      projectUrls: s.projectUrls,
      // U2 — the Workspaces result group's match source (see
      // matchingWorkspaces below); read here rather than via getState()
      // since (unlike createSession/refreshProjectUrls) this one IS read
      // reactively during render, same rule P1's own header comment states.
      workspaces: s.workspaces,
    })),
  );
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

  // Issue #271, option 1 — the launcher's opt-in "isolate this session"
  // toggle: launch directly into a fresh worktree instead of the target
  // project's own cwd. Off by default; the base-ref picker only fetches
  // once the toggle is switched on, not on every palette open.
  const [worktreeEnabled, setWorktreeEnabled] = useState(false);
  const [worktreeBranches, setWorktreeBranches] = useState<string[]>([]);
  const [worktreeBaseRef, setWorktreeBaseRef] = useState("");

  useEffect(() => {
    if (!worktreeEnabled || effectiveProjectId === null) return;
    let cancelled = false;
    void api.getProjectGitBranches(effectiveProjectId).then((result) => {
      if (cancelled || !result) return;
      const local = result.branches.map((b) => b.name);
      setWorktreeBranches([...local, ...result.remoteBranches]);
      const current = result.branches.find((b) => b.isCurrent)?.name ?? null;
      setWorktreeBaseRef((prev) => prev || current || local[0] || "");
    });
    return () => {
      cancelled = true;
    };
  }, [worktreeEnabled, effectiveProjectId]);

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
        // A project switch mid-search (e.g. via the target picker while a
        // query is already typed) can leave the Sessions/Workspaces groups
        // occupying the front of the flattened `entries` list — resetting
        // to 0 there lands on whichever group is actually first, rather
        // than aiming this launcher-only `defaultIndex` at an unrelated
        // flattened slot. The common case (project resolved before any
        // typing) always has an empty query here, so those groups are empty
        // and this is exactly the old plain-launcher-index behavior.
        setSelectedIndex(query.trim() !== "" ? 0 : defaultIndex >= 0 ? defaultIndex : 0);
      })
      .catch(() => setLaunchers([]));
    // Only re-resolve the default on a genuine project switch — re-running
    // this whenever `settings.launchers.defaultAgent` itself changes would
    // yank the current selection out from under a mid-search user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveProjectId]);

  useEffect(() => {
    if (effectiveProjectId === null) return;
    void useDashboardStore.getState().refreshProjectUrls(effectiveProjectId);
  }, [effectiveProjectId]);

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
            !settings.launchers.hiddenAgents?.includes(normalizeAgentId(l.id))) &&
          (query.trim() === "" || matchesQuery([l.title, l.command], query)),
      ),
    [launchers, query, settings.launchers.hiddenAgents],
  );

  // U2 — search existing sessions from the palette instead of only being
  // able to launch new ones. Matched against the exact field precedence the
  // finding spells out: an explicit name first, then the last OSC-reported
  // title, then the raw launch command — deliberately NOT SessionRow's
  // nameLocked-gated `title` (Sidebar.tsx): an un-locked, auto-generated
  // title is still a perfectly good thing to find a session by here. Project
  // name and the best-known live branch (`liveBranch` — see its own doc
  // comment on api.ts's Session for why that field, not a
  // sessionGitStatuses lookup, is the "best known" one) extend the match
  // beyond the title alone.
  const matchingSessions = useMemo(() => {
    if (query.trim() === "") return [];
    return sessions
      .filter(
        (s) =>
          // Killed sessions have no pane left to reopen (Sidebar.tsx excludes
          // them from the tree for the same reason), and "dock" sessions live
          // in the Dock region rather than the tab strip onOpenSession
          // targets — both are filtered out here to match what actually
          // opens through onOpenSession below. In "project" scope (a project
          // row's own "+ session" trigger) the target strip above reads
          // "Runs in <project>" and the launcher list itself is already
          // fetched per-project — a session from a DIFFERENT project ranking
          // above this project's own commands would contradict that framing,
          // so this scopes to effectiveProjectId too (Hermes review, PR
          // #581). "global" scope has no such single-project framing (the
          // whole point of its picker is that it isn't bound to one
          // project), so it stays unfiltered — the subtitle's project name
          // is what disambiguates there.
          s.kind === "terminal" &&
          s.status !== "killed" &&
          (scope !== "project" || s.projectId === effectiveProjectId),
      )
      .filter((s) => {
        const project = projects.find((p) => p.id === s.projectId);
        const title = s.name || s.lastTitle || s.command;
        return matchesQuery([title, s.command, project?.name, s.liveBranch], query);
      });
    // Deliberately NOT filtered by the global "hide ended sessions" setting
    // (Settings -> Sessions) the way Sidebar.tsx's tree is — typing a query
    // here is explicit search intent, not passive browsing, so an exited
    // session the user is actively looking for should still surface.
  }, [sessions, projects, query, scope, effectiveProjectId]);

  // Same "only once there's a real query" gate as matchingSessions above —
  // dumping every workspace into an unscoped list on open would just
  // duplicate WorkspaceSwitcher's own always-visible list for no benefit.
  const matchingWorkspaces = useMemo(() => {
    if (query.trim() === "") return [];
    return workspaces.filter((w) => matchesQuery([w.name], query));
  }, [workspaces, query]);

  // Sessions, Workspaces, and Matching commands render as three separate
  // groups but share ONE selection index across all of them for arrow-key
  // nav — Sidebar.tsx's own grouped list (projects -> sessions) has no
  // analogous single-index keyboard nav to follow (each project section is
  // independently click/hover-driven, never arrow-keyed), so this flattens
  // the three result arrays into one ordered list purely for index math:
  // entries[i] is whichever group i falls into once each group's rows are
  // rendered at their own absolute offset (see groupOffset below).
  type PaletteEntry =
    | { type: "session"; session: Session }
    | { type: "workspace"; workspace: Workspace }
    | { type: "launcher"; launcher: Launcher };
  const entries = useMemo<PaletteEntry[]>(
    () => [
      ...matchingSessions.map((session): PaletteEntry => ({ type: "session", session })),
      ...matchingWorkspaces.map((workspace): PaletteEntry => ({ type: "workspace", workspace })),
      ...filtered.map((launcher): PaletteEntry => ({ type: "launcher", launcher })),
    ],
    [matchingSessions, matchingWorkspaces, filtered],
  );
  // `sessions` (and therefore matchingSessions/entries) refreshes every 4s
  // off the store's live-refresh poll while the palette can stay open
  // (store.ts's LIVE_REFRESH_INTERVAL_MS) — unlike `filtered`, which only
  // ever shrinks/grows on a keystroke or a project switch. A session
  // dropping out of the match set mid-poll can leave `selectedIndex` past
  // the new end; clamping once here (rather than at every read site) is
  // what keeps Enter/highlight/the options-strip below from silently
  // targeting a stale, now out-of-range index.
  const activeIndex = entries.length === 0 ? -1 : Math.min(selectedIndex, entries.length - 1);
  const activeEntry = entries[activeIndex];
  const groupOffset = matchingSessions.length + matchingWorkspaces.length;

  const skipPermissionsAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of settings.launchers.skipPermissionsAgents ?? []) {
      ids.add(id);
    }
    for (const l of launchers) {
      if (l.kind !== "agent") continue;
      const id = normalizeAgentId(l.id);
      if (l.skipPermissions === false) {
        ids.delete(id);
      } else if (l.skipPermissions === true) {
        ids.add(id);
      }
    }
    return ids;
  }, [settings.launchers.skipPermissionsAgents, launchers]);

  // Universal override — when checked, ALL agents launch with skip-permissions.
  // Per-agent config (settings / .crs/actions.json) is shown as a badge on the
  // agent row instead of pre-checking the box. The user's choice persists
  // across launcher selections (no reset on pick change).
  const [skipPermissionsOverride, setSkipPermissionsOverride] = useState<boolean | null>(null);

  const skipPermissionsEnabled = skipPermissionsOverride ?? false;

  const target = projects.find((p) => p.id === effectiveProjectId) ?? null;

  const launch = (launcher: Launcher) => {
    if (effectiveProjectId === null) return;
    localStorage.setItem(LAST_PROJECT_KEY, String(effectiveProjectId));
    const name = expandSessionNamePattern(settings.sessions.namePattern, {
      agent: launcher.title,
      project: target?.name ?? "",
      n: sessions.filter((s) => s.projectId === effectiveProjectId).length + 1,
    });
    const trimmedBaseRef = worktreeBaseRef.trim();
    void useDashboardStore
      .getState()
      .createSession(effectiveProjectId, launcher.command, {
        cwd: launcher.cwd,
        name,
        worktree: worktreeEnabled && trimmedBaseRef ? { baseRef: trimmedBaseRef } : undefined,
        skipPermissions:
          launcher.kind === "agent"
            ? skipPermissionsOverride !== null
              ? skipPermissionsOverride
              : launcher.skipPermissions === true
                ? true
                : launcher.skipPermissions === false
                  ? false
                  : (settings.launchers.skipPermissionsAgents?.includes(
                      normalizeAgentId(launcher.id),
                    ) ?? false)
            : undefined,
      })
      .then((session) => {
        onLaunched(session);
        onClose();
      });
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
                setSelectedIndex(Math.min(activeIndex + 1, entries.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelectedIndex(Math.max(activeIndex - 1, 0));
              } else if (e.key === "Enter") {
                const picked = entries[activeIndex];
                if (!picked) return;
                if (picked.type === "session") {
                  onOpenSession(picked.session);
                  onClose();
                } else if (picked.type === "workspace") {
                  useDashboardStore.getState().setActiveWorkspaceId(picked.workspace.id);
                  onClose();
                } else {
                  launch(picked.launcher);
                }
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
          {/* Issue #271, option 1 — opt-in worktree isolation at launch time.
              Not shown until a project target is resolved (mirrors every
              other target-dependent affordance in this strip). */}
          {effectiveProjectId !== null && (
            <div className="cmd-palette-target-row cmd-palette-worktree-row">
              <label className="cmd-palette-worktree-toggle">
                <input
                  type="checkbox"
                  checked={worktreeEnabled}
                  onChange={(e) => setWorktreeEnabled(e.target.checked)}
                />
                <GitBranchIcon size={13} style={{ color: "var(--muted)" }} />
                <span>Isolate in a new worktree</span>
              </label>
              {worktreeEnabled && (
                <div className="cmd-palette-worktree-picker">
                  <Dropdown
                    small
                    value={worktreeBaseRef}
                    onChange={setWorktreeBaseRef}
                    options={worktreeBranches.map((name) => ({ value: name, label: name }))}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {effectiveProjectId !== null && (
          <div className="cmd-palette-options-strip">
            <div
              style={{
                visibility:
                  !pickerOpen &&
                  activeEntry?.type === "launcher" &&
                  activeEntry.launcher.kind === "agent"
                    ? "visible"
                    : "hidden",
              }}
              aria-hidden={
                pickerOpen ||
                !(activeEntry?.type === "launcher" && activeEntry.launcher.kind === "agent")
              }
            >
              <label className="cmd-palette-worktree-toggle">
                <input
                  type="checkbox"
                  checked={skipPermissionsEnabled}
                  onChange={(e) => setSkipPermissionsOverride(e.target.checked)}
                />
                <span style={{ fontSize: 12, color: "var(--muted)" }}>⚠</span>
                <span>Skip permissions (all agents)</span>
              </label>
              <div
                style={{
                  fontSize: 10.5,
                  color: "var(--dim)",
                  marginLeft: 22,
                  marginTop: 1,
                  lineHeight: 1.3,
                }}
              >
                Overrides per-agent settings — suppresses approval prompts for all agents
              </div>
            </div>
          </div>
        )}

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
                {/* Phase 6 (6.5/#218) — the first entry not gated on
                    effectiveProjectId: the task board is global, not
                    scoped to any one project. Since the Kanban/TaskPanel
                    merge, `onOpenTasks` switches to the unified Kanban
                    view (UnifiedBoard.tsx) rather than opening a panel. */}
                <button
                  className="cmd-row"
                  onClick={() => {
                    onOpenTasks();
                    onClose();
                  }}
                >
                  <span
                    className="cmd-row-icon"
                    style={{ background: "color-mix(in srgb, var(--fg) 8%, transparent)" }}
                  >
                    <LayersIcon size={13} style={{ color: "var(--muted)" }} />
                  </span>
                  <span className="cmd-row-body">
                    <span className="cmd-row-title">Tasks</span>
                    <span className="cmd-row-subtitle">Task board — Kanban view</span>
                  </span>
                </button>
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
                      onOpenAgentRules(effectiveProjectId);
                      onClose();
                    }}
                  >
                    <span
                      className="cmd-row-icon"
                      style={{ background: "color-mix(in srgb, var(--fg) 8%, transparent)" }}
                    >
                      <FileTextIcon size={13} style={{ color: "var(--muted)" }} />
                    </span>
                    <span className="cmd-row-body">
                      <span className="cmd-row-title">
                        Agent Rules: {target?.name ?? "this project"}
                      </span>
                      <span className="cmd-row-subtitle">CLAUDE.md, AGENTS.md, GEMINI.md</span>
                    </span>
                  </button>
                )}
                {effectiveProjectId !== null && (
                  <button
                    className="cmd-row"
                    onClick={() => {
                      onOpenSkills(effectiveProjectId);
                      onClose();
                    }}
                  >
                    <span
                      className="cmd-row-icon"
                      style={{ background: "color-mix(in srgb, var(--fg) 8%, transparent)" }}
                    >
                      <SkillIcon size={13} style={{ color: "var(--muted)" }} />
                    </span>
                    <span className="cmd-row-body">
                      <span className="cmd-row-title">
                        Skills: {target?.name ?? "this project"}
                      </span>
                      <span className="cmd-row-subtitle">Discovered skills across every agent</span>
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
                    <span className="cmd-row-title">New preview tab</span>
                    <span className="cmd-row-subtitle">
                      Embed any external site — type an address directly
                    </span>
                  </span>
                </button>
              </>
            )}
            {/* U2 — shown above "Matching commands" whenever there's at
                least one match: an existing session/workspace the user is
                looking for should rank above starting something new with
                the same name, since jumping to a running session is
                (almost always) the cheaper, more-likely-intended action.
                Neither group renders at all on an empty query (see
                matchingSessions/matchingWorkspaces's own gate above) — the
                sidebar and WorkspaceSwitcher already own "browse
                everything", this is search, not a duplicate always-on list. */}
            {matchingSessions.length > 0 && (
              <>
                <div className="cmd-palette-group-label">Sessions</div>
                {matchingSessions.map((session, i) => {
                  const project = projects.find((p) => p.id === session.projectId);
                  const title = session.name || session.lastTitle || session.command;
                  const subtitleParts = [project?.name, session.liveBranch].filter(
                    (part): part is string => Boolean(part),
                  );
                  return (
                    <button
                      key={`session-${session.id}`}
                      className={`cmd-row${i === activeIndex ? " selected" : ""}`}
                      onMouseEnter={() => setSelectedIndex(i)}
                      onClick={() => {
                        onOpenSession(session);
                        onClose();
                      }}
                    >
                      <span
                        className="cmd-row-icon"
                        style={{
                          background: "color-mix(in srgb, var(--b) 22%, transparent)",
                          color: "var(--b)",
                        }}
                      >
                        <TerminalPromptIcon size={13} />
                      </span>
                      <span className="cmd-row-body">
                        <span className="cmd-row-title">{title}</span>
                        {subtitleParts.length > 0 && (
                          <span className="cmd-row-subtitle">{subtitleParts.join(" · ")}</span>
                        )}
                      </span>
                      {i === activeIndex && <span className="kbd">↵</span>}
                    </button>
                  );
                })}
              </>
            )}
            {matchingWorkspaces.length > 0 && (
              <>
                <div className="cmd-palette-group-label">Workspaces</div>
                {matchingWorkspaces.map((workspace, i) => {
                  const absoluteIndex = matchingSessions.length + i;
                  return (
                    <button
                      key={`workspace-${workspace.id}`}
                      className={`cmd-row${absoluteIndex === activeIndex ? " selected" : ""}`}
                      onMouseEnter={() => setSelectedIndex(absoluteIndex)}
                      onClick={() => {
                        useDashboardStore.getState().setActiveWorkspaceId(workspace.id);
                        onClose();
                      }}
                    >
                      <span
                        className="cmd-row-icon"
                        style={{ background: "color-mix(in srgb, var(--fg) 8%, transparent)" }}
                      >
                        <GridIcon size={13} style={{ color: "var(--muted)" }} />
                      </span>
                      <span className="cmd-row-body">
                        <span className="cmd-row-title">{workspace.name}</span>
                      </span>
                      {absoluteIndex === activeIndex && <span className="kbd">↵</span>}
                    </button>
                  );
                })}
              </>
            )}
            <div className="cmd-palette-group-label">Matching commands</div>
            {filtered.length === 0 && (
              <div style={{ padding: "12px 11px", fontSize: 12.5, color: "var(--muted)" }}>
                No matching launchers.
              </div>
            )}
            {filtered.map((launcher, i) => {
              const absoluteIndex = groupOffset + i;
              const logo = resolveLauncherLogo(launcher, theme);
              return (
                <button
                  key={launcher.id}
                  className={`cmd-row${absoluteIndex === activeIndex ? " selected" : ""}`}
                  onMouseEnter={() => setSelectedIndex(absoluteIndex)}
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
                  {launcher.kind === "agent" &&
                    skipPermissionsAgentIds.has(normalizeAgentId(launcher.id)) && (
                      <span
                        className="cmd-row-source-badge"
                        style={{
                          color: "var(--o)",
                          borderColor: "color-mix(in srgb, var(--o) 40%, transparent)",
                        }}
                      >
                        ⚠ skip perms
                      </span>
                    )}
                  {absoluteIndex === activeIndex && <span className="kbd">↵</span>}
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
            <span className="kbd">↵</span>
            {/* Reflects whichever entry is actually selected, not just the
                launch-a-command case — "Launch in X" would be misleading
                once the highlighted row is an existing session/workspace. */}
            {activeEntry?.type === "session"
              ? "Open session"
              : activeEntry?.type === "workspace"
                ? "Switch workspace"
                : `Launch in ${target?.name ?? "…"}`}
          </span>
        </div>
      </div>
    </div>
  );
}
