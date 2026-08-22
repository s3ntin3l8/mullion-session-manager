import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { api, normalizeAgentId } from "./api/index.js";
import type { Launcher, Session } from "./api/index.js";
import { useDashboardStore } from "./store/index.js";
import { useShallow } from "zustand/react/shallow";
import {
  ChevronDownIcon,
  DockIcon,
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
} from "./ui/icons.js";
import { resolveLauncherLogo } from "./cliLogos.js";
import { useCommandSearch } from "./hooks/useCommandSearch.js";
import { STORAGE_KEYS, readNumber, writeNumber } from "./lib/persistedState.js";
import { WorktreeOptions } from "./command-palette/WorktreeOptions.js";
import { useFocusTrap } from "./hooks/useFocusTrap.js";
import { useCoarsePointer } from "./lib/layoutTier.js";

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
  // U4: same section, opening the `.crs/dock.json` editor for this project.
  onOpenDockConfig: (projectId: number) => void;
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
  // Mobile/tablet workspace-nav fix (PR #810) — the palette's own two
  // "select a Workspace search result" sites (U2's Workspaces group, Enter
  // and click) used to call the store's `showWorkspace` directly, which
  // left the phone/tablet sidebar overlay open behind the (now-closing)
  // palette — the exact bug this PR fixes for WorkspaceSwitcher's own rows,
  // reachable here too since the toolbar's launcher button that opens this
  // palette stays tappable while that overlay is up. Optional (falls back
  // to calling the store directly) so callers that don't care about the
  // overlay — and every existing test — don't need to pass it.
  onShowWorkspace?: (workspaceId: number) => void;
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
  onOpenDockConfig,
  onOpenSkills,
  onOpenBrowser,
  onOpenIntegrationsSettings,
  onOpenBlankBrowser,
  onOpenBrowserUrl,
  onShowWorkspace,
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
    const stored = readNumber(STORAGE_KEYS.lastLaunchProjectId, 0);
    return (projects.find((p) => p.id === stored) ?? projects[0] ?? null)?.id ?? null;
  });
  const [manualTargetProjectId, setManualTargetProjectId] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projectIndex, setProjectIndex] = useState(0);
  const [launchers, setLaunchers] = useState<Launcher[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const effectiveProjectId = manualTargetProjectId ?? targetProjectId;

  // P11 — same posture as Settings.tsx: a fresh mount per open (this
  // component's own header comment above already says so), so `active: true`
  // for the whole lifetime is correct. `initialFocusRef: inputRef` replaces
  // the old bare `inputRef.current?.focus()` effect below with the hook's
  // own focus-on-open, rather than running both. `role="dialog"` +
  // `aria-modal="true"` for the same reason as Settings — `.overlay-backdrop`
  // covers the whole page.
  //
  // Escape is NOT wired to this hook — it's already handled on the search
  // input's own onKeyDown below (closes on Escape regardless of which
  // element inside the palette currently has focus, since Tab-ing to e.g.
  // the worktree checkbox doesn't move it off that handler... actually it
  // does; see App.tsx's `handleGlobalEscape`, which is what actually covers
  // that gap (U9) and is why closeSettings/clearPalette live there, not
  // here).
  //
  // suppressRestore(): almost every action in this palette closes it by ALSO
  // opening something else (a launched session, an existing session/
  // workspace, a GitHub/Git/Skills/Dock panel, a browser tab, Settings'
  // Integrations section) — each of those moves focus to whatever it opened
  // (a terminal pane per PR13/U7, a Settings modal, ...), and without this
  // the trap's own restore-on-close effect would win the race and snap focus
  // back to whatever triggered the palette right after. `closeAfterAction`
  // below is the one path that does; the Escape key and the backdrop click
  // are the only two that close WITHOUT opening anything, so they call
  // `onClose` directly and get the normal restore-to-trigger behavior.
  //
  // Mobile/tablet touch fix — `initialFocusRef: inputRef` (unconditionally,
  // before this change) auto-raised the on-screen keyboard the instant this
  // opened on a coarse pointer, covering the very list the launcher exists
  // to show. `isCoarsePointer` swaps the trap's initial focus target to
  // `modalRef` itself (given `tabIndex={-1}` below so it's actually
  // focusable) instead of suppressing initial focus outright — the trap
  // still needs a focus anchor inside the dialog for its own Tab cycle and
  // for a11y, same reasoning as `BrowserPanel.tsx`'s own
  // `autoFocus={... && !isCoarsePointer}` for the same class of problem.
  // Tapping the search input directly still raises the keyboard, same as
  // any other input — this only changes what grabs focus on OPEN.
  const isCoarsePointer = useCoarsePointer();
  const modalRef = useRef<HTMLDivElement>(null);
  const { onKeyDown: onTrapKeyDown, suppressRestore } = useFocusTrap({
    active: true,
    containerRef: modalRef,
    initialFocusRef: isCoarsePointer ? modalRef : inputRef,
  });
  const closeAfterAction = () => {
    suppressRestore();
    onClose();
  };

  // See `onShowWorkspace`'s own doc comment on CommandPaletteProps — falls
  // back to the store action directly when the caller doesn't need to know
  // about it, same optional-prop-with-fallback shape as WorkspaceSwitcher's
  // own `onSelectWorkspace`.
  const selectWorkspace = (workspaceId: number) => {
    if (onShowWorkspace) {
      onShowWorkspace(workspaceId);
    } else {
      useDashboardStore.getState().showWorkspace(workspaceId);
    }
  };

  // Independent code review — `(pointer: coarse)` is deliberately not
  // width- or touch-event-gated (layoutTier.ts's own comment: a touchscreen
  // laptop, or a 2-in-1's keyboard-attach transition, both count), so the
  // coarse-pointer anchor above also fires for hardware-keyboard-equipped
  // touch devices — an iPad/Android tablet with an attached keyboard, a
  // touchscreen laptop. On those, typing/arrow-nav/Enter are normally
  // reachable only through the search input's own onKeyDown below; with
  // focus anchored on the dialog instead, they'd otherwise go nowhere until
  // the user manually taps the input first. Redirecting focus to the input
  // on the first non-Tab, non-Escape keystroke — WITHOUT calling
  // preventDefault — lets the browser deliver that same keystroke to the
  // newly-focused input (verified: a focus change made synchronously inside
  // a keydown handler is honored by the browser's own default action for
  // that same event, the same "type to search" trick VS Code's and Slack's
  // command palettes use), so a keyboard-equipped device keeps working
  // exactly as before this fix. Escape is excluded because it's the close
  // key (handled on the input's own onKeyDown once focus lands there, and
  // by App.tsx's handleGlobalEscape regardless) — redirecting focus for it
  // would just add an extra step before closing, not open. Tab is excluded
  // because onTrapKeyDown below already gives it a specific meaning (wrap to
  // the first/last focusable descendant) that this must not preempt.
  const onDialogKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      document.activeElement === modalRef.current &&
      e.key !== "Tab" &&
      e.key !== "Escape" &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      inputRef.current?.focus();
    }
    onTrapKeyDown(e);
  };

  // Issue #271, option 1 — the launcher's opt-in "isolate this session"
  // toggle: launch directly into a fresh worktree instead of the target
  // project's own cwd. Off by default; <WorktreeOptions> only fetches
  // branches once the toggle is switched on, not on every palette open.
  // `worktreeEnabled`/`worktreeBaseRef` stay lifted here (not owned by
  // <WorktreeOptions>) because `launch()` below also reads them at launch
  // time.
  const [worktreeEnabled, setWorktreeEnabled] = useState(false);
  const [worktreeBaseRef, setWorktreeBaseRef] = useState("");

  // The three parallel filter pipelines (Sessions / Workspaces / launcher
  // "Matching commands") plus the combined-index keyboard nav across them —
  // see useCommandSearch.ts for the full doc comment on the index math.
  const {
    query,
    setQuery,
    setSelectedIndex,
    filtered,
    matchingSessions,
    matchingWorkspaces,
    entries,
    activeIndex,
    activeEntry,
    groupOffset,
  } = useCommandSearch({
    scope,
    effectiveProjectId,
    sessions,
    projects,
    workspaces,
    launchers,
    hiddenAgents: settings.launchers.hiddenAgents,
  });

  const filteredProjects = useMemo(() => {
    if (!pickerOpen) return projects;
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.cwd.toLowerCase().includes(q),
    );
  }, [pickerOpen, query, projects]);

  const activeProjectIndex = Math.min(
    Math.max(0, projectIndex),
    Math.max(0, filteredProjects.length - 1),
  );

  // Same scrollIntoView-on-active-index convention as CustomSelect.tsx
  // (data-index + querySelector, rather than one ref per row) — keeps the
  // ArrowUp/ArrowDown-highlighted project visible in a long, scrollable list.
  const projectListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const item = projectListRef.current?.querySelector(
      `[data-index="${activeProjectIndex}"]`,
    ) as HTMLElement | null;
    item?.scrollIntoView?.({ block: "nearest" });
  }, [pickerOpen, activeProjectIndex]);

  // `query` is shared with the main search box (useCommandSearch owns it) —
  // the picker repurposes it as its own filter text while open, so opening
  // must stash whatever the user had already typed and closing (by any of
  // the four paths: toggle-off, Escape, Enter-select, row click) must put it
  // back. Without this, leftover picker-filter text (e.g. "beta") silently
  // filters "Matching commands" down to nothing right after picking a
  // project — see PR #811 review.
  const savedQueryRef = useRef("");

  const openProjectPicker = () => {
    savedQueryRef.current = query;
    setQuery("");
    const currentIdx = projects.findIndex((p) => p.id === effectiveProjectId);
    setProjectIndex(currentIdx >= 0 ? currentIdx : 0);
    setPickerOpen(true);
  };

  const closeProjectPicker = () => {
    setQuery(savedQueryRef.current);
    setPickerOpen(false);
  };

  const toggleProjectPicker = () => {
    if (pickerOpen) {
      closeProjectPicker();
    } else {
      openProjectPicker();
    }
  };

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

  // P9 — this used to be `void createSession(...).then(...)` with no
  // `.catch` at all: a failed launch (a 4xx from a bad worktree base ref, a
  // 503 from a dead remote host, ...) left the palette open showing nothing
  // but a search box, with the only evidence anything went wrong being an
  // unhandled rejection in the console. `launching`/`launchError` are new
  // local state (same "an inline error near the control that triggered the
  // request" shape as <WorktreeOptions>'s own branches-fetch error and
  // UnifiedBoard.tsx's TasksToolbar) — critically, the failure path must NOT
  // call onClose():
  // closing on failure would unmount the very component about to render the
  // error, hiding it from the user just as reliably as never catching the
  // rejection did.
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const launch = (launcher: Launcher) => {
    if (effectiveProjectId === null || launching) return;
    writeNumber(STORAGE_KEYS.lastLaunchProjectId, effectiveProjectId);
    const name = expandSessionNamePattern(settings.sessions.namePattern, {
      agent: launcher.title,
      project: target?.name ?? "",
      n: sessions.filter((s) => s.projectId === effectiveProjectId).length + 1,
    });
    const trimmedBaseRef = worktreeBaseRef.trim();
    setLaunching(true);
    setLaunchError(null);
    useDashboardStore
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
        closeAfterAction();
      })
      .catch((err: unknown) => {
        console.debug("[CommandPalette] launch failed", err);
        setLaunching(false);
        setLaunchError(err instanceof Error ? err.message : "Failed to launch — try again.");
      });
  };

  return (
    <div className="overlay-backdrop cmd-palette-backdrop" onClick={onClose}>
      <div
        ref={modalRef}
        className="cmd-palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        // Only meaningful as a focus target when isCoarsePointer's own
        // initialFocusRef switch (above) points the trap at this div
        // instead of the search input — a non-interactive container needs
        // tabIndex={-1} to be programmatically focusable at all, without
        // adding it to the regular Tab order (the pointer-fine path never
        // uses this; it still lands on the input directly).
        tabIndex={-1}
      >
        <div className="cmd-palette-search">
          <SearchIcon size={17} strokeWidth={1.9} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (pickerOpen) {
                setProjectIndex(0);
              }
            }}
            placeholder={pickerOpen ? "Filter projects…" : "Launch a session or run a command…"}
            aria-activedescendant={
              pickerOpen && filteredProjects.length > 0
                ? `cmd-palette-project-opt-${activeProjectIndex}`
                : undefined
            }
            onKeyDown={(e) => {
              if (pickerOpen) {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  closeProjectPicker();
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setProjectIndex(Math.min(activeProjectIndex + 1, filteredProjects.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setProjectIndex(Math.max(activeProjectIndex - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const pickedProject = filteredProjects[activeProjectIndex];
                  if (pickedProject) {
                    setManualTargetProjectId(pickedProject.id);
                    closeProjectPicker();
                  }
                }
                return;
              }
              if (e.key === "Escape") {
                onClose();
              } else if (e.key === "ArrowDown" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                openProjectPicker();
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
                  closeAfterAction();
                } else if (picked.type === "workspace") {
                  selectWorkspace(picked.workspace.id);
                  closeAfterAction();
                } else {
                  launch(picked.launcher);
                }
              }
            }}
          />
          <span className="kbd">esc</span>
        </div>

        {launchError && (
          <div className="cmd-palette-launch-error" title={launchError}>
            {launchError}
          </div>
        )}

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
                type="button"
                className={`cmd-palette-target-chip clickable${pickerOpen ? " open" : ""}`}
                title={target?.cwd ?? ""}
                onClick={toggleProjectPicker}
                aria-expanded={pickerOpen}
                aria-haspopup="listbox"
                aria-label={`Target project: ${target?.name ?? "choose a project"}. Tap to change.`}
              >
                <FolderIcon size={13} style={{ color: "var(--accent-solid)" }} />
                <span className="cmd-palette-target-name">
                  {target?.name ?? "choose a project"}
                </span>
                <ChevronDownIcon
                  size={13}
                  strokeWidth={2.2}
                  className={`cmd-palette-target-chevron${pickerOpen ? " open" : ""}`}
                />
              </button>
              {!pickerOpen && <span className="cmd-palette-change-target">⌘↓ change target</span>}
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
          {!pickerOpen && effectiveProjectId !== null && (
            <WorktreeOptions
              projectId={effectiveProjectId}
              enabled={worktreeEnabled}
              onEnabledChange={setWorktreeEnabled}
              baseRef={worktreeBaseRef}
              onBaseRefChange={setWorktreeBaseRef}
            />
          )}
        </div>

        {!pickerOpen && effectiveProjectId !== null && (
          <div className="cmd-palette-options-strip">
            <div
              style={{
                visibility:
                  activeEntry?.type === "launcher" && activeEntry.launcher.kind === "agent"
                    ? "visible"
                    : "hidden",
              }}
              aria-hidden={
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
          <div className="cmux-scroll cmd-palette-list" role="listbox" ref={projectListRef}>
            <div className="cmd-palette-group-label">
              {filteredProjects.length === 0 ? "No matching projects" : "Choose a project"}
            </div>
            {filteredProjects.map((p, idx) => (
              <button
                type="button"
                key={p.id}
                id={`cmd-palette-project-opt-${idx}`}
                role="option"
                aria-selected={idx === activeProjectIndex}
                data-index={idx}
                className={`cmd-row${idx === activeProjectIndex ? " selected" : ""}`}
                onClick={() => {
                  setManualTargetProjectId(p.id);
                  closeProjectPicker();
                }}
                onMouseEnter={() => setProjectIndex(idx)}
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
                {idx === activeProjectIndex && <span className="kbd">↵</span>}
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
                    closeAfterAction();
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
                      closeAfterAction();
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
                      closeAfterAction();
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
                      closeAfterAction();
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
                      onOpenDockConfig(effectiveProjectId);
                      closeAfterAction();
                    }}
                  >
                    <span
                      className="cmd-row-icon"
                      style={{ background: "color-mix(in srgb, var(--fg) 8%, transparent)" }}
                    >
                      <DockIcon size={13} style={{ color: "var(--muted)" }} />
                    </span>
                    <span className="cmd-row-body">
                      <span className="cmd-row-title">Dock: {target?.name ?? "this project"}</span>
                      <span className="cmd-row-subtitle">Edit this project's dock monitors</span>
                    </span>
                  </button>
                )}
                {effectiveProjectId !== null && (
                  <button
                    className="cmd-row"
                    onClick={() => {
                      onOpenSkills(effectiveProjectId);
                      closeAfterAction();
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
                      closeAfterAction();
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
                          closeAfterAction();
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
                    closeAfterAction();
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
                    closeAfterAction();
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
                        closeAfterAction();
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
                        selectWorkspace(workspace.id);
                        closeAfterAction();
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
            {pickerOpen
              ? filteredProjects[activeProjectIndex]?.name
                ? `Select ${filteredProjects[activeProjectIndex]?.name}`
                : "Select project"
              : activeEntry?.type === "session"
                ? "Open session"
                : activeEntry?.type === "workspace"
                  ? "Switch workspace"
                  : `Launch in ${target?.name ?? "…"}`}
          </span>
          {pickerOpen && (
            <span className="cmd-palette-footer-item">
              <span className="kbd">esc</span>Back
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
