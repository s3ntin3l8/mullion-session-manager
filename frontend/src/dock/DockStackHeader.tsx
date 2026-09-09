import { ContainerIcon, RefreshIcon, KillIcon } from "../ui/icons.js";
import { KebabMenu } from "../ui/KebabMenu.js";

// The stack-wide half of a compose project's actions, hoisted out of every
// individual DockMonitor row into one header per compose project (issue #73
// follow-up — see Dock.tsx's DockColumn, groupDockerControls in
// dockHelpers.ts). Deliberately presentational, same contract as
// DockMonitor.tsx's own doc comment: every value/callback is computed by
// the caller and passed in.
export function DockStackHeader({
  composeProject,
  // Whether the group has ANY docker-bearing control to act against
  // (dockHelpers.ts's DockerStackGroup.anyRep !== null) — false only for a
  // group made up entirely of live ephemeral action monitors (the service
  // that spawned them has since dropped out of discovery). No kebab
  // renders in that case: there is no compose context left to run a stack
  // action against.
  hasActions,
  canPull,
  canRebuild,
  status,
  actionRunning,
  onStackRestart,
  onStackApply,
  onPullAndRestart,
  onRebuildAndRestart,
  onStackStop,
}: {
  composeProject: string;
  hasActions: boolean;
  // Whether pullRep / rebuildRep is non-null — see dockHelpers.ts's
  // DockerStackGroup.rebuildRep doc comment for the full "a mixed stack
  // gets both" rationale.
  canPull: boolean;
  canRebuild: boolean;
  status: { message: string; isError: boolean } | undefined;
  // Hermes review (dock log-streaming resize fix) — whether this group has
  // a live stack-action strip below it right now (Dock.tsx's
  // ephemeralControlsInGroup.length > 0), independent of `status` above.
  // `status` is a TRANSIENT ~4s message (useTransientStatus) that only ever
  // fires from THIS render's own click handlers, so it says nothing after a
  // workspace switch remounts the column and reconstructs a still-running
  // action from its session (the dock log-streaming resize fix's own
  // symptom-3 repair) — and `.dock-body`'s new overflow-y:auto means the
  // strip itself can start scrolled out of view on a short dock, right when
  // a user returns specifically to check whether it's still running. This
  // indicator lives in the always-visible header instead, so "is it still
  // running" never depends on scroll position or on having been the one who
  // clicked the button.
  actionRunning: boolean;
  onStackRestart: () => void;
  onStackApply: () => void;
  onPullAndRestart: () => void;
  onRebuildAndRestart: () => void;
  onStackStop: () => void;
}) {
  return (
    <div className="dock-stack-header">
      <ContainerIcon size={10} />
      <span
        className="dock-group-label dock-stack-header-label"
        title={`Compose project ${composeProject}`}
      >
        {composeProject}
      </span>
      {actionRunning && (
        <span
          className="dock-monitor-tag dock-stack-action-running"
          title="A stack action is running — see the log strip below"
        >
          running…
        </span>
      )}
      {status && (
        <span
          className={`dock-monitor-tag dock-monitor-check-status${status.isError ? " error" : ""}`}
        >
          {status.message}
        </span>
      )}
      {hasActions && (
        <span className="dock-monitor-kebab" onClick={(e) => e.stopPropagation()}>
          <KebabMenu
            title={`${composeProject} stack actions`}
            menuPlacement="top"
            items={[
              {
                key: "stack-restart",
                label: "Restart stack",
                icon: <RefreshIcon size={12} />,
                onClick: onStackRestart,
              },
              {
                key: "stack-apply",
                label: "Apply config",
                icon: <ContainerIcon size={12} />,
                onClick: onStackApply,
              },
              // Both items independently gated — this component's own
              // `canPull`/`canRebuild` param doc points at the full
              // rationale (dockHelpers.ts's DockerStackGroup.rebuildRep).
              ...(canPull
                ? [
                    {
                      key: "stack-pull-restart",
                      label: "Pull & restart stack",
                      armLabel: "Click again — restarts the whole stack",
                      icon: <ContainerIcon size={12} />,
                      danger: true,
                      confirm: true,
                      onClick: onPullAndRestart,
                    },
                  ]
                : []),
              ...(canRebuild
                ? [
                    {
                      key: "stack-rebuild",
                      label: "Rebuild & restart stack",
                      armLabel: "Click again — rebuilds and restarts the whole stack",
                      icon: <ContainerIcon size={12} />,
                      danger: true,
                      confirm: true,
                      onClick: onRebuildAndRestart,
                    },
                  ]
                : []),
              {
                key: "stack-stop",
                label: "Stop stack",
                armLabel: "Click again — stops the whole stack",
                icon: <KillIcon size={12} />,
                danger: true,
                confirm: true,
                onClick: onStackStop,
              },
            ]}
          />
        </span>
      )}
    </div>
  );
}
