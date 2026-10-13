import { SourceControlSection } from "../SourceControlSection.js";
import type { RightSidebarViewProps } from "./views.js";

export function GitSidebarView({ projectId, actions }: RightSidebarViewProps) {
  return <SourceControlSection embedded projectId={projectId} onOpenGit={actions.onOpenGit} />;
}
