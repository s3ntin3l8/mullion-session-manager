import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import { AgentRulesPanel } from "../AgentRulesPanel.js";
import { DockConfigPanel } from "../DockConfigPanel.js";
import { ErrorBoundary } from "../ErrorBoundary.js";
import { ProjectBriefingPanel } from "../ProjectBriefingPanel.js";
import { ProjectSetupPanel } from "../ProjectSetupPanel.js";
import { SettingsShell, type SettingsShellSection } from "../settings/SettingsShell.js";
import { useDashboardStore } from "../store/index.js";
import type { ProjectSettingsSection, ProjectSettingsTarget } from "../store/types.js";
import { DockIcon, FileTextIcon } from "../ui/icons.js";
import { Button } from "../ui/sidebar/Button.js";

interface BodyProps {
  params: { projectId: number; view?: "previews"; rev?: number };
  onDirtyChange?: (dirty: boolean) => void;
}

interface SectionDef extends SettingsShellSection<ProjectSettingsSection> {
  Body: ComponentType<BodyProps>;
}

// Same names and copy as the sidebar's Project view rows.
const PROJECT_SETTINGS_SECTIONS: readonly SectionDef[] = [
  {
    id: "agent-rules",
    title: "Agent Rules",
    desc: "CLAUDE.md, AGENTS.md, GEMINI.md",
    icon: (size) => <FileTextIcon size={size} />,
    Body: AgentRulesPanel,
  },
  {
    id: "briefing",
    title: "Mullion Briefing",
    desc: "DB-authored — pushed on top of whatever AGENTS.md already says",
    icon: (size) => <FileTextIcon size={size} />,
    Body: ProjectBriefingPanel,
  },
  {
    id: "scaffold",
    title: "Scaffold Mullion",
    desc: "Commit a briefing region, skill, and reviewer subagent as a PR",
    icon: (size) => <FileTextIcon size={size} />,
    Body: ProjectSetupPanel,
  },
  {
    id: "dock",
    title: "Dock",
    desc: "Edit this project's dock monitors",
    icon: (size) => <DockIcon size={size} />,
    Body: DockConfigPanel,
  },
];

// One section's body behind its own ErrorBoundary, so one editor's crashing
// fetch doesn't take the others (or the dialog) down.
function SectionBody({
  def,
  target,
  onDirtyChange,
}: {
  def: SectionDef;
  target: ProjectSettingsTarget;
  onDirtyChange: (id: ProjectSettingsSection, dirty: boolean) => void;
}) {
  const [resetKey, setResetKey] = useState(0);
  const report = useCallback(
    (dirty: boolean) => onDirtyChange(def.id, dirty),
    [def.id, onDirtyChange],
  );
  return (
    <ErrorBoundary onReset={() => setResetKey((k) => k + 1)}>
      <def.Body
        key={resetKey}
        params={{
          projectId: target.projectId,
          view: def.id === "dock" ? target.dockView : undefined,
          rev: target.rev,
        }}
        onDirtyChange={report}
      />
    </ErrorBoundary>
  );
}

// Asks before leaving over an unsaved draft. "Keep editing" unmounts the
// focused button, which would drop focus to <body>, outside the modal's Tab
// trap: its cleanup hands focus to the dialog's close button instead.
function LeaveBanner({
  text,
  onKeep,
  onDiscard,
}: {
  text: string;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const modal = ref.current?.closest(".settings-modal");
    return () => {
      if (modal?.isConnected) modal.querySelector<HTMLElement>(".settings-modal-close")?.focus();
    };
  }, []);
  return (
    <div ref={ref} className="project-settings-leave" role="alert">
      <span>{text}</span>
      <Button size="sm" variant="ghost" onClick={onKeep} autoFocus>
        Keep editing
      </Button>
      <Button size="sm" variant="danger" onClick={onDiscard}>
        Discard
      </Button>
    </div>
  );
}

// #3406 — one project's editors in a full-size dialog with Settings' own
// frame (SettingsShell). Mounted by ProjectSettingsHost only while open and
// keyed by project, so its editors never carry one project's draft into
// another's. Every way out goes through the store's
// requestCloseProjectSettings, which asks first over an unsaved draft.
export function ProjectSettingsDialog({
  target,
  phone = false,
  backStack = false,
}: {
  target: ProjectSettingsTarget;
  phone?: boolean;
  backStack?: boolean;
}) {
  const projectName = useDashboardStore(
    (s) => s.projects.find((p) => p.id === target.projectId)?.name ?? null,
  );
  const leave = useDashboardStore((s) => s.projectSettingsLeave);
  const requestClose = useDashboardStore((s) => s.requestCloseProjectSettings);
  const confirmLeave = useDashboardStore((s) => s.confirmLeaveProjectSettings);
  const cancelLeave = useDashboardStore((s) => s.cancelLeaveProjectSettings);
  const setDirty = useDashboardStore((s) => s.setProjectSettingsDirty);

  const [active, setActive] = useState<ProjectSettingsSection>(target.section);
  // Visited sections stay mounted (hidden), so an unsaved draft in Agent
  // Rules or Briefing survives switching away and back.
  const [visited, setVisited] = useState<ReadonlySet<ProjectSettingsSection>>(
    () => new Set([target.section]),
  );
  // A new open (fresh rev) re-targets the dialog, adjusted during render
  // rather than in an effect (react.dev, "adjusting state when a prop changes").
  const [lastRev, setLastRev] = useState(target.rev);
  if (target.rev !== lastRev) {
    setLastRev(target.rev);
    setActive(target.section);
  }
  if (!visited.has(active)) setVisited(new Set([...visited, active]));

  // Which editors hold a draft; the store only needs whether any does.
  const [dirtyBy, setDirtyBy] = useState<ReadonlySet<ProjectSettingsSection>>(new Set());
  const onDirtyChange = useCallback((id: ProjectSettingsSection, dirty: boolean) => {
    setDirtyBy((prev) => {
      if (prev.has(id) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const anyDirty = dirtyBy.size > 0;
  useEffect(() => {
    setDirty(anyDirty);
  }, [anyDirty, setDirty]);
  useEffect(() => () => setDirty(false), [setDirty]);

  const meta = PROJECT_SETTINGS_SECTIONS.find((s) => s.id === active)!;
  const dirtyNames = PROJECT_SETTINGS_SECTIONS.filter((s) => dirtyBy.has(s.id))
    .map((s) => s.title)
    .join(" and ");

  return (
    <SettingsShell
      title={projectName ? `Project settings — ${projectName}` : "Project settings"}
      closeLabel="Close project settings"
      listLabel="project settings list"
      sections={PROJECT_SETTINGS_SECTIONS}
      active={meta}
      onSelect={setActive}
      onClose={requestClose}
      // Every opener names a section, so the phone always starts on it.
      startOnContent
      bodyClassName="project-settings-content"
      phone={phone}
      backStack={backStack}
      banner={
        leave && (
          <LeaveBanner
            text={`Unsaved changes in ${dirtyNames || "this project"}. ${
              leave.next ? "Discard them and switch project?" : "Discard them and close?"
            }`}
            onKeep={cancelLeave}
            onDiscard={confirmLeave}
          />
        )
      }
    >
      {PROJECT_SETTINGS_SECTIONS.filter((s) => visited.has(s.id)).map((s) => (
        <div
          key={s.id}
          className="project-settings-body"
          data-section={s.id}
          hidden={active !== s.id}
        >
          <SectionBody def={s} target={target} onDirtyChange={onDirtyChange} />
        </div>
      ))}
    </SettingsShell>
  );
}

// Renders the dialog while the store says it is open. Its own component so
// App only mounts one element for it.
export function ProjectSettingsHost({
  phone = false,
  backStack = false,
}: {
  phone?: boolean;
  backStack?: boolean;
}) {
  const target = useDashboardStore((s) => s.projectSettings);
  // A project deleted or merged away while its dialog is open: nothing left to
  // save, so it closes outright. Gated on a successful load, as
  // useCloseStaleProjectPanels is, or every dialog would close before
  // GET /api/projects resolves.
  const gone = useDashboardStore(
    (s) =>
      s.projectSettings !== null &&
      s.projectsLoaded &&
      s.projectsError === null &&
      !s.projects.some((p) => p.id === s.projectSettings!.projectId),
  );
  useEffect(() => {
    if (gone) {
      useDashboardStore.setState({
        projectSettings: null,
        projectSettingsLeave: null,
        projectSettingsDirty: false,
      });
    }
  }, [gone]);
  if (!target || gone) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60 }}>
      <ProjectSettingsDialog
        key={target.projectId}
        target={target}
        phone={phone}
        backStack={backStack}
      />
    </div>
  );
}
