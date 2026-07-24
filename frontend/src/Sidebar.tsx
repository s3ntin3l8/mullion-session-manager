import { useCallback, useEffect, useMemo, useState } from "react";
import { useDashboardStore } from "./store.js";
import { ConfirmButton } from "./ConfirmButton.js";
import { CreateProjectModal } from "./CreateProjectModal.js";
import { KebabMenu } from "./KebabMenu.js";
import { api, LOCAL_HOST_ID } from "./api.js";
import type {
  DiscoveredProject,
  GitHubCiStatus,
  GitStatus,
  Host,
  NotificationEvent,
  Project,
  Session,
  Task,
} from "./api.js";
import { describeLatestEvent } from "./eventDescriptions.js";
import { MullionMark } from "./assets/MullionMark.js";
import { Dropdown } from "./settings/primitives.js";
import { resolveAgentLogo, commandToBinary } from "./cliLogos.js";
import { PromoteDialog } from "./PromoteDialog.js";
import {
  ChevronDownIcon,
  CloseIcon,
  FolderIcon,
  GitBranchIcon,
  GitHubIcon,
  HostsIcon,
  PlusIcon,
  RenameIcon,
  SearchAlertIcon,
  SearchIcon,
} from "./icons.js";

interface SidebarProps {
  onOpenSession: (session: Session) => void;
  onSessionEnded: (session: Session) => void;
  // Opens the command palette scoped to this project (design's project-row
  // "+" button) — cwd is bound implicitly, no target-picker step needed.
  onOpenProjectLauncher: (projectId: number) => void;
  // "Configure search roots" in the discovery empty state (design section
  // 03·1C) opens Settings straight to the Projects tab.
  onOpenSettingsProjects: () => void;
}

export function Sidebar({
  onOpenSession,
  onSessionEnded,
  onOpenProjectLauncher,
  onOpenSettingsProjects,
}: SidebarProps) {
  const {
    projects,
    sessions,
    hosts,
    tasks,
    taskMasterEnabled,
    refreshProjects,
    refreshSessions,
    refreshHosts,
    refreshTasks,
    claimTask,
    hideEndedSessions,
    createProject,
    settings,
    settingsLoaded,
  } = useDashboardStore();
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  // Lifted here (rather than owned entirely inside DiscoverProjects) so the
  // "Welcome to Mullion" empty state's "Scan for repos" button can force it
  // open, matching the design's two-button first-run CTA.
  const [discoverCollapsed, setDiscoverCollapsed] = useState(true);

  useEffect(() => {
    void refreshProjects();
    void refreshSessions();
    void refreshHosts();
    // Phase 2.5 Task Master, Thin Slice (issue #219) — loaded on mount
    // alongside everything else above rather than waiting for
    // startLiveRefresh's ~60s-throttled tick to reach it first.
    void refreshTasks();
  }, [refreshProjects, refreshSessions, refreshHosts, refreshTasks]);

  return (
    <div className="sidebar">
      <div className="sidebar-section-header">
        <span className="sidebar-section-title">Projects</span>
        <span className="project-session-count">sessions</span>
        <button
          className="toolbar-icon-btn"
          style={{ width: 22, height: 22 }}
          title="Add project"
          onClick={() => setAddProjectOpen(true)}
        >
          <PlusIcon size={15} strokeLinecap="round" strokeWidth={1.9} />
        </button>
      </div>
      {projects.length === 0 ? (
        <div className="empty-state">
          <MullionMark size={32} className="empty-state-mark" />
          <div className="empty-state-title">Welcome to Mullion</div>
          <div className="empty-state-body">
            Add a project folder to start — sessions run there and survive across restarts.
          </div>
          <div className="empty-state-actions">
            <button className="empty-state-btn-primary" onClick={() => setAddProjectOpen(true)}>
              <PlusIcon size={12} strokeLinecap="round" strokeWidth={2.2} />
              Add a project
            </button>
            <button
              className="empty-state-btn-secondary"
              onClick={() => setDiscoverCollapsed(false)}
            >
              <SearchIcon size={12} strokeWidth={2} />
              Scan for repos
            </button>
          </div>
        </div>
      ) : (
        projects.map((project) => (
          <ProjectSection
            key={project.id}
            project={project}
            hosts={hosts}
            // Deliberately NOT filtered to status === "active" by default —
            // an *exited* session (program ended on its own) still shows,
            // just dimmed, matching the design's States doc badge grid
            // (Working/Idle/Attention/Exited — confirmed against the design
            // source, no "Killed" badge exists there). A *killed* session
            // (explicit user action via the guarded overflow-menu action) is
            // unconditionally excluded — the design's kill demo never shows a
            // persisted sidebar row for it, only a pane-level "Session
            // killed" screen. Settings -> Sessions' "hide ended sessions"
            // toggle additionally hides exited sessions too, if wanted.
            sessions={sessions.filter(
              (s) =>
                s.projectId === project.id &&
                s.kind === "terminal" &&
                s.status !== "killed" &&
                (!hideEndedSessions || s.status === "active"),
            )}
            onOpenSession={onOpenSession}
            onSessionEnded={onSessionEnded}
            onOpenLauncher={() => onOpenProjectLauncher(project.id)}
          />
        ))
      )}
      {taskMasterEnabled && (
        <TasksSection
          tasks={tasks}
          onClaim={(task) =>
            claimTask(task.id).then((session) => {
              onOpenSession(session);
            })
          }
        />
      )}
      <DiscoverProjects
        collapsed={discoverCollapsed}
        onToggleCollapsed={() => setDiscoverCollapsed((v) => !v)}
        onOpenSettingsProjects={onOpenSettingsProjects}
        hosts={hosts}
      />
      {addProjectOpen && (
        <CreateProjectModal
          hosts={hosts}
          initialPath={settingsLoaded ? (settings.projectRoots[0] ?? "") : ""}
          onClose={() => setAddProjectOpen(false)}
          onCreate={(name, cwd, hostId) => createProject(name, cwd, hostId)}
        />
      )}
    </div>
  );
}

// Phase 2.5 Task Master, Thin Slice (issue #219) — a plain sidebar section,
// not a new dockview panel (see the roadmap's Phase 2.5 design notes and
// #219's own scope trim: "wired into existing UI (sidebar/dock)"). Only
// pending tasks get a Claim button here; claimed tasks (spawned into a
// session already) drop out of this list — that session is what the
// existing sidebar's Projects section now surfaces instead. Rendered only
// when taskMasterEnabled (Sidebar's own gate above), so an empty `tasks`
// array here always means "enabled but nothing pending" rather than
// "disabled" — no separate empty state needed.
export function TasksSection({
  tasks,
  onClaim,
}: {
  tasks: Task[];
  onClaim: (task: Task) => Promise<void>;
}) {
  const pending = tasks.filter((t) => t.status === "pending");
  const [claimingId, setClaimingId] = useState<number | null>(null);
  const [errorId, setErrorId] = useState<number | null>(null);

  if (pending.length === 0) return null;

  const claim = (task: Task) => {
    setClaimingId(task.id);
    setErrorId(null);
    onClaim(task)
      .catch(() => setErrorId(task.id))
      .finally(() => setClaimingId(null));
  };

  return (
    <div className="tasks-section">
      <div className="sidebar-section-header">
        <span className="sidebar-section-title">Tasks</span>
        <span className="project-session-count">{pending.length}</span>
      </div>
      {pending.map((task) => (
        <div className="task-row" key={task.id}>
          <GitHubIcon size={13} className="task-row-icon" />
          <div className="task-row-body">
            <a
              className="task-row-title"
              href={task.htmlUrl}
              target="_blank"
              rel="noreferrer"
              title={task.title}
            >
              {task.title}
            </a>
            <span className="task-row-meta">
              {task.projectName} · #{task.issueNumber}
            </span>
            {errorId === task.id && (
              <span className="task-row-error">Failed to claim — try again</span>
            )}
          </div>
          <button
            className="task-claim-btn"
            disabled={claimingId === task.id}
            onClick={() => claim(task)}
          >
            {claimingId === task.id ? "Claiming…" : "Claim"}
          </button>
        </div>
      ))}
    </div>
  );
}

function ProjectSection({
  project,
  sessions,
  hosts,
  onOpenSession,
  onSessionEnded,
  onOpenLauncher,
}: {
  project: Project;
  sessions: Session[];
  hosts: Host[];
  onOpenSession: (session: Session) => void;
  onSessionEnded: (session: Session) => void;
  onOpenLauncher: () => void;
}) {
  const { deleteProject, deleteSession, updateProject } = useDashboardStore();
  // `manualCollapsed` is null until the user explicitly toggles — until then,
  // collapsed state is *derived* from whether the project has sessions
  // (empty projects start collapsed). A plain `useState(sessions.length ===
  // 0)` would be wrong here: projects and sessions load via independent
  // effects (see Sidebar's own refreshProjects/refreshSessions above), so a
  // project can mount with `sessions === []` before its sessions have
  // arrived, permanently collapsing an otherwise-active project. Deriving
  // instead means it stays reactive to that data landing, and "sticks" once
  // the user has an opinion.
  const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(null);
  const collapsed = manualCollapsed ?? sessions.length === 0;
  const [editOpen, setEditOpen] = useState(false);

  const attentionCount = sessions.filter((s) => s.attention).length;
  // Only a remote project needs a badge at all — the common single-host
  // deployment never shows one, matching CreateProjectModal's own selector
  // only appearing once a remote host exists.
  const host = project.hostId !== LOCAL_HOST_ID ? hosts.find((h) => h.id === project.hostId) : null;

  // Per-project git dirty badge (issue #76) — sourced from the store's
  // gitStatuses map (polled alongside sessions, see store.ts's
  // startLiveRefresh). A missing entry (not fetched yet, right after mount,
  // or a project that's genuinely never been a repo) renders the same as
  // `null` — both read as "nothing to report" rather than a distinct loading
  // state, which would just flicker on every mount. A project that HAS had a
  // successful fetch keeps showing that last-known-good entry through any
  // later transient failure (refreshGitStatuses preserves it rather than
  // overwriting with null) — this is what stops the dot from flickering
  // green→grey on a single flaky poll tick.
  const gitStatus = useDashboardStore((s) => s.gitStatuses[project.id]);
  const gitDotClass = !gitStatus
    ? "none"
    : gitStatus.hasConflicts
      ? "conflict"
      : gitStatus.isClean
        ? "clean"
        : "dirty";
  const gitDotTitle = !gitStatus
    ? "Not a git repository"
    : gitStatus.hasConflicts
      ? `${gitStatus.branch}: unresolved merge conflicts`
      : gitStatus.isClean
        ? `${gitStatus.branch}: clean`
        : `${gitStatus.branch}: ${gitStatus.files.length} changed file${gitStatus.files.length === 1 ? "" : "s"}`;

  return (
    <div className="project-row">
      <div className="project-row-header" onClick={() => setManualCollapsed(!collapsed)}>
        <ChevronDownIcon
          size={12}
          className={collapsed ? "ws-group-chevron collapsed" : "ws-group-chevron"}
        />
        <FolderIcon size={15} />
        <span className="project-row-name" title={project.cwd}>
          {project.name}
        </span>
        <span className={`project-git-dot ${gitDotClass}`} title={gitDotTitle} />
        {host && (
          <span className="project-host-badge" title={`Runs on host: ${host.name}`}>
            <HostsIcon size={10} />
            {host.name}
          </span>
        )}
        {attentionCount > 0 && <span className="project-attn-pill">{attentionCount}</span>}
        <span className="project-session-count">{sessions.length}</span>
        <button
          className="project-add-session"
          title="New session in project"
          onClick={(e) => {
            e.stopPropagation();
            onOpenLauncher();
          }}
        >
          <PlusIcon size={13} strokeLinecap="round" strokeWidth={2.2} />
        </button>
        <span onClick={(e) => e.stopPropagation()}>
          <KebabMenu
            title="More…"
            items={[
              {
                key: "edit",
                label: "Edit",
                icon: <RenameIcon size={14} style={{ color: "var(--muted)" }} />,
                onClick: () => setEditOpen(true),
              },
              {
                key: "delete",
                label: "Delete project",
                armLabel: "Click again to delete",
                icon: <CloseIcon size={14} />,
                danger: true,
                confirm: true,
                onClick: () => {
                  const endedSessions = sessions;
                  void deleteProject(project.id).then(() => {
                    endedSessions.forEach(onSessionEnded);
                  });
                },
              },
            ]}
          />
        </span>
      </div>
      {editOpen && (
        <CreateProjectModal
          mode="edit"
          initialName={project.name}
          initialPath={project.cwd}
          initialDevServerUrl={project.devServerUrl}
          detectedDevServerPort={project.detectedDevServerPort}
          onClose={() => setEditOpen(false)}
          onCreate={(name, cwd, _hostId, devServerUrl) =>
            updateProject(project.id, { name, cwd, devServerUrl })
          }
        />
      )}

      {!collapsed && (
        <div className="project-row-body">
          {sessions.length === 0 ? (
            <div className="project-empty-note">No sessions yet</div>
          ) : (
            sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                project={project}
                onOpen={() => onOpenSession(session)}
                onEnd={() => void deleteSession(session.id).then(() => onSessionEnded(session))}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// The 4 status treatments the redesign's States doc specifies (confirmed
// against the design source — its tab-chrome badge grid has exactly these
// four, no "Killed" badge): attention (prominent, animated, "needs input"),
// working (green pulse), idle (hollow dot), exited (dimmed, program ended
// on its own). A killed session never reaches this component — Sidebar.tsx
// filters `status === "killed"` out of the list before it gets here, since
// the design's kill flow removes the row entirely rather than leaving a
// dimmed tombstone (see Sidebar's own filter comment). Attention takes
// priority over working/idle since it's the highest-value signal for an
// unwatched dashboard.

// describeEvent/describeLatestEvent (the kind/payload interpretation this
// row's status line uses) moved to eventDescriptions.ts for #169, which
// needed the exact same rules for its event-feed panel — see that module's
// own doc comment.

// Row 3's expand/collapse toggle (issue #202) persists per session, same
// single-localStorage-key convention as the sidebar's own collapse/width
// state (store.ts's SIDEBAR_COLLAPSED_KEY/SIDEBAR_WIDTH_KEY) rather than one
// key per session — there's no existing per-*session* persisted-UI-state
// precedent to follow instead (ProjectSection's own collapse above is
// in-memory `useState`, derived fresh each mount). Module-level (not store
// state) since this is pure, session-scoped UI state no other component
// needs to read.
const EXPANDED_SESSION_ROWS_KEY = "crs.expandedSessionRows";

function readExpandedSessionRows(): Set<number> {
  try {
    const raw = localStorage.getItem(EXPANDED_SESSION_ROWS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((n) => typeof n === "number") : []);
  } catch {
    return new Set();
  }
}

// Read once at module load (mirrors readStoredSidebarWidth's own shape in
// store.ts) — every SessionRow instance shares this one Set rather than
// each re-reading localStorage on mount.
const expandedSessionRows = readExpandedSessionRows();

function setSessionRowExpanded(sessionId: number, expanded: boolean): void {
  if (expanded) expandedSessionRows.add(sessionId);
  else expandedSessionRows.delete(sessionId);
  localStorage.setItem(EXPANDED_SESSION_ROWS_KEY, JSON.stringify([...expandedSessionRows]));
}

// Same clean/dirty/conflict/none taxonomy as ProjectSection's own gitStatus
// handling above, reused here for row 3's dirty dot (`.project-git-dot`) —
// kept as a small local helper rather than a shared export since
// ProjectSection's version is inlined into its own render and this is the
// only other call site (matches git-refs.ts's own "small guards get
// duplicated, not shared" precedent elsewhere in this codebase).
function sessionGitDotClass(status: GitStatus): "clean" | "dirty" | "conflict" {
  if (status.hasConflicts) return "conflict";
  return status.isClean ? "clean" : "dirty";
}

// Same "success/failure/in_progress/null -> good/bad/pending/none" mapping
// as GitHubPanel.tsx's own ciDotClass — duplicated rather than imported for
// the same "small guard, not worth a cross-module dependency" reasoning.
function sessionPrDotClass(status: GitHubCiStatus): "good" | "bad" | "pending" | "none" {
  if (status === "success") return "good";
  if (status === "failure") return "bad";
  if (status === "in_progress") return "pending";
  return "none";
}

interface FileChangeSummary {
  path: string;
  action: "modify" | "create" | "delete";
  count: number;
  lastSeq: number;
}

const FILE_CHANGE_MAX_SHOWN = 5;

// Row 4 (issue #177) — collapses this session's raw `file_change` hook
// events (see eventDescriptions.ts's own file_change case for the payload
// shape) into one summary per path: the most recent action wins, `count`
// is how many times that path was touched recently. `events` is
// oldest-first (store.ts's addEvent), so a single forward scan naturally
// leaves the latest action/seq in place with no extra sort-then-scan step.
function summarizeFileChanges(events: NotificationEvent[] | undefined): FileChangeSummary[] {
  if (!events) return [];
  const byPath = new Map<string, FileChangeSummary>();
  for (const event of events) {
    if (event.kind !== "file_change") continue;
    const path = typeof event.payload.path === "string" ? event.payload.path : null;
    const action = event.payload.action;
    if (!path || (action !== "modify" && action !== "create" && action !== "delete")) continue;
    const existing = byPath.get(path);
    if (existing) {
      existing.action = action;
      existing.count += 1;
      existing.lastSeq = event.seq;
    } else {
      byPath.set(path, { path, action, count: 1, lastSeq: event.seq });
    }
  }
  return Array.from(byPath.values()).sort((a, b) => b.lastSeq - a.lastSeq);
}

// Reuses the same letter+dot language as GitPanel.tsx's own per-file status
// badges (create/A -> good, delete/D -> bad, modify/M -> pending) rather
// than inventing a fourth dot vocabulary for this one strip.
function fileChangeDotClass(action: FileChangeSummary["action"]): "good" | "bad" | "pending" {
  if (action === "create") return "good";
  if (action === "delete") return "bad";
  return "pending";
}

function fileChangeLetter(action: FileChangeSummary["action"]): "A" | "D" | "M" {
  if (action === "create") return "A";
  if (action === "delete") return "D";
  return "M";
}

export function SessionRow({
  session,
  project,
  onOpen,
  onEnd,
  alwaysExpandGit = false,
}: {
  session: Session;
  project: Project;
  onOpen: () => void;
  onEnd: () => void;
  // KanbanBoard.tsx's cards pass this — the board has room to always show
  // git details, so its cards skip the collapse-by-default toggle this row
  // uses everywhere else (the sidebar's own narrow, scrollable tree).
  alwaysExpandGit?: boolean;
}) {
  const isTerminal = session.status === "killed";
  const confirmBeforeKill = useDashboardStore((s) => s.settings.sessions.confirmBeforeKill);
  const theme = useDashboardStore((s) => s.theme);
  // Issue #167 — the 1.1 events store slice (store.ts's `events`, fed by
  // eventsClient.ts), scoped to just this session's list. Selector-based so
  // a live event for a DIFFERENT session's list doesn't re-render this row.
  const sessionEvents = useDashboardStore((s) => s.events[session.id]);
  const eventLine = describeLatestEvent(sessionEvents);
  const agentLogo = resolveAgentLogo(session.command, theme);
  const agentBinary = commandToBinary(session.command);

  // Row 4 (issue #177) — recent file changes, derived from the same
  // sessionEvents slice as row 2's eventLine above (no separate fetch).
  const fileChanges = useMemo(
    () => summarizeFileChanges(sessionEvents).slice(0, FILE_CHANGE_MAX_SHOWN),
    [sessionEvents],
  );
  const [expandedFilePath, setExpandedFilePath] = useState<string | null>(null);
  const expandedFileChange = expandedFilePath
    ? fileChanges.find((fc) => fc.path === expandedFilePath)
    : undefined;

  // Row 3's data (issue #202) — worktree/branch/PR/diff-stats. Selector-based
  // per field (not one selector returning an object) so a live update to a
  // DIFFERENT session's — or a different project's — slice doesn't re-render
  // this row, same reasoning as sessionEvents above.
  const gitStatus = useDashboardStore((s) => s.sessionGitStatuses[session.id]);
  const diffStats = useDashboardStore((s) => s.gitDiffStats[session.id]);
  const branchesResult = useDashboardStore((s) => s.gitBranchesByProject[project.id]);
  const prsStatus = useDashboardStore((s) => s.prsByProject[project.id]);

  // Issue #271 — auto-opens for an agent-triggered `promote_request` (the
  // model's tool call is blocked until this dialog resolves it, one way or
  // another — see PromoteDialog's own header comment) and stays available
  // via the kebab menu below for a human-initiated promote otherwise.
  // Adjusts state during render (React's own recommended pattern for
  // "reopen when a prop transitions", not an Effect — see
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)
  // rather than a `useEffect` + setState, which the project's lint config
  // (react-hooks/set-state-in-effect) rejects as a cascading-render risk.
  // Initializer covers a row that mounts already "pending" (e.g. a page
  // refresh while a request is mid-flight); the render-time check below
  // covers a later transition into "pending" on an already-mounted row.
  const [promoteOpen, setPromoteOpen] = useState(() => session.promoteState === "pending");
  const [prevPromoteState, setPrevPromoteState] = useState(session.promoteState);
  if (session.promoteState !== prevPromoteState) {
    setPrevPromoteState(session.promoteState);
    if (session.promoteState === "pending") setPromoteOpen(true);
  }

  const [gitLineExpanded, setGitLineExpanded] = useState(() => expandedSessionRows.has(session.id));
  const toggleGitLineExpanded = useCallback(() => {
    setGitLineExpanded((prev) => {
      const next = !prev;
      setSessionRowExpanded(session.id, next);
      return next;
    });
  }, [session.id]);
  const gitExpanded = alwaysExpandGit || gitLineExpanded;

  // A worktree session's effective cwd — prefers the shell's OSC-7-announced
  // live cwd (session.liveCwd) over the static session.cwd override, falling
  // back to the project's own cwd; see routes/projects.ts's
  // resolveSessionCwdTargets for the backend's identical derivation (issue:
  // sidebar worktree display — a session whose shell `cd`s into a worktree
  // after launch only shows that worktree here once liveCwd reflects it).
  // Matched against this project's own worktree list — `undefined`/no match
  // (the common case: most sessions just run at the project's own cwd, which
  // is always the *main* worktree) means no worktree label, not an error.
  const effectiveCwd = session.liveCwd ?? session.cwd ?? project.cwd;
  const worktree = branchesResult?.worktrees.find((w) => w.path === effectiveCwd && !w.isMain);
  const worktreeLabel = worktree ? (worktree.path.split("/").filter(Boolean).pop() ?? null) : null;

  // The open PR (if any) for this session's own branch — matched
  // client-side against the project's unfiltered PR list rather than
  // firing a `?branch=` request per session (api.ts's getProjectGitHubPRs
  // doc comment).
  const matchedPr =
    gitStatus && prsStatus?.prs
      ? prsStatus.prs.find((pr) => pr.headBranch === gitStatus.branch)
      : undefined;

  const title =
    session.nameLocked && session.name
      ? session.name
      : session.lastTitle
        ? session.lastTitle
        : session.command;

  const showCommand = title === session.command;
  // Suppress the agent binary label when the title already starts with it
  // (e.g. command fallback "npm run build" already includes "npm") to avoid
  // redundant "npm npm run build" rendering.
  const showAgentFallback =
    !agentLogo && !(title === agentBinary || title.startsWith(agentBinary + " "));

  let statusClass = "";
  let dot: React.ReactNode;
  let statusLabel: React.ReactNode;

  if (session.status === "exited") {
    statusClass = "status-exited";
    dot = (
      <span className="session-dot-wrap">
        <CloseIcon size={10} style={{ color: "var(--dim)" }} />
      </span>
    );
    statusLabel = <span className="session-status-label exited">exited</span>;
  } else if (session.attention) {
    statusClass = "status-attention";
    dot = <span className="session-dot-attention" />;
    statusLabel = <span className="session-status-label attention">Needs input</span>;
  } else if (session.activity === "working") {
    dot = (
      <span className="session-dot-wrap">
        <span className="session-dot-working" />
      </span>
    );
    statusLabel = <span className="session-status-label working">working</span>;
  } else {
    dot = (
      <span className="session-dot-wrap">
        <span className="session-dot-idle" />
      </span>
    );
    statusLabel = <span className="session-status-label idle">idle</span>;
  }

  const onDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.dataTransfer.setData("application/x-mullion-session", String(session.id));
      e.dataTransfer.setData("text/plain", title);
      e.dataTransfer.effectAllowed = "move";
    },
    [session.id, title],
  );

  return (
    <>
      <div
        className={`session-item ${statusClass}`}
        onClick={onOpen}
        draggable={true}
        onDragStart={onDragStart}
      >
        <div className="session-item-row">
          {dot}
          {agentLogo && (
            <img src={agentLogo} alt="" width={14} height={14} className="session-agent-logo" />
          )}
          {showAgentFallback && <span className="session-agent-text">{agentBinary}</span>}
          <span className={`session-name${showCommand ? " mono" : ""}`} title={title}>
            {title}
          </span>
          {statusLabel}
          {/* Row 3's toggle (issue #202) — only rendered once there's a
            fetched, non-null git status for this session's effective cwd;
            "nothing to show" (not a repo, or not fetched yet) means no
            toggle at all, not a toggle that expands to an empty row.
            Suppressed entirely when `alwaysExpandGit` is set (KanbanBoard.tsx's
            cards) — the board always shows details, so there's nothing to
            toggle. */}
          {gitStatus != null && !alwaysExpandGit && (
            <span onClick={(e) => e.stopPropagation()}>
              <button
                className="session-git-toggle"
                title={gitLineExpanded ? "Hide git details" : "Show git details"}
                onClick={toggleGitLineExpanded}
              >
                <ChevronDownIcon
                  size={11}
                  className={gitLineExpanded ? "ws-group-chevron" : "ws-group-chevron collapsed"}
                />
              </button>
            </span>
          )}
          {!isTerminal && (
            <span onClick={(e) => e.stopPropagation()}>
              <KebabMenu
                title="More…"
                items={[
                  {
                    key: "promote",
                    label: "Promote to worktree…",
                    icon: <GitBranchIcon size={14} style={{ color: "var(--muted)" }} />,
                    onClick: () => setPromoteOpen(true),
                  },
                ]}
              />
            </span>
          )}
          {!isTerminal && (
            <span onClick={(e) => e.stopPropagation()}>
              <ConfirmButton
                title="End this session (the program will be terminated)"
                onConfirm={onEnd}
                skipConfirm={!confirmBeforeKill}
              >
                <CloseIcon size={11} />
              </ConfirmButton>
            </span>
          )}
        </div>
        {eventLine && (
          <span
            className={`session-event-line${eventLine.attention ? " attention" : ""}`}
            title={eventLine.text}
          >
            {eventLine.text}
          </span>
        )}
        {/* Single-line summary, not a second-tier "full" layout with its own
          narrow variant: the sidebar's resizable width defaults to (and can
          go no lower than) SIDEBAR_MIN_WIDTH (store.ts), so any JS width
          threshold for hiding content here would either be unreachable or
          hide content at the *default* width — neither is "shrinks when
          space is tight." `.session-git-line`'s own `overflow: hidden` +
          ellipsis (styles.css) is what actually delivers that: the line
          truncates as the sidebar narrows, same as row 2's
          `.session-event-line` already does. */}
        {gitExpanded && gitStatus != null && (
          <div className="session-git-line">
            <span
              className={`project-git-dot ${sessionGitDotClass(gitStatus)}`}
              title={
                gitStatus.hasConflicts
                  ? `${gitStatus.branch}: unresolved merge conflicts`
                  : gitStatus.isClean
                    ? `${gitStatus.branch}: clean`
                    : `${gitStatus.branch}: ${gitStatus.files.length} changed file${gitStatus.files.length === 1 ? "" : "s"}`
              }
            />
            <span className="session-git-branch" title={gitStatus.branch}>
              {gitStatus.branch}
            </span>
            {worktreeLabel && (
              <span className="session-git-worktree" title={effectiveCwd}>
                @ {worktreeLabel}
              </span>
            )}
            {matchedPr && (
              <a
                href={matchedPr.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="session-git-pr"
                title={matchedPr.title}
                onClick={(e) => e.stopPropagation()}
              >
                <span className={`github-panel-ci-dot ${sessionPrDotClass(matchedPr.ciStatus)}`} />#
                {matchedPr.number}
              </a>
            )}
            {diffStats && diffStats.filesChanged > 0 && (
              <span className="session-git-diffstat">
                {diffStats.filesChanged} file{diffStats.filesChanged === 1 ? "" : "s"}{" "}
                <span className="session-git-ins">+{diffStats.insertions}</span>{" "}
                <span className="session-git-del">-{diffStats.deletions}</span>
              </span>
            )}
          </div>
        )}
        {/* Row 4 (issue #177) — recent file changes from the structured hook
          channel (Phase 2), not the git working-tree diff row 3 shows above.
          Always visible once there's at least one file_change event, same
          ungated posture as row 2 — not nested inside the git-details
          toggle, since an agent can emit these without the session's cwd
          even being a git repo. */}
        {fileChanges.length > 0 && (
          <div className="session-file-changes-line">
            {fileChanges.map((fc) => {
              const filename = fc.path.split("/").pop() || fc.path;
              return (
                <button
                  key={fc.path}
                  type="button"
                  className="session-file-change-chip"
                  title={fc.path}
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpandedFilePath((prev) => (prev === fc.path ? null : fc.path));
                  }}
                >
                  <span className={`github-panel-ci-dot ${fileChangeDotClass(fc.action)}`} />
                  <span className="session-file-change-letter">{fileChangeLetter(fc.action)}</span>
                  <span className="session-file-change-name">{filename}</span>
                </button>
              );
            })}
          </div>
        )}
        {/* Click-to-expand detail (issue #177's explicit scope: path + action
          + occurrence count, no actual diff content — see the follow-up
          issue filed alongside this PR for real diff rendering). */}
        {expandedFileChange && (
          <div className="session-file-change-detail" onClick={(e) => e.stopPropagation()}>
            <span className="session-file-change-detail-path" title={expandedFileChange.path}>
              {expandedFileChange.path}
            </span>
            <span className="session-file-change-detail-meta">
              {fileChangeLetter(expandedFileChange.action)} · {expandedFileChange.count} change
              {expandedFileChange.count === 1 ? "" : "s"}
            </span>
          </div>
        )}
      </div>
      {promoteOpen && (
        <PromoteDialog session={session} project={project} onClose={() => setPromoteOpen(false)} />
      )}
    </>
  );
}

// Vision item #1 — suggests candidates from PROJECTS_ROOTS, never
// auto-inserts. Read-only until the user clicks Add, which is just the
// existing POST /api/projects the manual form above already uses.
//
// `candidates` distinguishes "not yet fetched" (null) from "fetched, zero
// results" ([]) — the design's empty state 1C ("discovery ran · nothing
// found / roots unconfigured") only applies to the latter; rendering
// nothing while the very first fetch is still in flight avoids a state
// flash on load.
function DiscoverProjects({
  collapsed,
  onToggleCollapsed,
  onOpenSettingsProjects,
  hosts,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenSettingsProjects: () => void;
  hosts: Host[];
}) {
  const { createProject, refreshProjects } = useDashboardStore();
  const [candidates, setCandidates] = useState<DiscoveredProject[] | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [hostId, setHostId] = useState(LOCAL_HOST_ID);
  // Distinguishes "discovery ran, found nothing" from "discovery failed" —
  // both otherwise render as an identical "0 found" empty state, which
  // reads a genuinely unreachable host the same as an empty search root
  // (Hermes review, PR #35).
  const [discoverError, setDiscoverError] = useState(false);
  const remoteHosts = hosts.filter((h) => h.id !== LOCAL_HOST_ID);
  // The selected host can be deleted (Settings -> Hosts) while this panel
  // is open — `hostId` itself only ever changes via the picker's onChange,
  // so falling back here (derived at render time, not an effect writing
  // state back) is what actually keeps discovery from targeting an id that
  // no longer exists, without an extra render/effect round-trip (Hermes
  // review, PR #35). "This machine" is always present, so this is a no-op
  // for the common single-host case.
  const selectedHostId =
    hostId === LOCAL_HOST_ID || remoteHosts.some((h) => h.id === hostId) ? hostId : LOCAL_HOST_ID;

  // Deliberately doesn't reset `candidates` to null up front — switching
  // hosts would otherwise flash the "0 found" empty state on every change
  // instead of just replacing the list once the new host's results land.
  // `added` resets alongside it (inside the same async callback, not
  // synchronously in the effect body — react-hooks/set-state-in-effect):
  // a cwd match is per-(hostId, cwd), same as the backend's own
  // registeredCwds query in routes/projects.ts, so the previous host's
  // "just added" set is meaningless once `forHostId` changes.
  const load = (forHostId: string) => {
    api
      .discoverProjects(forHostId)
      .then((found) => {
        setCandidates(found);
        setAdded(new Set());
        setDiscoverError(false);
      })
      .catch(() => {
        setCandidates([]);
        setAdded(new Set());
        setDiscoverError(true);
      });
  };

  useEffect(() => {
    load(selectedHostId);
  }, [selectedHostId]);

  if (candidates === null) return null;

  const remaining = candidates.filter((c) => !c.isRegistered && !added.has(c.cwd));

  // Only rendered once a remote host actually exists — same "no extra UI
  // for a single-host deployment" rule CreateProjectModal's own selector
  // follows.
  const hostPicker = remoteHosts.length > 0 && (
    <span onClick={(e) => e.stopPropagation()}>
      <Dropdown
        small
        value={selectedHostId}
        onChange={setHostId}
        options={[
          { value: LOCAL_HOST_ID, label: "This machine" },
          ...remoteHosts.map((h) => ({ value: h.id, label: h.name })),
        ]}
      />
    </span>
  );

  if (remaining.length === 0) {
    return (
      <div className="discover-block">
        <div className="empty-state">
          <span className="empty-state-icon warn">
            <SearchAlertIcon size={18} />
          </span>
          <div className="empty-state-title">
            {discoverError ? "Discovery failed" : "No repositories found"}
          </div>
          <div className="empty-state-body">
            {discoverError
              ? "Couldn't reach the selected host to scan for repositories. Check that it's online and try again."
              : "Mullion scanned your search roots but found no git projects. Point it at a folder that contains your repos."}
          </div>
          {hostPicker && <div style={{ marginTop: 8 }}>{hostPicker}</div>}
          <div className="empty-state-actions">
            {!discoverError && (
              <button className="empty-state-btn-primary" onClick={onOpenSettingsProjects}>
                Configure search roots
              </button>
            )}
            <button className="empty-state-btn-secondary" onClick={() => load(selectedHostId)}>
              {discoverError ? "Retry" : "Rescan"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="discover-block">
      <div className="discover-header" onClick={onToggleCollapsed}>
        <ChevronDownIcon
          size={14}
          className={collapsed ? "ws-group-chevron collapsed" : "ws-group-chevron"}
        />
        <span className="discover-title">Discover projects</span>
        <span className="discover-count">{remaining.length} found</span>
        {hostPicker}
      </div>
      {!collapsed && (
        <div className="discover-body">
          {remaining.map((c) => (
            <div key={c.cwd} className="discover-item">
              <FolderIcon size={14} style={{ color: "var(--muted)" }} />
              <span className="discover-item-name">{c.name}</span>
              {c.isGitRepo && <span className="discover-git-badge">git</span>}
              <button
                className="discover-add"
                onClick={() => {
                  void createProject(c.name, c.cwd, selectedHostId).then(() => {
                    setAdded((prev) => new Set(prev).add(c.cwd));
                    void refreshProjects();
                  });
                }}
              >
                Add
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
