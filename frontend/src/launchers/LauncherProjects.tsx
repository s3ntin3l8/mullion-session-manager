import { useContext, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Session } from "../api/index.js";
import { CreateProjectModal } from "../CreateProjectModal.js";
import {
  DiscoverEmptyState,
  DiscoverHostPicker,
  DiscoverItem,
} from "../sidebar/DiscoverProjects.js";
import { useDiscoveredProjects } from "../sidebar/useDiscoveredProjects.js";
import type { DiscoveredProjects } from "../sidebar/useDiscoveredProjects.js";
import {
  deleteProjectAndEndSessions,
  gitPullState,
  pullProject,
} from "../sidebar/projectActions.js";
import { ProjectEditModal } from "../sidebar/ProjectEditModal.js";
import { useDashboardStore } from "../store/index.js";
import {
  ChevronRightIcon,
  CloseIcon,
  FolderIcon,
  OverflowIcon,
  PlusIcon,
  PullIcon,
  RenameIcon,
  SearchIcon,
} from "../ui/icons.js";
import { KebabMenu } from "../ui/KebabMenu.js";
import type { KebabMenuItem } from "../ui/KebabMenu.js";
import { Modal } from "../ui/Modal.js";
import { Dropdown, TextInput } from "../ui/primitives.js";
import { LauncherProjectActionsContext } from "./launcherProjectActions.js";

const NO_SESSIONS: Session[] = [];

// The project dropdown's last entry. Never a project id: picking it opens the
// Add project view and leaves the selection where it was.
const ADD_PROJECT = "__add-project__";
const ADD_PROJECT_LABEL = "Add project…";
// How long a typeahead search keeps adding letters (browsers use about 1s).
const TYPEAHEAD_MS = 1000;
// The Discovered repositories view offers a search field above this many.
const DISCOVERED_SEARCH_MIN = 8;

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
  // The typeahead the guard below runs itself once it has taken a letter
  // from the browser: the letters typed so far and when the last one came.
  const typeaheadRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });

  const projectOptions = [
    ...(projects.length === 0 ? [{ value: "", label: "No projects yet", disabled: true }] : []),
    ...projects.map((p) => ({ value: String(p.id), label: p.name })),
    { value: ADD_PROJECT, label: ADD_PROJECT_LABEL },
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

  // A closed native <select> changes its value on ArrowDown, End, PageDown
  // and typeahead (Windows and Linux): any of them could land on "Add
  // project…" and open the Add view by surprise. Those keys stop at the
  // projects. The guard cannot tell the open list from the closed control,
  // so with the keyboard Add project… is reached through the "⋯" menu; the
  // dropdown entry is for the pointer.
  const guardAddEntry = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const select = e.target as HTMLElement;
    if (!(select instanceof HTMLSelectElement) || e.altKey || e.metaKey || e.ctrlKey) return;
    const index = projects.findIndex((p) => String(p.id) === select.value);
    const last = projects.at(-1);
    if (e.key === "End" || e.key === "PageDown") {
      // The browser would jump to the final option, which is Add project….
      e.preventDefault();
      if (last && index !== projects.length - 1) onChange(last.id);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      if (index >= projects.length - 1) e.preventDefault();
      return;
    }
    if (e.key.length !== 1) return;
    // Typeahead. A letter Add project… starts with would let the browser
    // cycle onto it, so the guard takes that letter, and every letter typed
    // after it within the browser's own typeahead window, and searches the
    // projects only: "a" cycles the a-projects, "at" narrows to "atlas".
    const key = e.key.toLowerCase();
    const now = Date.now();
    const buffer = typeaheadRef.current;
    const continuing = buffer.text !== "" && now - buffer.at < TYPEAHEAD_MS;
    if (!continuing && !ADD_PROJECT_LABEL.toLowerCase().startsWith(key)) {
      buffer.text = "";
      return;
    }
    e.preventDefault();
    const text = continuing ? buffer.text + key : key;
    typeaheadRef.current = { text, at: now };
    // One letter repeated ("a", "aa") cycles, as the browser's typeahead does.
    const repeated = [...text].every((c) => c === text[0]);
    if (repeated) {
      const matches = projects.filter((p) => p.name.toLowerCase().startsWith(text[0]!));
      if (matches.length === 0) return;
      const at = matches.findIndex((p) => String(p.id) === select.value);
      onChange(matches[(at + 1) % matches.length]!.id);
      return;
    }
    const match = projects.find((p) => p.name.toLowerCase().startsWith(text));
    if (match && String(match.id) !== select.value) onChange(match.id);
  };

  return (
    <div className="launcher-form-control" onKeyDown={guardAddEntry}>
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
  const { projects, hosts } = useDashboardStore(
    useShallow((s) => ({ projects: s.projects, hosts: s.hosts })),
  );
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
  return <LauncherAddProject onBack={onBack} onAdded={onAdded} />;
}

// The Add project view (#3244): the form, led by one row that opens the
// discovered repositories as their own view. The scan runs while this view
// is mounted (the Add view or the discovered view over it) and both read
// the same one. The form stays mounted, hidden, under the discovered view,
// so Back finds what was typed into it.
function LauncherAddProject({
  onBack,
  onAdded,
}: {
  onBack: () => void;
  onAdded: (projectId: number) => void;
}) {
  const { hosts, settings, settingsLoaded } = useDashboardStore(
    useShallow((s) => ({
      hosts: s.hosts,
      settings: s.settings,
      settingsLoaded: s.settingsLoaded,
    })),
  );
  const actions = useContext(LauncherProjectActionsContext);
  const [discoveredOpen, setDiscoveredOpen] = useState(false);
  const rowRef = useRef<HTMLButtonElement>(null);
  // Back from the discovered view: focus the row that opened it.
  const refocusRow = useRef(false);
  useEffect(() => {
    if (discoveredOpen || !refocusRow.current) return;
    refocusRow.current = false;
    rowRef.current?.focus();
  }, [discoveredOpen]);
  const discovery = useDiscoveredProjects({
    hosts,
    onAdded: (added) => {
      onAdded(added.id);
      onBack();
    },
  });

  const openSettingsProjects = () => {
    useDashboardStore.getState().closeLauncher();
    actions.onOpenSettingsProjects();
  };
  const closeDiscovered = () => {
    refocusRow.current = true;
    setDiscoveredOpen(false);
  };

  const { remaining } = discovery;
  const lead =
    remaining === null ? (
      <div className="launcher-discovered-row" aria-busy="true">
        <FolderIcon size={15} aria-hidden="true" />
        <span className="launcher-discovered-row-label">Looking for repositories…</span>
      </div>
    ) : remaining.length === 0 ? (
      <div className="launcher-discovered-hint">
        <DiscoverEmptyState discovery={discovery} onOpenSettingsProjects={openSettingsProjects} />
      </div>
    ) : (
      <button
        ref={rowRef}
        type="button"
        className="launcher-discovered-row"
        onClick={() => setDiscoveredOpen(true)}
      >
        <FolderIcon size={15} aria-hidden="true" />
        <span className="launcher-discovered-row-label">
          Choose from {remaining.length} discovered{" "}
          {remaining.length === 1 ? "repository" : "repositories"}
        </span>
        <ChevronRightIcon size={15} aria-hidden="true" />
      </button>
    );

  return (
    <div className="launcher-project-view">
      <div className="launcher-project-form" hidden={discoveredOpen}>
        <CreateProjectModal
          surface="embedded"
          hosts={hosts}
          lead={lead}
          initialPath={settingsLoaded ? (settings.projectRoots[0] ?? "") : ""}
          // The form closes itself after a create: that is the way back.
          onClose={onBack}
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
            onAdded(created.id);
            return created;
          }}
        />
      </div>
      {discoveredOpen && (
        <LauncherDiscoveredView
          discovery={discovery}
          onBack={closeDiscovered}
          onOpenSettingsProjects={openSettingsProjects}
        />
      )}
    </div>
  );
}

// The Discovered repositories view (#3244): the repositories the scan found,
// each with its Add action, in the same shell as the project form (Back,
// title; Escape goes back). Above DISCOVERED_SEARCH_MIN of them a search
// field filters them by name.
function LauncherDiscoveredView({
  discovery,
  onBack,
  onOpenSettingsProjects,
}: {
  discovery: DiscoveredProjects;
  onBack: () => void;
  onOpenSettingsProjects: () => void;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const remaining = discovery.remaining ?? [];
  // Decided on the whole list, so the field does not vanish while typing.
  const searchable = remaining.length > DISCOVERED_SEARCH_MIN;
  const needle = query.trim().toLowerCase();
  const shown =
    searchable && needle !== ""
      ? remaining.filter((c) => c.name.toLowerCase().includes(needle))
      : remaining;
  const hostPicker = discovery.remoteHosts.length > 0;

  return (
    <Modal
      surface="embedded"
      onClose={onBack}
      icon={<FolderIcon size={16} />}
      title="Discovered repositories"
      subtitle="Repositories Mullion found under your project roots."
      initialFocusRef={searchable ? searchRef : undefined}
    >
      {remaining.length === 0 ? (
        // Everything was added as a checkout, or a host switch found nothing.
        <DiscoverEmptyState discovery={discovery} onOpenSettingsProjects={onOpenSettingsProjects} />
      ) : (
        <>
          {(searchable || hostPicker) && (
            <div className="launcher-discovered-tools">
              {searchable && (
                <div className="launcher-discovered-search">
                  <SearchIcon size={15} strokeWidth={1.9} aria-hidden="true" />
                  <TextInput
                    ref={searchRef}
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search repositories"
                    aria-label="Search repositories"
                  />
                </div>
              )}
              <DiscoverHostPicker discovery={discovery} />
            </div>
          )}
          <div className="discover-body launcher-discovered-list" role="list">
            {shown.map((c) => (
              <div key={c.cwd} role="listitem">
                <DiscoverItem candidate={c} discovery={discovery} />
              </div>
            ))}
          </div>
          {shown.length === 0 && (
            <p className="launcher-discovered-none">No repository matches “{query.trim()}”.</p>
          )}
        </>
      )}
    </Modal>
  );
}
