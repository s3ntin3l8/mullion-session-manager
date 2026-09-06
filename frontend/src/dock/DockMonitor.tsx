import { Fragment } from "react";
import type { DockControl, Session } from "../api/index.js";
import { ContainerIcon, GlobeIcon, RefreshIcon, KillIcon, PlayTriangleIcon } from "../ui/icons.js";
import { TerminalPane } from "../TerminalPane.js";
import { CustomSelect } from "../ui/CustomSelect.js";
import type { CustomSelectOption } from "../ui/CustomSelect.js";
import { KebabMenu } from "../ui/KebabMenu.js";
import type { DockerStatusPresentation } from "../dockerServiceStatus.js";
import { isStartable } from "../dockerServiceStatus.js";
import { imageTag } from "./dockHelpers.js";

// A single dock monitor row (header + its live terminal body) — extracted
// from DockColumn's own render loop (Wave 5 / PR 28 of
// .claude/plans/can-we-do-a-warm-cocke.md). Deliberately presentational:
// every value that depends on DockColumn's own state (armed-kill,
// check-status messages, the worktree/branch selector's resolved value,
// docker update availability) is computed by the caller's map loop and
// passed in as a prop, and every action (start/kill, worktree switch,
// docker check-update/pull-restart) is a callback already bound to this
// control — see DockColumn's own comment on why the worktree-switch and
// header-activate handlers stay up there rather than moving down here.
export function DockMonitor({
  control,
  running,
  showSelector,
  selectedValue,
  worktreeOptions,
  onWorktreeChange,
  devServerUrl,
  onOpenBrowser,
  updateAvailable,
  dockerStatus,
  checkStatus,
  armed,
  confirmBeforeKill,
  onHeaderActivate,
  onCheckUpdate,
  onServiceRestart,
  onServiceStop,
  onServiceStart,
}: {
  control: DockControl;
  running: Session | undefined;
  showSelector: boolean;
  selectedValue: string;
  worktreeOptions: CustomSelectOption[];
  onWorktreeChange: (newValue: string) => void;
  devServerUrl: string | null | undefined;
  onOpenBrowser: () => void;
  updateAvailable: boolean;
  dockerStatus: DockerStatusPresentation | null;
  checkStatus: { message: string; isError: boolean } | undefined;
  armed: boolean;
  confirmBeforeKill: boolean;
  onHeaderActivate: () => void;
  onCheckUpdate: () => void;
  onServiceRestart: () => void;
  onServiceStop: () => void;
  onServiceStart: () => void;
}) {
  return (
    <Fragment>
      <div className="dock-monitor">
        <div
          className="dock-monitor-header"
          style={{ cursor: "pointer" }}
          title={
            running
              ? armed
                ? "Click again to confirm — ends the running program"
                : confirmBeforeKill
                  ? "Click to end this monitor"
                  : undefined
              : undefined
          }
          // P10 — U8's own finding flags this same header as "one
          // unconfirmed click kills a running dev server," and on
          // top of that it was entirely unreachable from the
          // keyboard. Same role="button"/tabIndex/Enter-Space
          // pattern as Sidebar.tsx's SessionRow/ProjectHeader,
          // including the `e.target !== e.currentTarget` guard —
          // this header nests a CustomSelect (worktree picker), a
          // "open preview" button, and (for a Docker-backed
          // control) a KebabMenu, and without the guard tabbing to
          // any of those and pressing Enter/Space would ALSO
          // toggle/kill this monitor.
          role="button"
          tabIndex={0}
          aria-label={`${control.title} — ${running ? "click to end" : "click to start"}`}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            onHeaderActivate();
          }}
          onClick={onHeaderActivate}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: dockerStatus
                ? `var(${dockerStatus.colorToken})`
                : running
                  ? "var(--g)"
                  : "var(--dim)",
              flexShrink: 0,
            }}
            // The dock-monitor-tag "logs on"/"logs off" text at the end of
            // this header labels the log-STREAM session; this dot instead
            // reflects the CONTAINER's own state, which needs its own
            // accessible label (sessionStatus.ts's "never color alone"
            // rule) — same convention as dock/DockGithubRow.tsx's own CI
            // dot (title="CI: ..."). The title remains as a hover
            // affordance on top of the always-visible text label below (PR3
            // — a hover-only label was easy to miss entirely).
            title={dockerStatus ? `Container: ${dockerStatus.label}` : undefined}
          />
          {dockerStatus && (
            <span className="dock-monitor-container-state">{dockerStatus.label}</span>
          )}
          <span className="dock-monitor-name">{control.title}</span>
          {showSelector && (
            <CustomSelect
              className="dock-monitor-worktree-select"
              value={selectedValue}
              options={worktreeOptions}
              label={`${control.title} worktree`}
              menuPlacement="top"
              menuAlign="right"
              onChange={onWorktreeChange}
            />
          )}
          {devServerUrl && (
            <button
              className="dock-monitor-url"
              onClick={(e) => {
                e.stopPropagation();
                onOpenBrowser();
              }}
              title={`Open preview for ${devServerUrl}`}
              type="button"
            >
              <GlobeIcon size={11} />
              <span className="dock-monitor-url-text">{devServerUrl}</span>
            </button>
          )}
          {control.docker && (
            <span
              className={`dock-monitor-url dock-monitor-image${updateAvailable ? " dock-monitor-image-update" : ""}`}
              title={
                updateAvailable
                  ? `${control.docker.imageRef} — update available`
                  : control.docker.imageRef
              }
            >
              <ContainerIcon size={11} />
              <span className="dock-monitor-url-text">{imageTag(control.docker.imageRef)}</span>
            </span>
          )}
          {control.docker && (
            <span className="dock-monitor-kebab" onClick={(e) => e.stopPropagation()}>
              <KebabMenu
                title={`${control.title} actions`}
                menuPlacement="top"
                items={[
                  {
                    key: "service-restart",
                    label: "Restart service",
                    icon: <RefreshIcon size={12} />,
                    onClick: onServiceRestart,
                  },
                  {
                    key: "service-stop",
                    label: "Stop service",
                    armLabel: "Click again — stops this service",
                    icon: <KillIcon size={12} />,
                    danger: true,
                    confirm: true,
                    onClick: onServiceStop,
                  },
                  // "only offered when startable" (issue #73 follow-up plan,
                  // narrowed per Hermes review on PR #857) — `paused`/
                  // `restarting` fail `docker compose start` outright, so
                  // this checks the states start actually applies to rather
                  // than just excluding `running`.
                  ...(isStartable(control.docker.state)
                    ? [
                        {
                          key: "service-start",
                          label: "Start service",
                          icon: <PlayTriangleIcon size={12} />,
                          onClick: onServiceStart,
                        },
                      ]
                    : []),
                  // The stack-wide actions (restart/apply/pull-or-rebuild/
                  // stop) used to repeat here, identically, on every
                  // service row of the same stack — hoisted to a single
                  // per-compose-project DockStackHeader kebab instead (see
                  // Dock.tsx's DockColumn). check-update stays per-service:
                  // buildOnly is per-service, the route short-circuits per
                  // service, and updateAvailable drives THIS row's own
                  // image-pill tint — hoisting it would either lose that
                  // tint or lie about which service was actually checked.
                  {
                    key: "check-update",
                    label: "Check for update",
                    icon: <RefreshIcon size={12} />,
                    disabled: control.docker.buildOnly,
                    onClick: onCheckUpdate,
                  },
                ]}
              />
            </span>
          )}
          {checkStatus && (
            <span
              className={`dock-monitor-tag dock-monitor-check-status${checkStatus.isError ? " error" : ""}`}
            >
              {checkStatus.message}
            </span>
          )}
          <span className={`dock-monitor-tag${armed ? " armed" : ""}`}>
            {armed
              ? "confirm?"
              : control.docker
                ? running
                  ? "logs on"
                  : "logs off"
                : running
                  ? "on"
                  : "off"}
          </span>
        </div>
        {running && (
          <div className="dock-monitor-body">
            <TerminalPane params={{ sessionId: running.id }} captureCtrlC={true} />
          </div>
        )}
      </div>
    </Fragment>
  );
}
