import { useEffect, useState } from "react";
import { api } from "./api.js";
import type { DockControl, GitHubStatus } from "./api.js";
import { useDashboardStore } from "./store.js";
import { ChevronDownIcon, DockIcon, GitHubIcon, PlusIcon } from "./icons.js";
import { TerminalPane } from "./TerminalPane.js";

const DOCK_COLLAPSED_KEY = "crs.dockCollapsed";

// The dock: persistent monitors (dev server, git status, logs) — distinct
// from one-shot session launches. Config is read-only (.crs/dock.json /
// global CRS_CONFIG_DIR/dock.json), so "pinning" a monitor isn't something
// this UI can create; a control here toggles an already-configured monitor
// on/off, which is just a session with kind:"dock" (sessions.ts) that this
// component keeps out of the normal per-project session inventory.
export function Dock({
  projectId,
  onOpenGitHub,
}: {
  projectId: number | null;
  onOpenGitHub: (projectId: number) => void;
}) {
  const { projects, sessions, createSession, deleteSession } = useDashboardStore();
  const [controls, setControls] = useState<DockControl[]>([]);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(DOCK_COLLAPSED_KEY) === "1",
  );
  // Only set once the user explicitly picks a different project from the
  // <select> below — otherwise this just tracks the App-provided default
  // (projects[0]), which App.tsx recomputes on every render, so there's
  // nothing to "sync into state" via an effect.
  const [manualProjectId, setManualProjectId] = useState<number | null>(null);
  const dockProjectId = manualProjectId ?? projectId;
  // null covers both "still loading" and the 204 "not applicable" case
  // (no github.com remote, no account connected, a GitHub API error) —
  // this widget just renders nothing either way, same degrade-to-nothing
  // rule GitHubPanel.tsx follows for the same endpoint.
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);

  useEffect(() => {
    if (dockProjectId === null) return;
    api
      .listProjectDock(dockProjectId)
      .then(setControls)
      .catch(() => setControls([]));
  }, [dockProjectId]);

  useEffect(() => {
    // Same "no reset on null" convention as the controls effect above —
    // dockProjectId only goes null when there are zero projects at all,
    // in which case the whole dock already renders its empty states.
    if (dockProjectId === null) return;
    // Guards against a stale response on a fast project switch — same
    // `cancelled` pattern GitHubPanel.tsx uses for the same endpoint
    // (Hermes review, PR #40).
    let cancelled = false;
    api
      .getProjectGitHub(dockProjectId)
      .then((status) => {
        if (!cancelled) setGithubStatus(status ?? null);
      })
      .catch(() => {
        if (!cancelled) setGithubStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [dockProjectId]);

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      const next = !v;
      localStorage.setItem(DOCK_COLLAPSED_KEY, next ? "1" : "0");
      return next;
    });
  };

  const dockSessions = sessions.filter(
    (s) => s.kind === "dock" && s.projectId === dockProjectId && s.status === "active",
  );
  const liveCount = dockSessions.filter((s) => s.activity === "working" || s.alive).length;
  const project = projects.find((p) => p.id === dockProjectId) ?? null;
  const shownControls = dockProjectId === null ? [] : controls;

  const runningFor = (control: DockControl) =>
    dockSessions.find(
      (s) =>
        s.command === control.command && (control.cwd ?? project?.cwd) === (s.cwd ?? project?.cwd),
    );

  return (
    <div className={`dock${collapsed ? " collapsed" : ""}`}>
      <div className="dock-header">
        <DockIcon size={14} style={{ color: collapsed ? "var(--muted)" : "var(--dim)" }} />
        <span className="dock-title">
          Dock{!collapsed && shownControls.length > 0 ? " · Monitors" : ""}
        </span>
        {collapsed && <span className="dock-monitor-tag">collapsed</span>}
        {!collapsed && liveCount > 0 && (
          <span className="dock-live-count">
            <span className="dock-live-dot" />
            {liveCount} live
          </span>
        )}
        {projects.length > 1 && !collapsed && (
          <select
            value={dockProjectId ?? ""}
            onChange={(e) => setManualProjectId(e.target.value ? Number(e.target.value) : null)}
            style={{ marginLeft: 8 }}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <div className="dock-header-rule" />
        {!collapsed && (
          <button
            className="dock-header-action"
            title=".crs/dock.json is read-only config — add a control there to pin a monitor here"
            disabled
          >
            <PlusIcon size={12} strokeLinecap="round" />
            Pin monitor
          </button>
        )}
        <button
          className="toolbar-icon-btn"
          style={{ width: 22, height: 22 }}
          onClick={toggleCollapsed}
          title={collapsed ? "Expand dock" : "Collapse dock"}
        >
          <ChevronDownIcon
            size={14}
            style={{ transform: collapsed ? "rotate(-90deg)" : undefined }}
          />
        </button>
      </div>
      {!collapsed && githubStatus && dockProjectId !== null && (
        <button
          className="dock-github-row"
          onClick={() => onOpenGitHub(dockProjectId)}
          title={`Open GitHub panel for ${githubStatus.repo.owner}/${githubStatus.repo.repo}`}
        >
          <GitHubIcon size={13} />
          <span className="dock-github-repo">
            {githubStatus.repo.owner}/{githubStatus.repo.repo}
          </span>
          <span className="dock-github-stat">
            {githubStatus.openIssues} issue{githubStatus.openIssues === 1 ? "" : "s"}
          </span>
          <span className="dock-github-stat">
            {githubStatus.openPRs} PR{githubStatus.openPRs === 1 ? "" : "s"}
          </span>
        </button>
      )}
      {!collapsed && (
        <div className="dock-body">
          {shownControls.length === 0 && (
            <div className="dock-empty">No monitors configured for this project</div>
          )}
          {shownControls.map((control) => {
            const running = runningFor(control);
            return (
              <div key={control.id} className="dock-monitor">
                <div
                  className="dock-monitor-header"
                  style={{ cursor: "pointer" }}
                  onClick={() => {
                    if (running) {
                      void deleteSession(running.id);
                    } else if (dockProjectId !== null) {
                      void createSession(dockProjectId, control.command, {
                        cwd: control.cwd,
                        kind: "dock",
                      });
                    }
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: running ? "var(--g)" : "var(--dim)",
                      flexShrink: 0,
                    }}
                  />
                  <span className="dock-monitor-name">{control.title}</span>
                  <span className="dock-monitor-tag">{running ? "on" : "off"}</span>
                </div>
                {running && (
                  <div className="dock-monitor-body">
                    <TerminalPane params={{ sessionId: running.id }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
