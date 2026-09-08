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
  transient = false,
  held = false,
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
  // PR2a — a transient stack-action monitor (startStackSession's own
  // ephemeral control, Dock.tsx's ephemeralIds) gets a fixed width via
  // .dock-monitor-transient instead of N-way splitting its stack group with
  // the rest — see that class's own comment (empty-states.css).
  transient?: boolean;
  // PR2b — this control briefly vanished from discovery (a compose recreate
  // deletes the old container before the new one appears) and is being held
  // across that gap rather than unmounted, so sibling monitors don't resize
  // — see holdVanishedDockerControls' own doc comment (dockHelpers.ts).
  // `dockerStatus` is stale while held (frozen at whatever it was before the
  // container vanished), so the container-state label below overrides it
  // with an honest "recreating…" instead. Hermes review on PR #1176 —
  // `control.docker` is that same frozen snapshot, so every per-service
  // action (kebab items, header start/kill) would resolve against a
  // container the backend's discovery no longer knows about and 404; the
  // header and kebab both go inert while held, not just cosmetically dim.
  held?: boolean;
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
      <div className={`dock-monitor${transient ? " dock-monitor-transient" : ""}`}>
        <div
          className="dock-monitor-header"
          style={{ cursor: held ? "default" : "pointer" }}
          title={
            held
              ? "Container is recreating — actions unavailable until it settles"
              : running
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
          // `aria-disabled` (not the native `disabled` attribute, which would
          // also drop this out of tab order) carries the inert STATE to
          // assistive tech — same convention as PaneActionsMenu.tsx's own
          // disabled menu items — on top of the aria-label wording below,
          // which only explains WHY.
          aria-disabled={held}
          aria-label={
            held
              ? `${control.title} — recreating, actions unavailable`
              : `${control.title} — ${running ? "click to end" : "click to start"}`
          }
          onKeyDown={(e) => {
            if (held) return;
            if (e.target !== e.currentTarget) return;
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            onHeaderActivate();
          }}
          // `held` freezes control.docker to a pre-vanish snapshot the
          // backend can no longer resolve against live discovery — a click
          // here would 404 into a failure toast for the ~1 poll interval
          // this control is held, so the header (and the kebab below) go
          // inert rather than offer an action guaranteed to fail.
          onClick={held ? undefined : onHeaderActivate}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              // `held` overrides dockerStatus's own color: control.docker is
              // a frozen snapshot from before the container vanished, so
              // dockerStatus (derived from it by the caller) is stale, not
              // current — the dim "recreating…" dot below is the honest
              // read, not whatever state the container happened to be in
              // right before it was removed.
              background: held
                ? "var(--dim)"
                : dockerStatus
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
            title={
              held
                ? "Container: recreating…"
                : dockerStatus
                  ? `Container: ${dockerStatus.label}`
                  : undefined
            }
          />
          {held ? (
            <span className="dock-monitor-container-state">recreating…</span>
          ) : (
            dockerStatus && (
              <span className="dock-monitor-container-state">{dockerStatus.label}</span>
            )
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
          {
            // Hidden entirely rather than rendered with every item disabled
            // (KebabMenu's own per-item `disabled` exists and would work
            // here too) — four dead menu entries behind a still-clickable
            // trigger is worse than no trigger at all for something this
            // short-lived (~1 poll interval).
          }
          {control.docker && !held && (
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
            <TerminalPane
              params={{ sessionId: running.id }}
              captureCtrlC={true}
              // PR3 — no attach-image or mic button over a log stream;
              // see TerminalPane's own doc comment on this prop.
              inputAffordances={false}
            />
          </div>
        )}
      </div>
    </Fragment>
  );
}
