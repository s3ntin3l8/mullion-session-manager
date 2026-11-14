import { useEffect, useRef, useState } from "react";
import type { DockControl } from "../api/index.js";
import { TerminalPane } from "../TerminalPane.js";
import { useDashboardStore } from "../store/index.js";
import { isStartable } from "../dockerServiceStatus.js";
import { dockRowKey, imagePillLabel } from "../dock/dockHelpers.js";
import { useDockProject } from "../dock/useDockProject.js";
import type { DockControlView, DockStackActions } from "../dock/useDockProject.js";
import { KILL_ARM_DISARM_MS, useArmedKill } from "../dock/useArmedKill.js";
import { BottomSheet } from "../ui/BottomSheet.js";
import { CustomSelect } from "../ui/CustomSelect.js";
import { EmptyStateNote } from "../ui/EmptyState.js";
import { ContainerIcon, WarningTriangleIcon } from "../ui/icons.js";
import { SidebarHeader } from "./SidebarHeader.js";
import { VIEW_TITLES } from "./viewTitles.js";
import type { RightSidebarViewProps } from "./views.js";

// The right sidebar's Dock view (#3012), registered only below 1100px (the
// rails layouts and, full screen from the "more" sheet, the phone; see
// viewBands.ts): the followed project's Dock, laid out for touch. One section for the dock.json commands and one per Compose stack,
// named after its compose project, so a dev and a prod stack never mix.
// Tapping a row selects it; under the list, its actions are visible buttons
// (what the bottom Dock keeps in hover menus and small kebabs) and its log.
// A stack's own actions open from the "⋯" on its heading as a sheet.
//
// Data and actions are the bottom Dock's own (dock/useDockProject.ts), not a
// fork. The view leaves out the bottom Dock's GitHub row and browser
// shortcut: GitHub and Browser are rail views of their own.
//
// The log is READ ONLY (TerminalPane `readOnly`). The bottom Dock is not
// mounted under a coarse pointer because the key bar routes input by session
// id and cannot tell a session's own pane from a Dock monitor of the same
// session (terminalInputRegistry.ts); a read-only log never registers as an
// input target, so the view is safe on the fold. Typing into a monitor means
// opening it as a session.
//
// Selecting a row never starts a command (a tap should not start a dev
// server); Start does. Selecting a Compose service starts its log stream if it
// is off, as the bottom Dock does: reading the log is why you tapped it, and
// `docker compose logs` changes nothing. The view does not run the Dock's
// "Auto-attach Docker logs" effect; the bottom Dock does.

type RowKind = "command" | "service" | "log";

function rowKind(control: DockControl): RowKind {
  if (control.docker) return "service";
  // A stack action's own run, or a log stream whose service is gone: there is
  // nothing to act on but the stream itself.
  if (control.source === "docker") return "log";
  return "command";
}

function rowDetail(view: DockControlView): string {
  if (view.held) return "recreating…";
  if (view.dockerStatus) return view.dockerStatus.label;
  if (rowKind(view.control) === "log") return view.running ? "running" : "ended";
  return view.running ? "running" : "stopped";
}

function dotColor(view: DockControlView): string {
  if (view.held) return "var(--dim)";
  if (view.dockerStatus) return `var(${view.dockerStatus.colorToken})`;
  return view.running ? "var(--g)" : "var(--dim)";
}

function DockRow({
  view,
  selected,
  onSelect,
}: {
  view: DockControlView;
  selected: boolean;
  onSelect: () => void;
}) {
  const { control } = view;
  const orphaned = control.source === "docker" && control.id.startsWith("docker-logs:");
  return (
    <button
      type="button"
      className={`dock-view-row${selected ? " selected" : ""}`}
      aria-pressed={selected}
      aria-label={`${control.title}, ${rowDetail(view)}${view.updateAvailable ? ", update available" : ""}`}
      onClick={onSelect}
    >
      <span className="dock-view-dot" style={{ background: dotColor(view) }} aria-hidden="true" />
      <span className="dock-view-row-text">
        <span className="dock-view-row-title">
          {orphaned && <WarningTriangleIcon size={11} />}
          {control.title}
        </span>
        <small>{rowDetail(view)}</small>
      </span>
      {control.docker && (
        <span
          className={`dock-view-image${view.updateAvailable ? " update" : ""}`}
          title={
            view.updateAvailable
              ? `${control.docker.imageRef} — update available`
              : control.docker.imageRef
          }
        >
          <ContainerIcon size={11} />
          {imagePillLabel(control.docker)}
          {view.updateAvailable && " · update"}
        </span>
      )}
    </button>
  );
}

// The selected row's actions, as buttons. A command: restart, stop or start,
// branch. A service: restart, stop or start, check for update. A log-only row
// (a stack action's run, an orphaned stream): stop the stream.
function DockActions({ view }: { view: DockControlView }) {
  const { control } = view;
  const kind = rowKind(control);
  const { armedIds, arm, disarm } = useArmedKill(KILL_ARM_DISARM_MS);
  const disabled = view.held;

  const stopLabel = view.armed ? "Tap again to stop" : "Stop";
  let buttons;
  if (kind === "service") {
    const startable = control.docker ? isStartable(control.docker.state) : false;
    const stopArmed = armedIds.has(control.id);
    buttons = (
      <>
        <button type="button" disabled={disabled} onClick={view.serviceRestart}>
          Restart
        </button>
        {startable ? (
          <button type="button" disabled={disabled} onClick={view.serviceStart}>
            Start
          </button>
        ) : (
          <button
            type="button"
            className={stopArmed ? "armed" : undefined}
            disabled={disabled}
            onClick={() => {
              if (!stopArmed) {
                arm(control.id);
                return;
              }
              disarm(control.id);
              view.serviceStop();
            }}
          >
            {stopArmed ? "Tap again to stop" : "Stop"}
          </button>
        )}
        <button
          type="button"
          disabled={disabled || !control.docker?.pullable}
          title={
            control.docker?.pullable
              ? undefined
              : "No registry image to compare — this service is built from source"
          }
          onClick={view.checkUpdate}
        >
          Check for update
        </button>
      </>
    );
  } else if (kind === "log") {
    buttons = view.running ? (
      <button
        type="button"
        className={view.armed ? "armed" : undefined}
        disabled={disabled}
        onClick={view.stop}
      >
        {stopLabel}
      </button>
    ) : null;
  } else {
    buttons = (
      <>
        <button type="button" disabled={disabled || !view.running} onClick={view.restart}>
          Restart
        </button>
        {view.running ? (
          <button
            type="button"
            className={view.armed ? "armed" : undefined}
            disabled={disabled}
            onClick={view.stop}
          >
            {stopLabel}
          </button>
        ) : (
          <button type="button" disabled={disabled} onClick={() => void view.start()}>
            Start
          </button>
        )}
        {view.showSelector && (
          <CustomSelect
            className="dock-view-branch"
            value={view.selectedValue}
            options={view.worktreeOptions}
            label={`${control.title} branch`}
            menuPlacement="top"
            searchable
            emptyMessage="No matching branches"
            onChange={view.changeWorktree}
          />
        )}
      </>
    );
  }

  return (
    <div className="dock-view-actions" aria-label={`${control.title} actions`} role="group">
      {buttons}
      {view.portConflict && (
        <div className="dock-view-status error" role="alert">
          {view.portConflict.message}
          {view.portConflict.holderSessionId !== undefined && view.openHolder && (
            <button type="button" onClick={view.openHolder}>
              Open holder
            </button>
          )}
          {view.portConflict.holderSessionId !== undefined && (
            <button type="button" onClick={view.stopHolderAndStart}>
              Stop holder and start
            </button>
          )}
        </div>
      )}
      {view.checkStatus && (
        <div className={`dock-view-status${view.checkStatus.isError ? " error" : ""}`}>
          {view.checkStatus.message}
        </div>
      )}
    </div>
  );
}

// A stack's own actions, as a sheet with touch-size rows. The ones that
// recreate or stop the whole stack take a second tap, as in the bottom Dock.
function StackSheet({
  open,
  composeProject,
  stack,
  onClose,
}: {
  open: boolean;
  composeProject: string;
  stack: DockStackActions | null;
  onClose: () => void;
}) {
  const { armedIds, arm, disarm } = useArmedKill(KILL_ARM_DISARM_MS);
  const row = (key: string, label: string, run: () => void, confirm?: string) => {
    const armed = armedIds.has(key);
    return (
      <button
        key={key}
        type="button"
        className={`dock-view-sheet-row${confirm ? " danger" : ""}${armed ? " armed" : ""}`}
        onClick={() => {
          if (confirm && !armed) {
            arm(key);
            return;
          }
          disarm(key);
          run();
          onClose();
        }}
      >
        {armed && confirm ? confirm : label}
      </button>
    );
  };
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      label={`${composeProject} stack actions`}
      closeLabel="Close stack actions"
      title={composeProject}
      sheetClassName="mobile-session-sheet--tablet dock-view-sheet"
      backStack
    >
      {stack && (
        <div className="dock-view-sheet-rows">
          {row("restart", "Restart stack", stack.restart)}
          {row("apply", "Apply config", stack.apply)}
          {stack.canPull &&
            row(
              "pull",
              "Pull & restart stack",
              stack.pullAndRestart,
              "Tap again — restarts the whole stack",
            )}
          {stack.canRebuild &&
            row(
              "rebuild",
              "Rebuild & restart stack",
              stack.rebuildAndRestart,
              "Tap again — rebuilds and restarts the whole stack",
            )}
          {row("stop", "Stop stack", stack.stop, "Tap again — stops the whole stack")}
        </div>
      )}
    </BottomSheet>
  );
}

// Keyed by project: the panel keeps the view mounted when the followed
// project changes, and the Dock's state (controls, held rows, conflicts,
// selection) belongs to one project. Without the key, the old project's rows
// would show, and be startable, under the new project until its first fetch
// lands, and its discovered services would be held as "recreating" rows.
export function DockSidebarView(props: RightSidebarViewProps) {
  return <DockSidebarViewForProject key={props.projectId} {...props} />;
}

function DockSidebarViewForProject({ projectId, actions }: RightSidebarViewProps) {
  // "Open holder" on a port-in-use row opens the session that holds the port,
  // the way the other sidebar views open a session (the store's request,
  // which App turns into a pane).
  const dock = useDockProject(projectId, {
    autoAttach: false,
    onOpenSession: (session) => useDashboardStore.getState().requestOpenSession(session.id),
  });
  const {
    configuredControls,
    ungroupedDockerControls,
    standaloneOrphanControls,
    stackGroupRenderData,
    groupedOrphansByProject,
    allRenderedControls,
    controlView,
    stackActions,
  } = dock;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // The stack whose sheet is open. Kept (with `open` false) while the sheet
  // animates out, so its rows do not vanish mid-exit.
  // `opened` counts openings and keys the sheet, so an action armed in one
  // opening (or for another stack) is never still armed in the next.
  const [sheet, setSheet] = useState<{
    composeProject: string;
    open: boolean;
    opened: number;
  } | null>(null);

  // A selection whose row is gone (a stack action finished, a service went
  // away) falls back to the first running row, then the first row.
  const keys = allRenderedControls.map(dockRowKey);
  const effectiveKey =
    selectedKey !== null && keys.includes(selectedKey)
      ? selectedKey
      : (allRenderedControls.filter((c) => dock.runningFor(c)).map(dockRowKey)[0] ??
        keys[0] ??
        null);
  const selectedControl = allRenderedControls.find((c) => dockRowKey(c) === effectiveKey) ?? null;
  const selected = selectedControl ? controlView(selectedControl) : null;

  // Selecting a Compose service starts its log stream when it is off (see the
  // header comment). Keyed on the row and its running state, so it fires once
  // per selection, not on every poll.
  // Only a row the user tapped: the fallback selection never starts anything.
  const startLog =
    selected &&
    selectedKey === effectiveKey &&
    rowKind(selected.control) === "service" &&
    !selected.running &&
    !selected.held
      ? selected
      : null;
  const startLogKey = startLog ? dockRowKey(startLog.control) : null;
  // Each tap counts, so tapping the selected row again restarts a log
  // stream that ended (a service restart ends `docker logs`).
  const [taps, setTaps] = useState(0);
  const startedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (startLogKey === null) return;
    const attempt = `${startLogKey}#${taps}`;
    if (startedForRef.current === attempt) return;
    startedForRef.current = attempt;
    void startLog?.start();
    // startLog is this render's view of the same row; the key is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startLogKey, taps]);

  const select = (control: DockControl) => {
    setSelectedKey(dockRowKey(control));
    setTaps((n) => n + 1);
  };

  const renderRow = (control: DockControl) => (
    <DockRow
      key={control.id}
      view={controlView(control)}
      selected={dockRowKey(control) === effectiveKey}
      onSelect={() => select(control)}
    />
  );

  const otherControls = [...ungroupedDockerControls, ...standaloneOrphanControls];
  const sheetGroup = stackGroupRenderData.find(
    (g) => g.group.composeProject === sheet?.composeProject,
  );
  const empty = allRenderedControls.length === 0;

  return (
    <div className="dock-sidebar-view rs-fill">
      <SidebarHeader label={VIEW_TITLES.dock} />
      <div className="dock-view-list">
        {empty && (
          <EmptyStateNote>
            No commands or Compose services.{" "}
            <button
              type="button"
              className="dock-view-link"
              onClick={() => actions.onOpenDockConfig(projectId)}
            >
              Set up dock.json
            </button>
          </EmptyStateNote>
        )}
        {configuredControls.length > 0 && (
          <section className="dock-view-section" aria-label="Commands">
            <div className="dock-view-heading">
              <span>Commands</span>
            </div>
            {configuredControls.map(renderRow)}
          </section>
        )}
        {stackGroupRenderData.map(({ group, serviceControls, ephemeralControlsInGroup }) => {
          const stack = stackActions(group);
          return (
            <section
              key={group.composeProject}
              className="dock-view-section"
              aria-label={`Stack ${group.composeProject}`}
            >
              <div className="dock-view-heading">
                <ContainerIcon size={11} />
                <span>{group.composeProject}</span>
                {ephemeralControlsInGroup.length > 0 && <small>running…</small>}
                {stack.status && (
                  <small className={stack.status.isError ? "error" : undefined}>
                    {stack.status.message}
                  </small>
                )}
                {stack.hasActions && (
                  <button
                    type="button"
                    className="dock-view-stack-menu"
                    aria-label={`${group.composeProject} stack actions`}
                    aria-haspopup="dialog"
                    onClick={() =>
                      setSheet((prev) => ({
                        composeProject: group.composeProject,
                        open: true,
                        opened: (prev?.opened ?? 0) + 1,
                      }))
                    }
                  >
                    ⋯
                  </button>
                )}
              </div>
              {serviceControls.map(renderRow)}
              {ephemeralControlsInGroup.map(renderRow)}
              {(groupedOrphansByProject.get(group.composeProject) ?? []).map(renderRow)}
            </section>
          );
        })}
        {otherControls.length > 0 && (
          <section className="dock-view-section" aria-label="Other containers">
            <div className="dock-view-heading">
              <span>Other containers</span>
            </div>
            {otherControls.map(renderRow)}
          </section>
        )}
      </div>
      {selected && <DockActions key={selected.control.id} view={selected} />}
      {selected && (
        <div className="dock-view-log" aria-label={`${selected.control.title} log, read only`}>
          {selected.running ? (
            <div className="dock-view-log-body">
              <TerminalPane
                key={selected.running.id}
                params={{ sessionId: selected.running.id }}
                readOnly
                captureCtrlC
              />
            </div>
          ) : (
            <EmptyStateNote>
              {rowKind(selected.control) === "command"
                ? "Not running. Start it to see its log."
                : "No log stream."}
            </EmptyStateNote>
          )}
        </div>
      )}
      <StackSheet
        key={sheet?.opened ?? 0}
        open={sheet?.open === true && sheetGroup !== undefined}
        composeProject={sheet?.composeProject ?? ""}
        stack={sheetGroup ? stackActions(sheetGroup.group) : null}
        onClose={() => setSheet((prev) => (prev ? { ...prev, open: false } : prev))}
      />
    </div>
  );
}
