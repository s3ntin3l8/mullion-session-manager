import { Fragment } from "react";
import type { DockControl, Session } from "../api/index.js";
import {
  ContainerIcon,
  GlobeIcon,
  RefreshIcon,
  KillIcon,
  PlayTriangleIcon,
  WarningTriangleIcon,
} from "../ui/icons.js";
import { CustomSelect } from "../ui/CustomSelect.js";
import type { CustomSelectOption } from "../ui/CustomSelect.js";
import { KebabMenu } from "../ui/KebabMenu.js";
import type { DockerStatusPresentation } from "../dockerServiceStatus.js";
import { isStartable } from "../dockerServiceStatus.js";
import { imagePillLabel } from "./dockHelpers.js";

// A single dock RAIL ROW — extracted from DockColumn's own render loop
// (Wave 5 / PR 28 of .claude/plans/can-we-do-a-warm-cocke.md), then reduced
// to header-only content by the dock master-detail rework
// (.claude/plans/another-dock-item-to-imperative-treasure.md): the terminal
// that used to render inside this component whenever `running` was truthy
// now lives once per column, in DockLogPane.tsx, showing whichever row is
// selected. Deliberately presentational: every value that depends on
// DockColumn's own state (armed-kill, check-status messages, the
// worktree/branch selector's resolved value, docker update availability,
// selection) is computed by the caller's map loop and passed in as a prop,
// and every action (select, toggle-stream, worktree switch, docker
// check-update/pull-restart) is a callback already bound to this control.
//
// Click semantics split in two, where a single header click used to do
// both and — per this repo's own U8/P10 findings — could kill a running
// dev server with one unconfirmed click:
//   - clicking the row body SELECTS it (and, per DockColumn's own onSelect
//     handler, starts its stream if it's off — "wanting to read a log is
//     why you clicked" is the stated assumption, not an accident);
//   - clicking the trailing "logs on"/"logs off" tag TOGGLES the stream,
//     independent of selection, and is where the arm-then-confirm kill
//     flow (`armed`/`confirmBeforeKill`, useArmedKill in DockColumn) lives.
export function DockMonitor({
  control,
  running,
  selected,
  showSelector,
  selectedValue,
  worktreeOptions,
  onWorktreeChange,
  devServerUrl,
  onOpenBrowser,
  updateAvailable,
  dockerStatus,
  held = false,
  checkStatus,
  armed,
  confirmBeforeKill,
  onSelect,
  onToggleStream,
  onCheckUpdate,
  onServiceRestart,
  onServiceStop,
  onServiceStart,
}: {
  control: DockControl;
  running: Session | undefined;
  // Whether this row's identity (dockRowKey, dockHelpers.ts) is
  // DockColumn's current selection — drives both the visual highlight and
  // `aria-selected`. Never derived locally: DockColumn owns selection so it
  // can reconcile it against the live control/session list on every render
  // (see its own selection-state comment).
  selected: boolean;
  showSelector: boolean;
  selectedValue: string;
  worktreeOptions: CustomSelectOption[];
  onWorktreeChange: (newValue: string) => void;
  devServerUrl: string | null | undefined;
  onOpenBrowser: () => void;
  updateAvailable: boolean;
  dockerStatus: DockerStatusPresentation | null;
  // PR2b — this control briefly vanished from discovery (a compose recreate
  // deletes the old container before the new one appears) and is being held
  // across that gap rather than unmounted, so sibling rows don't resize —
  // see holdVanishedDockerControls' own doc comment (dockHelpers.ts).
  // `dockerStatus` is stale while held (frozen at whatever it was before the
  // container vanished), so the container-state label below overrides it
  // with an honest "recreating…" instead. Hermes review on PR #1176 —
  // `control.docker` is that same frozen snapshot, so every per-service
  // action (kebab items, select, stream toggle) would resolve against a
  // container the backend's discovery no longer knows about and 404; the
  // row, tag, and kebab all go inert while held, not just cosmetically dim.
  held?: boolean;
  checkStatus: { message: string; isError: boolean } | undefined;
  armed: boolean;
  confirmBeforeKill: boolean;
  onSelect: () => void;
  onToggleStream: () => void;
  onCheckUpdate: () => void;
  onServiceRestart: () => void;
  onServiceStop: () => void;
  onServiceStart: () => void;
}) {
  // Issue #1240 — a control synthesized for a session whose own control
  // dropped out of discovery (Dock.tsx's `orphanControls`). Its `id` is set
  // to the session's own `docker-logs:<containerName>` name directly — the
  // SAME shape dockerSessionIdentity (dockHelpers.ts) now recognizes, and
  // mirrors that function's own check exactly (both the `source === "docker"`
  // guard and the id-prefix check), for two independent reasons:
  //
  // - Deliberately NOT `!control.docker` alone — Dock.tsx's
  //   `reconstructedEphemeralControls` (a live stack action surviving a
  //   workspace switch) ALSO constructs a `source: "docker"` control with
  //   no `.docker` field, for a completely unrelated reason. That
  //   reconstructed control's own id is always a
  //   `docker-stack:<composeProject>` session name (stackSessionName,
  //   routes/projects.ts) — a different, non-overlapping prefix — so the id
  //   check alone already never misclassifies it as orphaned.
  // - The `source === "docker"` guard is still required on TOP of the id
  //   check, though: docs/dock.md documents a `.crs/dock.json` control's own
  //   `id` as a supported override escape hatch, and dockerSessionIdentity's
  //   own "never collides" test (dockHelpers.test.ts) crafts exactly such a
  //   control with `id: "docker-logs:<containerName>"` but `source`
  //   undefined. Without this guard, that ordinary, working config control
  //   would render with the orphaned warning icon/border/aria-label for no
  //   reason — and if a real orphaned session of the same name existed
  //   too, both rows would even share a React `key`.
  const orphaned = control.source === "docker" && control.id.startsWith("docker-logs:");
  return (
    <Fragment>
      <div
        className={`dock-monitor${selected ? " dock-monitor--selected" : ""}${orphaned ? " dock-monitor--orphaned" : ""}`}
        // P10 — U8's own finding flagged the OLD single-click-does-
        // everything header as "one unconfirmed click kills a running dev
        // server"; splitting select from stream-toggle (see this file's
        // own header comment) is what retires that finding, not this
        // role/keyboard handling, which is unchanged in SHAPE from before:
        // same role/tabIndex/Enter-Space pattern as Sidebar.tsx's
        // SessionRow/ProjectHeader, including the
        // `e.target !== e.currentTarget` guard — this row nests a
        // CustomSelect (worktree picker), a "open preview" button, a
        // KebabMenu, and the stream-toggle tag, and without the guard
        // tabbing to any of those and pressing Enter/Space would ALSO
        // select this row (harmless on its own, but still not what the
        // guard is for elsewhere in this file).
        //
        // Stayed `role="button"` rather than `role="option"` — this row
        // sits inside `.dock-stack-group`/`.dock-stack-monitors` for a
        // Docker-grouped control, several levels below `.dock-rail`, and a
        // valid ARIA listbox needs `option` as a DIRECT child of `listbox`
        // (or of a `role="group"` wrapper this markup doesn't have); an
        // `option` this deeply nested would be an invalid tree, and worse
        // for assistive tech than the working `role="button"` pattern this
        // whole guard already matches (Sidebar.tsx's SessionRow/
        // ProjectHeader). `role="option"`/a real `listbox` ancestor with
        // roving-tabindex/arrow-key navigation is filed as a fast-follow
        // rather than shipped half-correct here. Selection is instead
        // conveyed as plain text in `aria-label` below.
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
            : orphaned
              ? `${control.title} — orphaned, no matching service${selected ? " — selected" : ""}`
              : `${control.title}${selected ? " — selected" : ""}`
        }
        onKeyDown={(e) => {
          if (held) return;
          if (e.target !== e.currentTarget) return;
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          onSelect();
        }}
        // `held` freezes control.docker to a pre-vanish snapshot the
        // backend can no longer resolve against live discovery — a click
        // here would 404 into a failure toast for the ~1 poll interval
        // this control is held, so the row (and the kebab/tag below) go
        // inert rather than offer an action guaranteed to fail.
        //
        // Deliberately NO `e.target !== e.currentTarget` guard here, unlike
        // the onKeyDown handler above — a plain click bubbles from whatever
        // child was actually clicked (the name span, the status dot, ...),
        // and that target is essentially never `e.currentTarget` itself,
        // so that guard would silently break "click anywhere on the row
        // selects it" for all of this row's ordinary, non-interactive
        // content. keydown's guard exists for a different reason (a
        // FOCUSED nested control's own Enter/Space bubbling up), which
        // doesn't apply to a mouse click at all. The real fix for a
        // genuinely interactive child (Hermes review — the worktree
        // CustomSelect below was the one such child left unguarded) is the
        // same `stopPropagation()` wrapper devServerUrl/kebab/the
        // stream-toggle tag already use, not this guard.
        onClick={held ? undefined : onSelect}
      >
        <div
          className="dock-monitor-header"
          style={{ cursor: held ? "default" : "pointer" }}
          title={
            held ? "Container is recreating — actions unavailable until it settles" : undefined
          }
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
          {orphaned && (
            // Issue #1240 — this row's own control is gone from discovery;
            // its session (and this row) survive only because the stream
            // itself is still live. No dot/kebab/image pill to tint (there's
            // no `control.docker` at all — see this component's own
            // `orphaned` comment above), so the marker is a standalone icon
            // rather than a recolor of something that doesn't exist here.
            <span
              className="dock-monitor-orphaned-icon"
              title="Orphaned — no matching service in current discovery"
            >
              <WarningTriangleIcon size={11} />
            </span>
          )}
          <span className="dock-monitor-name">{control.title}</span>
          {showSelector && (
            // Hermes review — the one interactive child of this row that
            // didn't already stopPropagation its own clicks (unlike
            // devServerUrl/the kebab/the stream-toggle tag below), so a
            // click on the worktree picker's own trigger used to bubble
            // into onSelect too. `display: contents` keeps this wrapper
            // out of the flex layout entirely — CustomSelect's own root
            // div still has to be the DIRECT flex child of
            // `.dock-monitor-header` for `.dock-monitor-worktree-select`'s
            // own max-width/min-width/flex-shrink (empty-states.css) to
            // size correctly, and a wrapper with any real box would nest it
            // one level too deep — while still sitting in the DOM tree
            // click events bubble through, which is all this needs.
            <span style={{ display: "contents" }} onClick={(e) => e.stopPropagation()}>
              <CustomSelect
                className="dock-monitor-worktree-select"
                value={selectedValue}
                options={worktreeOptions}
                label={`${control.title} worktree`}
                menuPlacement="top"
                menuAlign="right"
                onChange={onWorktreeChange}
              />
            </span>
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
              <span className="dock-monitor-url-text">{imagePillLabel(control.docker)}</span>
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
                    // Issue #1106 — the disabled state alone gave no reason;
                    // wording matches docs/dock.md's own explanation.
                    title: control.docker.buildOnly
                      ? "No registry image to compare — this service is built from source"
                      : undefined,
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
          {(() => {
            // Text is the same regardless of `held` — a held control's log
            // SESSION is untouched (that's the entire point of the hold;
            // see `held`'s own doc comment above), so `running` reads
            // exactly as it did before the container vanished, and the tag
            // must keep saying so. Only the INTERACTIVITY drops while
            // held, same as the kebab above: a click here would 404
            // against a container the backend's discovery no longer knows
            // about.
            const label = armed
              ? "confirm?"
              : control.docker
                ? running
                  ? "logs on"
                  : "logs off"
                : running
                  ? "on"
                  : "off";
            if (held) {
              return <span className="dock-monitor-tag">{label}</span>;
            }
            return (
              <span
                className={`dock-monitor-tag dock-monitor-stream-toggle${armed ? " armed" : ""}`}
                role="button"
                tabIndex={0}
                // Mirrors the old header's own title logic (armed → confirm
                // wording; running + confirmBeforeKill → explain the arm
                // step; otherwise no tooltip — starting a stream needs no
                // explanation, and an immediate stop with confirmBeforeKill
                // off doesn't either) verbatim, just re-scoped to this tag.
                title={
                  armed
                    ? "Click again to confirm — ends the running program"
                    : running && confirmBeforeKill
                      ? "Click to stop this stream"
                      : undefined
                }
                aria-label={`${control.title} — ${running ? "click to stop" : "click to start"} log streaming`}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleStream();
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  e.stopPropagation();
                  onToggleStream();
                }}
              >
                {label}
              </span>
            );
          })()}
        </div>
      </div>
    </Fragment>
  );
}
