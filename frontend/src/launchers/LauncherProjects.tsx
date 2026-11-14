import { useContext, useId, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Session } from "../api/index.js";
import { CreateProjectModal } from "../CreateProjectModal.js";
import { DiscoverProjects } from "../sidebar/DiscoverProjects.js";
import {
  deleteProjectAndEndSessions,
  gitPullState,
  pullProject,
} from "../sidebar/projectActions.js";
import { ProjectEditModal } from "../sidebar/ProjectEditModal.js";
import { useDashboardStore } from "../store/index.js";
import { ConfirmButton } from "../ui/ConfirmButton.js";
import { CloseIcon, OverflowIcon, PlusIcon, PullIcon, RenameIcon } from "../ui/icons.js";
import { Dropdown } from "../ui/primitives.js";
import { ThemedPortal } from "../ui/ThemedPortal.js";
import { LauncherProjectActionsContext } from "./launcherProjectActions.js";

const NO_SESSIONS: Session[] = [];

// The Where row's project choice (#3048): the project dropdown, a "⋯" with the
// chosen project's Edit, Git pull and Delete (what the sidebar project
// header's menu runs, sidebar/projectActions.tsx), and "Add project" (a new
// project, or one of the discovered repositories). The project list is a
// native <select>, which cannot hold a button per option, so the "⋯" acts on
// the selected project. Both open a panel in place under the row rather than
// a menu over the launcher, which is a modal on desktop and a sheet on touch.
//
// Renders inside `.session-launcher-where` (a wrapping flex row); the panel
// takes a full line of its own at the end of it.
export function LauncherProjectPicker({
  projectId,
  onChange,
  coarse,
}: {
  projectId: number | null;
  onChange: (projectId: number | null) => void;
  coarse: boolean;
}) {
  const { projects, hosts, settings, settingsLoaded } = useDashboardStore(
    useShallow((s) => ({
      projects: s.projects,
      hosts: s.hosts,
      settings: s.settings,
      settingsLoaded: s.settingsLoaded,
    })),
  );
  const project = projects.find((p) => p.id === projectId) ?? null;
  const gitStatus = useDashboardStore((s) =>
    projectId !== null ? s.gitStatuses[projectId] : undefined,
  );
  const projectSessions = useDashboardStore(
    useShallow((s) =>
      projectId !== null ? s.sessions.filter((x) => x.projectId === projectId) : NO_SESSIONS,
    ),
  );
  const actions = useContext(LauncherProjectActionsContext);
  const [panel, setPanel] = useState<"manage" | "add" | null>(null);
  const [modal, setModal] = useState<"edit" | "create" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const manageBtnRef = useRef<HTMLButtonElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const [discoverCollapsed, setDiscoverCollapsed] = useState(false);
  const ids = useId();

  const toggle = (next: "manage" | "add") => {
    setMessage(null);
    setPanel((p) => (p === next ? null : next));
  };
  const select = (id: number) => {
    onChange(id);
    setPanel(null);
    setMessage(null);
  };

  const projectOptions = projects.map((p) => ({ value: String(p.id), label: p.name }));
  const deleteArmLabel = coarse ? "Tap again to delete" : "Click again to delete";

  return (
    <>
      {projects.length > 0 ? (
        <Dropdown
          ariaLabel="Project"
          className="session-launcher-project"
          value={projectId !== null ? String(projectId) : ""}
          onChange={(v) => {
            onChange(Number(v));
            setMessage(null);
          }}
          options={projectOptions}
        />
      ) : (
        <span className="session-launcher-hint">No projects yet.</span>
      )}
      <span className={`launcher-project-tools${coarse ? " coarse" : ""}`}>
        {project && (
          <button
            ref={manageBtnRef}
            type="button"
            className="launcher-project-btn"
            aria-label={`Manage ${project.name}`}
            title={`Edit, pull or delete ${project.name}`}
            aria-expanded={panel === "manage"}
            aria-controls={`${ids}-panel`}
            onClick={() => toggle("manage")}
          >
            <OverflowIcon size={15} aria-hidden="true" />
          </button>
        )}
        <button
          ref={addBtnRef}
          type="button"
          className="launcher-project-btn launcher-project-add"
          aria-expanded={panel === "add"}
          aria-controls={`${ids}-panel`}
          onClick={() => toggle("add")}
        >
          <PlusIcon size={13} strokeLinecap="round" strokeWidth={2.2} aria-hidden="true" />
          Add project
        </button>
      </span>
      {panel !== null && (
        <div
          id={`${ids}-panel`}
          className={`launcher-project-panel${coarse ? " coarse" : ""}`}
          role="group"
          aria-label={panel === "manage" && project ? `Manage ${project.name}` : "Add project"}
          onKeyDown={(e) => {
            // Escape closes this panel, not the launcher around it.
            if (e.key === "Escape") {
              e.stopPropagation();
              setPanel(null);
            }
          }}
        >
          {panel === "manage" && project && (
            <>
              <button
                type="button"
                className="launcher-project-row"
                onClick={() => setModal("edit")}
              >
                <RenameIcon size={14} aria-hidden="true" />
                Edit
              </button>
              <button
                type="button"
                className="launcher-project-row"
                // aria-disabled, not disabled: a pull that leaves nothing to
                // pull must not drop keyboard focus out of the launcher.
                aria-disabled={gitPullState(project, gitStatus).disabled || pulling || undefined}
                title={gitPullState(project, gitStatus).title}
                onClick={async () => {
                  if (gitPullState(project, gitStatus).disabled || pulling) return;
                  setMessage(null);
                  setPulling(true);
                  const error = await pullProject(project.id);
                  setPulling(false);
                  setMessage(error ?? "Pulled.");
                }}
              >
                <PullIcon size={14} aria-hidden="true" />
                {pulling ? "Pulling…" : "Git pull"}
              </button>
              <ConfirmButton
                title="Delete project"
                className="launcher-project-row"
                armedLabel={deleteArmLabel}
                onConfirm={async () => {
                  // One delete at a time: a second confirm while the first is
                  // in flight would send another DELETE for the same project.
                  if (deleting) return;
                  setDeleting(true);
                  setMessage(null);
                  const removed = project;
                  const error = await deleteProjectAndEndSessions(
                    removed.id,
                    projectSessions,
                    actions.onSessionEnded,
                  );
                  setDeleting(false);
                  if (error !== null) {
                    setMessage(error);
                    return;
                  }
                  const next =
                    useDashboardStore.getState().projects.find((p) => p.id !== removed.id) ?? null;
                  onChange(next?.id ?? null);
                  setPanel(null);
                  // The panel (and the focused button) is gone: the next
                  // project's "⋯", or "Add project" when none is left.
                  requestAnimationFrame(() => (manageBtnRef.current ?? addBtnRef.current)?.focus());
                }}
              >
                <CloseIcon size={14} aria-hidden="true" />
                {deleting ? "Deleting…" : "Delete project"}
              </ConfirmButton>
            </>
          )}
          {panel === "add" && (
            <>
              <button
                type="button"
                className="launcher-project-row"
                onClick={() => setModal("create")}
              >
                <PlusIcon size={13} strokeLinecap="round" strokeWidth={2.2} aria-hidden="true" />
                New project…
              </button>
              {/* Mounted only while the panel is open: it scans on mount. */}
              <DiscoverProjects
                collapsed={discoverCollapsed}
                onToggleCollapsed={() => setDiscoverCollapsed((v) => !v)}
                onOpenSettingsProjects={() => {
                  useDashboardStore.getState().closeLauncher();
                  actions.onOpenSettingsProjects();
                }}
                hosts={hosts}
                bodyId={`${ids}-discover`}
                onAdded={(added) => select(added.id)}
              />
            </>
          )}
          {message && (
            <div className="launcher-project-message" role="status">
              {message}
            </div>
          )}
        </div>
      )}
      {modal === "edit" && project && (
        <ThemedPortal>
          <ProjectEditModal project={project} hosts={hosts} onClose={() => setModal(null)} />
        </ThemedPortal>
      )}
      {modal === "create" && (
        <ThemedPortal>
          <CreateProjectModal
            hosts={hosts}
            initialPath={settingsLoaded ? (settings.projectRoots[0] ?? "") : ""}
            onClose={() => setModal(null)}
            onCreate={async ({
              name,
              cwd,
              hostId,
              createDir,
              gitInit,
              placement,
              allowDuplicate,
            }) => {
              const store = useDashboardStore.getState();
              const created = await store.createProject(name, cwd, hostId, {
                createDir,
                gitInit,
                placement,
                allowDuplicate,
              });
              // createProject only starts the refresh; wait for it so the
              // dropdown has the new project to show as selected.
              await store.refreshProjects().catch(() => {});
              select(created.id);
              return created;
            }}
          />
        </ThemedPortal>
      )}
    </>
  );
}
