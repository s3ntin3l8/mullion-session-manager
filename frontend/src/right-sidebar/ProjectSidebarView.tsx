import type { ComponentType, SVGProps } from "react";
import { DockIcon, FileTextIcon, SkillIcon } from "../ui/icons.js";
import type { RightSidebarActions, RightSidebarViewProps } from "./views.js";

interface ProjectRow {
  key: Exclude<keyof RightSidebarActions, "onOpenFile">;
  title: string;
  subtitle: string;
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;
}

// Same entries (and copy) as the command palette's "Project:" drill-in, minus
// "Edit project files" — that is the Files view's job.
const ROWS: ProjectRow[] = [
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
  {
    key: "onOpenSkills",
    title: "Skills",
    subtitle: "Discovered skills across every agent",
    icon: SkillIcon,
  },
];

export function ProjectSidebarView({ projectId, actions }: RightSidebarViewProps) {
  return (
    <div className="project-sidebar-view">
      {ROWS.map(({ key, title, subtitle, icon: Icon }) => (
        <button
          key={key}
          type="button"
          className="project-sidebar-row"
          onClick={() => actions[key](projectId)}
        >
          <Icon size={15} />
          <span className="project-sidebar-row-text">
            <span className="project-sidebar-row-title">{title}</span>
            <span className="project-sidebar-row-sub">{subtitle}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
