import { useState } from "react";
import { GitBranchesSection } from "../git/GitBranchesSection.js";
import { GitHistorySection } from "../git/GitHistorySection.js";
import { GitWorktreesSection } from "../git/GitWorktreesSection.js";
import { SourceControlSection } from "../SourceControlSection.js";
import type { RightSidebarViewProps } from "./views.js";

const STORAGE_KEY = "crs.gitSidebarSections";
type SectionId = "changes" | "branches" | "worktrees" | "history";
const DEFAULT_OPEN: Record<SectionId, boolean> = {
  changes: true,
  branches: false,
  worktrees: false,
  history: true,
};

function readOpen(): Record<SectionId, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw
      ? { ...DEFAULT_OPEN, ...(JSON.parse(raw) as Partial<Record<SectionId, boolean>>) }
      : DEFAULT_OPEN;
  } catch {
    return DEFAULT_OPEN;
  }
}

function Section({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="github-panel-section">
      <button
        type="button"
        className="github-panel-section-title gh-section-toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        {open ? "▾" : "▸"} {title}
      </button>
      {open && children}
    </div>
  );
}

export function GitSidebarView({ projectId, actions }: RightSidebarViewProps) {
  const [open, setOpen] = useState(readOpen);
  // Worktree the History section is scoped to; undefined = the project root.
  // Tied to the project it was chosen for: this component does not remount on
  // a project switch, and another project's worktree path is invalid here.
  const [historySelection, setHistorySelection] = useState<{
    projectId: number;
    cwd: string | undefined;
  }>({ projectId, cwd: undefined });
  const historyCwd = historySelection.projectId === projectId ? historySelection.cwd : undefined;
  const setHistoryCwd = (cwd: string | undefined) => setHistorySelection({ projectId, cwd });

  const toggle = (id: SectionId) =>
    setOpen((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable — the toggle still works for this session.
      }
      return next;
    });

  return (
    <div className="git-sidebar-view">
      <Section title="Changes" open={open.changes} onToggle={() => toggle("changes")}>
        <SourceControlSection embedded projectId={projectId} onOpenGit={actions.onOpenGit} />
      </Section>
      <Section title="Branches" open={open.branches} onToggle={() => toggle("branches")}>
        <GitBranchesSection projectId={projectId} />
      </Section>
      <Section title="Worktrees" open={open.worktrees} onToggle={() => toggle("worktrees")}>
        <GitWorktreesSection projectId={projectId} selected={historyCwd} onSelect={setHistoryCwd} />
      </Section>
      <Section title="History" open={open.history} onToggle={() => toggle("history")}>
        <GitHistorySection projectId={projectId} cwd={historyCwd} />
      </Section>
    </div>
  );
}
