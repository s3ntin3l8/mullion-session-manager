import { useCallback, useEffect, useState } from "react";
import { useDashboardStore } from "./store.js";
import { ConfirmButton } from "./ConfirmButton.js";
import { CreateProjectModal } from "./CreateProjectModal.js";
import { KebabMenu } from "./KebabMenu.js";
import { api, LOCAL_HOST_ID } from "./api.js";
import type { DiscoveredProject, Host, Project, Session } from "./api.js";
import { TesseraMark } from "./assets/TesseraMark.js";
import { Dropdown } from "./settings/primitives.js";
import {
  ChevronDownIcon,
  CloseIcon,
  FolderIcon,
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
    refreshProjects,
    refreshSessions,
    refreshHosts,
    hideEndedSessions,
    createProject,
  } = useDashboardStore();
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  // Lifted here (rather than owned entirely inside DiscoverProjects) so the
  // "Welcome to Tessera" empty state's "Scan for repos" button can force it
  // open, matching the design's two-button first-run CTA.
  const [discoverCollapsed, setDiscoverCollapsed] = useState(false);

  useEffect(() => {
    void refreshProjects();
    void refreshSessions();
    void refreshHosts();
  }, [refreshProjects, refreshSessions, refreshHosts]);

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
          <TesseraMark size={32} className="empty-state-mark" />
          <div className="empty-state-title">Welcome to Tessera</div>
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
      <DiscoverProjects
        collapsed={discoverCollapsed}
        onToggleCollapsed={() => setDiscoverCollapsed((v) => !v)}
        onOpenSettingsProjects={onOpenSettingsProjects}
        hosts={hosts}
      />
      {addProjectOpen && (
        <CreateProjectModal
          hosts={hosts}
          onClose={() => setAddProjectOpen(false)}
          onCreate={(name, cwd, hostId) => createProject(name, cwd, hostId)}
        />
      )}
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
function SessionRow({
  session,
  onOpen,
  onEnd,
}: {
  session: Session;
  onOpen: () => void;
  onEnd: () => void;
}) {
  const isTerminal = session.status === "killed";
  const label = session.name || session.command;
  const confirmBeforeKill = useDashboardStore((s) => s.settings.sessions.confirmBeforeKill);

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
      e.dataTransfer.setData("application/x-tessera-session", String(session.id));
      e.dataTransfer.setData("text/plain", label);
      e.dataTransfer.effectAllowed = "move";
    },
    [session.id, label],
  );

  return (
    <div
      className={`session-item ${statusClass}`}
      onClick={onOpen}
      draggable={true}
      onDragStart={onDragStart}
    >
      {dot}
      <span className={`session-name${!session.name ? " mono" : ""}`}>{label}</span>
      {statusLabel}
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
              : "Tessera scanned your search roots but found no git projects. Point it at a folder that contains your repos."}
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
