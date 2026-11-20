import { useDashboardStore } from "../store/index.js";
import { CreateProjectModal } from "../CreateProjectModal.js";
import type { Host, Project } from "../api/index.js";

// The Edit-project dialog, opened with the project's current settings: the
// sidebar project header's Edit and the launcher's (#3048).
export function ProjectEditModal({
  project,
  hosts,
  onClose,
  surface,
}: {
  project: Project;
  hosts: Host[];
  onClose: () => void;
  // #3071 — "embedded" in the New session launcher (CreateProjectModal.tsx).
  surface?: "modal" | "embedded";
}) {
  return (
    <CreateProjectModal
      mode="edit"
      surface={surface}
      initialName={project.name}
      initialPath={project.cwd}
      initialDevServerUrl={project.devServerUrl}
      detectedDevServerPort={project.detectedDevServerPort}
      projectId={project.id}
      initialDefaultAgent={project.defaultAgent}
      initialDefaultReviewAgent={project.defaultReviewAgent}
      initialMergeOnApprove={project.mergeOnApprove}
      initialAutoApprove={project.autoApprove}
      initialAllowCrossProjectSpawn={project.allowCrossProjectSpawn}
      initialCrossProjectTargets={project.crossProjectTargets}
      initialAcceptsChildrenFrom={project.acceptsChildrenFrom}
      initialAcceptsChildrenFromList={project.acceptsChildrenFromList}
      initialAcceptsMessagesFrom={project.acceptsMessagesFrom}
      initialAcceptsMessagesFromList={project.acceptsMessagesFromList}
      initialMaxAutoReturnRounds={project.maxAutoReturnRounds}
      initialConventionalCommitTitles={project.conventionalCommitTitles}
      initialAutoTagRelease={project.autoTagRelease}
      // Issue #1726 / roadmap 8.12 — the project's own placement
      // mode, so the control opens showing what it is today.
      initialPlacement={project.placement}
      // Issue #1951 follow-up — the project's own host and where it
      // lives on the others, so the "Also lives on" rows open filled.
      hosts={hosts}
      projectHostId={project.hostId}
      initialHostCwds={project.hostCwds}
      initialHostCwdsMeta={project.hostCwdsMeta}
      initialPlacementConstraints={project.placementConstraints}
      initialPreProvision={project.preProvision}
      onClose={onClose}
      onCreate={({
        name,
        cwd,
        devServerUrl,
        defaultAgent,
        defaultReviewAgent,
        mergeOnApprove,
        autoApprove,
        allowCrossProjectSpawn,
        crossProjectTargets,
        acceptsChildrenFrom,
        acceptsChildrenFromList,
        acceptsMessagesFrom,
        acceptsMessagesFromList,
        maxAutoReturnRounds,
        conventionalCommitTitles,
        autoTagRelease,
        createDir,
        gitInit,
        placement,
        hostCwds,
        placementConstraints,
        preProvision,
        allowDuplicate,
      }) =>
        useDashboardStore.getState().updateProject(project.id, {
          name,
          cwd,
          devServerUrl,
          defaultAgent,
          defaultReviewAgent,
          mergeOnApprove,
          autoApprove,
          allowCrossProjectSpawn,
          crossProjectTargets,
          acceptsChildrenFrom,
          acceptsChildrenFromList,
          acceptsMessagesFrom,
          acceptsMessagesFromList,
          maxAutoReturnRounds,
          conventionalCommitTitles,
          autoTagRelease,
          createDir,
          gitInit,
          // Issue #1726 / roadmap 8.12 — the placement mode is a
          // plain patch field (updateProject's Pick union already
          // accepts it).
          placement,
          hostCwds,
          placementConstraints,
          preProvision,
          allowDuplicate,
        })
      }
    />
  );
}
