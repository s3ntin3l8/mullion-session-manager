import { Fragment } from "react";
import type { DockControl, Session } from "../api.js";
import { ContainerIcon, GlobeIcon, RefreshIcon } from "../icons.js";
import { TerminalPane } from "../TerminalPane.js";
import { CustomSelect } from "../CustomSelect.js";
import type { CustomSelectOption } from "../CustomSelect.js";
import { KebabMenu } from "../KebabMenu.js";
import type { DockerStatusPresentation } from "../dockerServiceStatus.js";
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
  isFirstDockerControl,
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
  onPullAndRestart,
}: {
  control: DockControl;
  running: Session | undefined;
  isFirstDockerControl: boolean;
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
  onPullAndRestart: () => void;
}) {
  return (
    <Fragment>
      {isFirstDockerControl && <div className="dock-group-label">Docker</div>}
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
            // Same "title carries the label a bare dot can't" — the
            // dock-monitor-tag "on"/"off" text just below already
            // labels the log-STREAM session; this dot instead
            // reflects the CONTAINER's own state, which needs its
            // own accessible label (sessionStatus.ts's "never color
            // alone" rule) — same convention as dock/DockGithubRow.tsx's
            // own CI dot (title="CI: ...").
            title={dockerStatus ? `Container: ${dockerStatus.label}` : undefined}
          />
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
            <span onClick={(e) => e.stopPropagation()}>
              <KebabMenu
                title={`${control.title} actions`}
                items={[
                  {
                    key: "check-update",
                    label: "Check for update",
                    icon: <RefreshIcon size={12} />,
                    disabled: control.docker.buildOnly,
                    onClick: onCheckUpdate,
                  },
                  {
                    key: "pull-restart",
                    label: "Pull & restart stack",
                    armLabel: "Click again — restarts the whole stack",
                    icon: <ContainerIcon size={12} />,
                    danger: true,
                    confirm: true,
                    disabled: control.docker.buildOnly,
                    onClick: onPullAndRestart,
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
            {armed ? "confirm?" : running ? "on" : "off"}
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
