import { useEffect, useState } from "react";
import type { ComponentType, SVGProps } from "react";
import { SkillsPanel } from "../SkillsPanel.js";
import { useDashboardStore } from "../store/index.js";
import { DockIcon, FileTextIcon, SkillIcon } from "../ui/icons.js";
import { DetailHeader } from "../ui/sidebar/index.js";
import { SidebarHeader } from "./SidebarHeader.js";
import { VIEW_TITLES } from "./viewTitles.js";
import type { RightSidebarViewProps } from "./views.js";

interface ProjectSidebarRow {
  key: "onOpenAgentRules" | "onOpenProjectBriefing" | "onOpenProjectSetup" | "onOpenDockConfig";
  title: string;
  subtitle: string;
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;
}

// Same entries (and copy) as the command palette's "Project ›" drill-in,
// minus "Edit project files" — that is the Files view's job. The four editors
// open the Project settings dialog on their section (#3406).
const EDITOR_ROWS: ProjectSidebarRow[] = [
  {
    key: "onOpenAgentRules",
    title: "Agent Rules",
    subtitle: "CLAUDE.md, AGENTS.md, GEMINI.md",
    icon: FileTextIcon,
  },
  {
    key: "onOpenProjectBriefing",
    title: "Mullion Briefing",
    subtitle: "DB-authored — pushed on top of whatever AGENTS.md already says",
    icon: FileTextIcon,
  },
  {
    key: "onOpenProjectSetup",
    title: "Scaffold Mullion",
    subtitle: "Commit a briefing region, skill, and reviewer subagent as a PR",
    icon: FileTextIcon,
  },
  {
    key: "onOpenDockConfig",
    title: "Dock",
    subtitle: "Edit this project's dock monitors",
    icon: DockIcon,
  },
];

function Row({
  title,
  subtitle,
  icon: Icon,
  onClick,
}: Omit<ProjectSidebarRow, "key"> & { onClick: () => void }) {
  return (
    <button type="button" className="project-sidebar-row" onClick={onClick}>
      <Icon size={15} />
      <span className="project-sidebar-row-text">
        <span className="project-sidebar-row-title">{title}</span>
        <span className="project-sidebar-row-sub">{subtitle}</span>
      </span>
    </button>
  );
}

export function ProjectSidebarView({ projectId, actions }: RightSidebarViewProps) {
  // The Skills drill-in is tied to the project it was opened for: this view
  // does not remount on a project switch (same shape as Source Control's pages).
  const [skillsFor, setSkillsFor] = useState<number | null>(null);
  const showSkills = skillsFor === projectId;

  // A one-shot "show Skills" request (the palette's Project › Skills): applied
  // in render keyed on its nonce, then cleared — GitSidebarView's prune shape.
  const request = useDashboardStore((s) => s.projectSkillsRequest);
  const [handledNonce, setHandledNonce] = useState(0);
  const applies = request !== null && request.projectId === projectId;
  if (applies && request.nonce !== handledNonce) {
    setHandledNonce(request.nonce);
    setSkillsFor(projectId);
  }
  // Only the view that applied the request consumes it.
  useEffect(() => {
    if (applies) useDashboardStore.getState().clearProjectSkillsRequest();
  }, [applies, request]);

  if (showSkills) {
    return (
      <div className="project-sidebar-view project-skills-drill">
        <DetailHeader title="Skills" onBack={() => setSkillsFor(null)} />
        <SkillsPanel params={{ projectId }} />
      </div>
    );
  }

  return (
    <div className="project-sidebar-view">
      <SidebarHeader label={VIEW_TITLES.project} />
      {EDITOR_ROWS.map(({ key, ...row }) => (
        <Row key={key} {...row} onClick={() => actions[key](projectId)} />
      ))}
      {/* A list, not an editor: it drills in here rather than opening the
          dialog, and so it never goes through `actions` (on the phone those
          close the view first). */}
      <Row
        title="Skills"
        subtitle="Discovered skills across every agent"
        icon={SkillIcon}
        onClick={() => setSkillsFor(projectId)}
      />
    </div>
  );
}
