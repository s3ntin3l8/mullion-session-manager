import { useContext, useEffect, useState } from "react";
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
import { CloseIcon, OverflowIcon, PlusIcon, PullIcon, RenameIcon } from "../ui/icons.js";
import { KebabMenu } from "../ui/KebabMenu.js";
import type { KebabMenuItem } from "../ui/KebabMenu.js";
import { Dropdown } from "../ui/primitives.js";
import { LauncherProjectActionsContext } from "./launcherProjectActions.js";

const NO_SESSIONS: Session[] = [];

// The project dropdown's last entry. Never a project id: picking it opens the
// Add project view and leaves the selection where it was.
const ADD_PROJECT = "__add-project__";

// The Where section's Project row (#3048, #3071): the project dropdown, whose
// last entry is "Add project…", and a "⋯" menu with the chosen project's
// Edit, Git pull and Delete (what the sidebar project header's menu runs,
// sidebar/projectActions.tsx) plus "Add project…" again. The menu is an
// anchored popover under a fine pointer and a bottom sheet under a coarse one
// (ui/KebabMenu.tsx). Add and Edit are not run here: they replace the
// launcher's body with their form (LauncherProjectView, below).
//
// Renders the control column of a form row (`.launcher-form-control`).
export function LauncherProjectPicker({
  projectId,
  onChange,
  coarse,
  labelId,
  onAddProject,
  onEditProject,
}: {
  projectId: number | null;
  onChange: (projectId: number | null) => void;
  coarse: boolean;
  // The row's visible "Project" label, which names the dropdown.
  labelId: string;
  onAddProject: () => void;
  onEditProject: (projectId: number) => void;
}) {
  const projects = useDashboardStore((s) => s.projects);
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
  const [pulling, setPulling] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const projectOptions = [
    ...(projects.length === 0 ? [{ value: "", label: "No projects yet", disabled: true }] : []),
    ...projects.map((p) => ({ value: String(p.id), label: p.name })),
    { value: ADD_PROJECT, label: "Add project…" },
  ];

  const toast = (message: string, kind: "success" | "error") =>
    useDashboardStore.getState().pushToast({ message, kind });

  const items: KebabMenuItem[] = [];
  if (project) {
    const pull = gitPullState(project, gitStatus);
    items.push(
      {
        key: "edit",
        label: "Edit",
        icon: <RenameIcon size={14} aria-hidden="true" />,
        // The form replaces the body (and this menu's trigger with it).
        opensOverlay: true,
        onClick: () => onEditProject(project.id),
      },
      {
        key: "pull",
        label: pulling ? "Pulling…" : "Git pull",
        icon: <PullIcon size={14} aria-hidden="true" />,
        disabled: pull.disabled || pulling,
        title: pull.title,
        onClick: () => {
          setPulling(true);
          void pullProject(project.id).then((error) => {
            setPulling(false);
            if (error) toast(error, "error");
            else toast(`Pulled ${project.name}.`, "success");
          });
        },
      },
      {
        key: "delete",
        label: deleting ? "Deleting…" : "Delete project",
        disabled: deleting,
        armLabel: coarse ? "Tap again to delete" : "Click again to delete",
        icon: <CloseIcon size={14} aria-hidden="true" />,
        danger: true,
        confirm: true,
        onClick: () => {
          // One delete at a time: a second confirm while the first is in
          // flight would send another DELETE for the same project.
          if (deleting) return;
          setDeleting(true);
          const removed = project;
          void deleteProjectAndEndSessions(
            removed.id,
            projectSessions,
            actions.onSessionEnded,
          ).then((error) => {
            setDeleting(false);
            if (error !== null) {
              toast(error, "error");
              return;
            }
            const next =
              useDashboardStore.getState().projects.find((p) => p.id !== removed.id) ?? null;
            onChange(next?.id ?? null);
          });
        },
      },
    );
  }
  items.push({
    key: "add",
    label: "Add project…",
    icon: <PlusIcon size={13} strokeLinecap="round" strokeWidth={2.2} aria-hidden="true" />,
    opensOverlay: true,
    onClick: onAddProject,
  });

  return (
    <div className="launcher-form-control">
      <Dropdown
        id={`${labelId}-select`}
        className="launcher-form-fill"
        ariaLabel="Project"
        value={projectId !== null ? String(projectId) : ""}
        onChange={(v) => {
          if (v === ADD_PROJECT) onAddProject();
          else if (v !== "") onChange(Number(v));
        }}
        options={projectOptions}
      />
      <KebabMenu
        items={items}
        title={project ? `Manage ${project.name}` : "Manage projects"}
        menuLabel={project ? `${project.name} actions` : "Project actions"}
        triggerClassName={`launcher-project-btn${coarse ? " coarse" : ""}`}
        trigger={<OverflowIcon size={15} aria-hidden="true" />}
        sheet={{ title: project?.name ?? "Projects", closeLabel: "Close project actions" }}
      />
    </div>
  );
}

// The Add project and Edit project views (#3071): the project form fills the
// launcher's body, with a Back control. Done or Back returns to the launcher;
// a project added here (by the form, or one of the discovered repositories)
// comes back selected.
export function LauncherProjectView({
  view,
  onBack,
  onAdded,
}: {
  view: { kind: "add" } | { kind: "edit"; projectId: number };
  onBack: () => void;
  onAdded: (projectId: number) => void;
}) {
  const { projects, hosts, settings, settingsLoaded } = useDashboardStore(
    useShallow((s) => ({
      projects: s.projects,
      hosts: s.hosts,
      settings: s.settings,
      settingsLoaded: s.settingsLoaded,
    })),
  );
  const actions = useContext(LauncherProjectActionsContext);
  const [discoverCollapsed, setDiscoverCollapsed] = useState(false);
  // A project deleted elsewhere while its Edit view is open: nothing left to
  // edit, so go back rather than show an empty body.
  const editGone = view.kind === "edit" && !projects.some((p) => p.id === view.projectId);
  useEffect(() => {
    if (editGone) onBack();
  }, [editGone, onBack]);

  if (view.kind === "edit") {
    const project = projects.find((p) => p.id === view.projectId);
    if (!project) return null;
    return (
      <div className="launcher-project-view">
        <ProjectEditModal project={project} hosts={hosts} onClose={onBack} surface="embedded" />
      </div>
    );
  }
  return (
    <div className="launcher-project-view">
      <CreateProjectModal
        surface="embedded"
        hosts={hosts}
        initialPath={settingsLoaded ? (settings.projectRoots[0] ?? "") : ""}
        // The form closes itself after a create: that is the way back.
        onClose={onBack}
        onCreate={async ({ name, cwd, hostId, createDir, gitInit, placement, allowDuplicate }) => {
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
          onAdded(created.id);
          return created;
        }}
      />
      <div className="launcher-project-discover">
        {/* Scans on mount: only while the Add project view is open. */}
        <DiscoverProjects
          collapsed={discoverCollapsed}
          onToggleCollapsed={() => setDiscoverCollapsed((v) => !v)}
          onOpenSettingsProjects={() => {
            useDashboardStore.getState().closeLauncher();
            actions.onOpenSettingsProjects();
          }}
          hosts={hosts}
          bodyId="launcher-discover-projects"
          onAdded={(added) => {
            onAdded(added.id);
            onBack();
          }}
        />
      </div>
    </div>
  );
}
