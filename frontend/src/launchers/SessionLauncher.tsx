import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject, ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { normalizeAgentId } from "../api/index.js";
import type { Launcher, Session } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";
import type { LauncherRequest, LauncherTarget } from "../store/types.js";
import { Modal } from "../ui/Modal.js";
import { BottomSheet } from "../ui/BottomSheet.js";
import { Dropdown, TextInput } from "../ui/primitives.js";
import { PlusIcon, SearchIcon } from "../ui/icons.js";
import { useCoarsePointer } from "../lib/layoutTier.js";
import { matchesQuery } from "../matchQuery.js";
import { resolveLauncherLogo } from "../cliLogos.js";
import { ModelSelect } from "../settings/ModelPicker.js";
import { WorktreeOptions } from "../command-palette/WorktreeOptions.js";
import { AUTO_VALUE, OWN_HOST_VALUE, describeAutoPreview } from "../command-palette/hostTarget.js";
import { buildPickerSections } from "../lib/mobileSessionPicker.js";
import type { PickerPanel } from "../lib/mobileSessionPicker.js";
import { taskLinkedSessionIds } from "../boardLanes.js";
import type { IDockviewPanel } from "dockview";
import { canLaunchTerminal, panelSessionId } from "../panelUtils.js";
import { resolveSkipPermissions } from "./skipPermissions.js";
import { buildSkipPermissionsAgentIds, isHiddenAgent } from "./launcherList.js";
import {
  resolveInitialLaunchProjectId,
  useLaunchModel,
  useLaunchSession,
  useLaunchTarget,
  useProjectLaunchers,
} from "./useSessionLaunch.js";

// Issue #3013 — the New session launcher. "New session" opens this; ⌘K stays
// the command palette (commands, and launchers by typing). The same choices,
// in the same order, on desktop and touch: Where (project, host, worktree),
// agents as tiles with the selected agent's options in place (its model and
// the skip-permissions switch), shells and scripts as a list, and Launch.
// Desktop gets a keyboard-operable dialog (ui/Modal.tsx); a coarse pointer
// gets a sheet (ui/BottomSheet.tsx) with a second tab, Open existing, because
// a touch layout has no sidebar to pick a session from.
//
// The launch itself is the palette's, shared through useSessionLaunch.ts, so
// both surfaces send exactly the same request for the same choices.

export interface SessionLauncherHostProps {
  // The open tiled panels — the Open existing tab names which sessions are
  // already on screen (lib/mobileSessionPicker.ts).
  panels: IDockviewPanel[];
  // Phone: the sheet spans the full width; other touch tiers centre it.
  phone: boolean;
  // `target` is the request's target (which half the session should land
  // on). Passed through, not acted on yet: a later slice places by it.
  onLaunched: (session: Session, target: LauncherTarget | null) => void;
  onOpenSession: (session: Session, target: LauncherTarget | null) => void;
}

// Mounted once by App. Reads the open request from the store; a dialog is a
// fresh mount per open, the sheet stays mounted so it can animate out.
export function SessionLauncherHost({
  panels,
  phone,
  onLaunched,
  onOpenSession,
}: SessionLauncherHostProps) {
  const request = useDashboardStore((s) => s.launcherRequest);
  const viewMode = useDashboardStore((s) => s.viewMode);
  const coarse = useCoarsePointer();
  // Terminals only launch from a workspace view (issue #730) — the same gate
  // App's command palette opener applies. The store can't (see its comment).
  const open = request !== null && canLaunchTerminal(viewMode);
  // The last request, kept while the sheet animates out, so its body doesn't
  // blank mid-exit. A new request remounts the body: fresh choices per open.
  const [shown, setShown] = useState<LauncherRequest | null>(request);
  if (request !== null && request !== shown) setShown(request);
  const suppressRestoreRef = useRef<(() => void) | null>(null);
  const close = () => useDashboardStore.getState().closeLauncher();
  // A request made (or left open) outside a workspace view is dropped, not
  // parked: otherwise it would pop up unprompted on the way back.
  useEffect(() => {
    if (request !== null && !canLaunchTerminal(viewMode)) {
      useDashboardStore.getState().closeLauncher(request.seq);
    }
  }, [request, viewMode]);
  const pickerPanels = useMemo<PickerPanel[]>(
    () =>
      panels.map((panel) => ({
        id: panel.id,
        title: panel.title ?? "",
        sessionId: panelSessionId(panel),
      })),
    [panels],
  );

  if (!coarse) {
    if (!open || request === null) return null;
    return (
      <LauncherDialog
        key={request.seq}
        request={request}
        onClose={close}
        onLaunched={onLaunched}
        suppressRestoreRef={suppressRestoreRef}
      />
    );
  }
  return (
    <LauncherSheet
      open={open}
      request={shown}
      phone={phone}
      panels={pickerPanels}
      onClose={close}
      onLaunched={onLaunched}
      onOpenSession={onOpenSession}
      suppressRestoreRef={suppressRestoreRef}
    />
  );
}

// After a launch (or an Open existing pick) settles: close the launcher and
// keep focus off the opener — but only if the launcher is still the open the
// action came from. A launch that outlives its launcher (closed mid-flight,
// then opened again) must not close the new one or steal its focus restore.
function finishOpen(seq: number, suppressRestoreRef: MutableRefObject<(() => void) | null>) {
  if (useDashboardStore.getState().launcherRequest?.seq !== seq) return;
  suppressRestoreRef.current?.();
  useDashboardStore.getState().closeLauncher(seq);
}

interface SurfaceProps {
  onClose: () => void;
  onLaunched: (session: Session, target: LauncherTarget | null) => void;
  suppressRestoreRef: MutableRefObject<(() => void) | null>;
}

function LauncherDialog({
  request,
  onClose,
  onLaunched,
  suppressRestoreRef,
}: SurfaceProps & { request: LauncherRequest }) {
  const filterRef = useRef<HTMLInputElement>(null);
  return (
    <Modal
      onClose={onClose}
      icon={<PlusIcon size={15} />}
      title="New session"
      modalClassName="create-modal session-launcher"
      bodyClassName="create-modal-body session-launcher-body"
      initialFocusRef={filterRef}
      suppressRestoreRef={suppressRestoreRef}
    >
      <LauncherNewSession
        coarse={false}
        initialProjectId={request.target?.projectId ?? null}
        filterRef={filterRef}
        onLaunched={(session) => {
          finishOpen(request.seq, suppressRestoreRef);
          onLaunched(session, request.target);
        }}
      />
    </Modal>
  );
}

function LauncherSheet({
  open,
  request,
  phone,
  panels,
  onClose,
  onLaunched,
  onOpenSession,
  suppressRestoreRef,
}: SurfaceProps & {
  open: boolean;
  request: LauncherRequest | null;
  phone: boolean;
  panels: PickerPanel[];
  onOpenSession: (session: Session, target: LauncherTarget | null) => void;
}) {
  const [tab, setTab] = useState<"new" | "open">("new");
  // Each open starts on New session, with fresh choices. Adjusted during
  // render (not an effect) when the request changes identity.
  const [tabFor, setTabFor] = useState(request);
  if (tabFor !== request) {
    setTabFor(request);
    setTab("new");
  }
  const tabsId = useId();
  const target = request?.target ?? null;
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      label="New session"
      closeLabel="Close new session"
      title="New session"
      backStack
      backdropClose="press-release"
      sheetClassName={`session-launcher-sheet${phone ? "" : " mobile-session-sheet--tablet"}`}
      suppressRestoreRef={suppressRestoreRef}
    >
      <div className="session-launcher-tabs" role="tablist" aria-label="New session">
        <button
          type="button"
          role="tab"
          id={`${tabsId}-new-tab`}
          aria-selected={tab === "new"}
          aria-controls={`${tabsId}-new`}
          tabIndex={tab === "new" ? 0 : -1}
          className={tab === "new" ? "on" : undefined}
          onClick={() => setTab("new")}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
              e.preventDefault();
              setTab("open");
              e.currentTarget.parentElement
                ?.querySelector<HTMLElement>('[role="tab"]:last-child')
                ?.focus();
            }
          }}
        >
          New session
        </button>
        <button
          type="button"
          role="tab"
          id={`${tabsId}-open-tab`}
          aria-selected={tab === "open"}
          aria-controls={`${tabsId}-open`}
          tabIndex={tab === "open" ? 0 : -1}
          className={tab === "open" ? "on" : undefined}
          onClick={() => setTab("open")}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
              e.preventDefault();
              setTab("new");
              e.currentTarget.parentElement
                ?.querySelector<HTMLElement>('[role="tab"]:first-child')
                ?.focus();
            }
          }}
        >
          Open existing
        </button>
      </div>
      {/* Both panels stay mounted (the inactive one `hidden`), so switching
          tabs keeps the New session choices and an in-flight launch's guard. */}
      {request !== null && (
        <div
          role="tabpanel"
          hidden={tab !== "new"}
          id={`${tabsId}-new`}
          aria-labelledby={`${tabsId}-new-tab`}
          className="session-launcher-body session-launcher-panel"
        >
          <LauncherNewSession
            // A fresh body per open: the sheet itself stays mounted.
            key={request.seq}
            coarse
            initialProjectId={request.target?.projectId ?? null}
            onLaunched={(session) => {
              finishOpen(request.seq, suppressRestoreRef);
              onLaunched(session, target);
            }}
          />
        </div>
      )}
      {request !== null && (
        <div
          role="tabpanel"
          hidden={tab !== "open"}
          id={`${tabsId}-open`}
          aria-labelledby={`${tabsId}-open-tab`}
          className="session-launcher-panel session-launcher-existing"
        >
          <OpenExistingList
            panels={panels}
            onOpen={(session) => {
              finishOpen(request.seq, suppressRestoreRef);
              onOpenSession(session, target);
            }}
          />
        </div>
      )}
    </BottomSheet>
  );
}

// The New session choices — the same in the dialog and in the sheet.
function LauncherNewSession({
  coarse,
  initialProjectId,
  filterRef,
  onLaunched,
}: {
  coarse: boolean;
  // A project to preselect (a sidebar project's "+"); null picks the usual
  // default (the focused pane's project, then the last launched into).
  initialProjectId: number | null;
  filterRef?: MutableRefObject<HTMLInputElement | null>;
  onLaunched: (session: Session) => void;
}) {
  const { projects, sessions, settings, activePanelId, theme } = useDashboardStore(
    useShallow((s) => ({
      projects: s.projects,
      sessions: s.sessions,
      settings: s.settings,
      activePanelId: s.activePanelId,
      theme: s.theme,
    })),
  );
  // The project stays changeable either way: a preselected project is a
  // starting point, not a binding (unlike the palette's project scope).
  const [projectId, setProjectId] = useState<number | null>(() =>
    resolveInitialLaunchProjectId({
      scope:
        initialProjectId !== null && projects.some((p) => p.id === initialProjectId)
          ? "project"
          : "global",
      projectId: initialProjectId,
      activePanelId,
      sessions,
      projects,
    }),
  );
  const target = projects.find((p) => p.id === projectId) ?? null;
  const launchTarget = useLaunchTarget(target, sessions);
  const { launchers, loaded } = useProjectLaunchers(target?.id ?? null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Per-launch skip-permissions override, for the agent it was set on only.
  const [skipOverride, setSkipOverride] = useState<{ agentId: string; value: boolean } | null>(
    null,
  );
  const ids = useId();

  const matches = (l: Launcher) => query.trim() === "" || matchesQuery([l.title, l.command], query);
  const agents = launchers.filter(
    (l) => l.kind === "agent" && !isHiddenAgent(l, settings.launchers.hiddenAgents),
  );
  const visibleAgents = agents.filter(matches);
  const rows = launchers.filter((l) => l.kind !== "agent" && matches(l));
  // The selected agent is derived, so a filter that hides it falls back to
  // the default agent, then the first match, without an effect.
  const selected =
    visibleAgents.find((l) => l.id === selectedId) ??
    visibleAgents.find((l) => l.id === `agent:${settings.launchers.defaultAgent}`) ??
    visibleAgents[0] ??
    null;
  const skipAgentIds = useMemo(
    () => buildSkipPermissionsAgentIds(settings.launchers.skipPermissionsAgents, launchers),
    [settings.launchers.skipPermissionsAgents, launchers],
  );
  const model = useLaunchModel(selected?.command ?? null);
  const skipSetting = selected
    ? (resolveSkipPermissions(selected, settings, null) ?? false)
    : false;
  const skipOverrideValue =
    selected && skipOverride?.agentId === selected.id ? skipOverride.value : null;
  const skipValue = skipOverrideValue ?? skipSetting;

  const { launch, launching, launchError } = useLaunchSession({
    target,
    launchTarget,
    onLaunched,
  });
  const launchAgent = (agent: Launcher) =>
    launch(agent, {
      model: model.forLaunch(agent.command),
      skipPermissionsOverride: skipOverride?.agentId === agent.id ? skipOverride.value : null,
    });
  // Shells and scripts have no options.
  const launchRow = (row: Launcher) => launch(row);
  // What Enter launches from the filter: the selected agent, else the first
  // shell or script.
  const primary = selected ?? rows[0] ?? null;
  const launchPrimary = () => {
    if (!primary) return;
    if (primary.kind === "agent") launchAgent(primary);
    else launchRow(primary);
  };

  const tilesRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const focusTile = (id: string) =>
    Array.from(tilesRef.current?.querySelectorAll<HTMLElement>("[data-launcher-id]") ?? [])
      .find((el) => el.dataset.launcherId === id)
      ?.focus();
  const focusRow = (index: number) =>
    rowsRef.current?.querySelectorAll<HTMLElement>("[data-launcher-row]")[index]?.focus();
  const focusEntry = () => {
    if (selected) focusTile(selected.id);
    else if (rows.length > 0) focusRow(0);
  };

  // Typing anywhere in the launcher filters: a printable key outside a text
  // field moves focus to the filter, and the browser delivers the key there
  // (the palette's own "type to search" trick). Desktop only — the sheet has
  // no filter, so it never raises an on-screen keyboard.
  const onKeyDownCapture = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (coarse || !filterRef?.current) return;
    const el = e.target as HTMLElement;
    if (el.closest("input, select, textarea")) return;
    if (e.key.length === 1 && e.key !== " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
      filterRef.current.focus();
    }
  };

  const onFilterKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      launchPrimary();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusEntry();
    }
  };

  // The tiles are one radio group: arrows move the selection (and focus)
  // through it, wrapping; Down from the last tile moves on to the list.
  const onTileKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (step !== 0) {
      e.preventDefault();
      if (e.key === "ArrowDown" && index === visibleAgents.length - 1 && rows.length > 0) {
        focusRow(0);
        return;
      }
      if (e.key === "ArrowUp" && index === 0 && filterRef?.current) {
        filterRef.current.focus();
        return;
      }
      const next = visibleAgents[(index + step + visibleAgents.length) % visibleAgents.length];
      if (next) {
        setSelectedId(next.id);
        focusTile(next.id);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      const agent = visibleAgents[index];
      if (agent) launchAgent(agent);
    }
  };

  const onRowKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(Math.min(index + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (index > 0) focusRow(index - 1);
      else if (selected) focusTile(selected.id);
      else filterRef?.current?.focus();
    }
  };

  const projectOptions = projects.map((p) => ({ value: String(p.id), label: p.name }));
  const { hosts, hostOptions, showHostChip, hostChoice, onHostChange, autoPreview } = launchTarget;

  return (
    <div className="session-launcher-content" onKeyDownCapture={onKeyDownCapture}>
      {!coarse && (
        <div className="session-launcher-filter">
          <SearchIcon size={15} strokeWidth={1.9} />
          <TextInput
            ref={filterRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onFilterKeyDown}
            placeholder="Filter agents, shells and scripts…"
            aria-label="Filter agents, shells and scripts"
          />
        </div>
      )}

      <section className="session-launcher-section" aria-labelledby={`${ids}-where`}>
        <h3 id={`${ids}-where`} className="session-launcher-heading">
          Where
        </h3>
        <div className="session-launcher-where">
          {projects.length > 0 ? (
            <Dropdown
              ariaLabel="Project"
              className="session-launcher-project"
              value={projectId !== null ? String(projectId) : ""}
              onChange={(v) => setProjectId(Number(v))}
              options={projectOptions}
            />
          ) : (
            <span className="session-launcher-hint">Add a project first.</span>
          )}
          {showHostChip && target && (
            <Dropdown
              ariaLabel="Host"
              value={
                hostChoice === null || hostChoice === target.hostId ? OWN_HOST_VALUE : hostChoice
              }
              onChange={onHostChange}
              options={hostOptions}
            />
          )}
          {target && (
            <WorktreeOptions
              projectId={target.id}
              enabled={launchTarget.worktreeEnabled}
              onEnabledChange={launchTarget.setWorktreeEnabled}
              baseRef={launchTarget.worktreeBaseRef}
              onBaseRefChange={launchTarget.setWorktreeBaseRef}
              baseOnPlacedHost={launchTarget.placedElsewhere}
            />
          )}
        </div>
        {showHostChip && hostChoice === AUTO_VALUE && (
          <div className="session-launcher-hint">
            {autoPreview
              ? describeAutoPreview(autoPreview, hosts)
              : "Auto picks the host when you launch."}
          </div>
        )}
      </section>

      {target && !loaded && (
        <div className="session-launcher-hint" role="status">
          Loading launchers…
        </div>
      )}

      {target && loaded && (
        <>
          <section className="session-launcher-section" aria-labelledby={`${ids}-agents`}>
            <h3 id={`${ids}-agents`} className="session-launcher-heading">
              Agent
            </h3>
            {visibleAgents.length === 0 ? (
              <div className="session-launcher-hint">
                {agents.length === 0 ? "No agents found for this project." : "No agent matches."}
              </div>
            ) : (
              <div
                ref={tilesRef}
                role="radiogroup"
                aria-labelledby={`${ids}-agents`}
                className="session-launcher-tiles"
              >
                {visibleAgents.map((agent, index) => {
                  const isSelected = agent.id === selected?.id;
                  const skips = skipAgentIds.has(normalizeAgentId(agent.id));
                  const logo = resolveLauncherLogo(agent, theme);
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      // Roving tabindex: one Tab stop for the group.
                      tabIndex={isSelected ? 0 : -1}
                      data-launcher-id={agent.id}
                      className={`session-launcher-tile${isSelected ? " on" : ""}`}
                      onClick={() => setSelectedId(agent.id)}
                      onDoubleClick={() => launchAgent(agent)}
                      onKeyDown={(e) => onTileKeyDown(e, index)}
                    >
                      <span className="session-launcher-tile-icon" aria-hidden="true">
                        {logo ? <img src={logo} alt="" width={20} height={20} /> : "✳"}
                      </span>
                      <span className="session-launcher-tile-name">{agent.title}</span>
                      {skips && (
                        <span className="session-launcher-tile-flag">
                          <span aria-hidden="true">⚠</span>
                          <span className="visually-hidden">
                            , skips permission prompts by settings
                          </span>
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            {selected && (
              <AgentOptions
                agentTitle={selected.title}
                idPrefix={ids}
                model={model}
                skipValue={skipValue}
                skipSetting={skipSetting}
                overridden={skipOverrideValue !== null}
                onSkipChange={(value) => setSkipOverride({ agentId: selected.id, value })}
              />
            )}
          </section>

          <section className="session-launcher-section" aria-labelledby={`${ids}-rows`}>
            <h3 id={`${ids}-rows`} className="session-launcher-heading">
              Shells and scripts
            </h3>
            {rows.length === 0 ? (
              <div className="session-launcher-hint">
                {query.trim() ? "No shell or script matches." : "None for this project."}
              </div>
            ) : (
              <div ref={rowsRef} className="session-launcher-rows">
                {rows.map((row, index) => (
                  <button
                    key={row.id}
                    type="button"
                    data-launcher-row
                    className="session-launcher-row"
                    onClick={() => launchRow(row)}
                    onKeyDown={(e) => onRowKeyDown(e, index)}
                  >
                    <span className="session-launcher-row-icon" aria-hidden="true">
                      ›
                    </span>
                    <span className="session-launcher-row-text">
                      <span className="session-launcher-row-title">{row.title}</span>
                      {row.command !== row.title && (
                        <span className="session-launcher-row-sub">{row.command}</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {launchError && (
        <div className="session-launcher-error" role="alert">
          {launchError}
        </div>
      )}

      <div className="session-launcher-footer">
        {!coarse && (
          <span className="session-launcher-keys" aria-hidden="true">
            <span className="kbd">↑↓←→</span> move · type to filter · <span className="kbd">↵</span>{" "}
            launch
          </span>
        )}
        <button
          type="button"
          className="sb-btn sb-btn--primary session-launcher-launch"
          // `aria-disabled`, not `disabled`, while a launch is in flight: a
          // disabled button drops focus out of the dialog, and a failed launch
          // would leave Tab and Escape with nothing to act on.
          disabled={!primary}
          aria-disabled={launching || undefined}
          onClick={() => {
            if (!launching) launchPrimary();
          }}
        >
          {launching ? "Launching…" : primary ? `Launch ${primary.title}` : "Launch"}
        </button>
      </div>
    </div>
  );
}

// The selected agent's options, in place under the tiles: its model and the
// per-launch skip-permissions override. No hover anywhere: everything is
// shown for the selection, on every pointer.
function AgentOptions({
  agentTitle,
  idPrefix,
  model,
  skipValue,
  skipSetting,
  overridden,
  onSkipChange,
}: {
  agentTitle: string;
  idPrefix: string;
  model: ReturnType<typeof useLaunchModel>;
  skipValue: boolean;
  skipSetting: boolean;
  overridden: boolean;
  onSkipChange: (value: boolean) => void;
}) {
  const skipHint = overridden
    ? `For this session only (${skipSetting ? "on" : "off"} in settings)`
    : `${skipSetting ? "On" : "Off"} in settings for ${agentTitle}`;
  return (
    <div className="session-launcher-options" role="group" aria-labelledby={`${idPrefix}-options`}>
      <span id={`${idPrefix}-options`} className="visually-hidden">
        Options for {agentTitle}
      </span>
      {/* Announces a selection change: the region's contents swap in place,
          which a screen reader would otherwise not notice. */}
      <span className="visually-hidden" role="status" aria-live="polite">
        {agentTitle} selected. Skip permission prompts {skipValue ? "on" : "off"}.
      </span>
      {model.show && (
        <label className="session-launcher-option">
          <span className="session-launcher-option-label">Model</span>
          <ModelSelect
            ariaLabel="Model for this session"
            value={model.value}
            options={model.catalog.options}
            defaultLabel={model.defaultLabel}
            allowCustom={model.catalog.allowCustom}
            onChange={model.setValue}
          />
        </label>
      )}
      <div className="session-launcher-option">
        <span className="session-launcher-option-text">
          <span id={`${idPrefix}-skip`} className="session-launcher-option-label">
            Skip permission prompts
          </span>
          <span id={`${idPrefix}-skip-hint`} className="session-launcher-hint">
            {skipHint}
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={skipValue}
          aria-labelledby={`${idPrefix}-skip`}
          aria-describedby={`${idPrefix}-skip-hint`}
          className={`settings-toggle session-launcher-switch${skipValue ? " on" : ""}`}
          onClick={() => onSkipChange(!skipValue)}
        >
          <span className="settings-toggle-knob" />
        </button>
      </div>
    </div>
  );
}

// Open existing (touch only): the sessions by project, the project named
// under each title — the phone picker's own data (lib/mobileSessionPicker.ts).
function OpenExistingList({
  panels,
  onOpen,
}: {
  panels: PickerPanel[];
  onOpen: (session: Session) => void;
}) {
  const input = useDashboardStore(
    useShallow((s) => ({
      sessions: s.sessions,
      projects: s.projects,
      tasks: s.tasks,
      events: s.events,
      lastSeenSeq: s.lastSeenSeq,
      dismissedEventKeys: s.dismissedEventKeys,
      mutedSessionIds: s.mutedSessionIds,
      hideEndedSessions: s.hideEndedSessions,
      showTaskSessions: s.showTaskSessions,
      workspaces: s.workspaces,
      activeWorkspaceId: s.activeWorkspaceId,
    })),
  );
  const taskSessionIds = useMemo(() => taskLinkedSessionIds(input.tasks), [input.tasks]);
  // Project sections only, deliberately. "Needs you" repeats rows that are
  // already under their project; "Open panes" is mostly panes that are not
  // sessions (git, browser, devices), which this tab is not for. The one
  // session that lives only there — an open pane whose project has been
  // removed — is still reachable from the phone's session switcher.
  const sections = useMemo(
    () =>
      buildPickerSections({ ...input, panels, taskSessionIds }).filter(
        (section) => section.kind === "project",
      ),
    [input, panels, taskSessionIds],
  );
  if (sections.length === 0) {
    return <p className="session-launcher-hint session-launcher-empty">No sessions yet.</p>;
  }
  return (
    <>
      {sections.map((section) => (
        <SessionGroup key={section.key} label={section.label}>
          {section.rows.map((row) =>
            row.session ? (
              <li key={row.key}>
                <button
                  type="button"
                  className="session-launcher-row"
                  onClick={() => onOpen(row.session!)}
                >
                  <span className="session-launcher-row-text">
                    <span className="session-launcher-row-title">{row.title}</span>
                    <span className="session-launcher-row-sub">{section.label}</span>
                  </span>
                  {row.panelId && <span className="session-launcher-row-badge">open</span>}
                </button>
              </li>
            ) : null,
          )}
        </SessionGroup>
      ))}
    </>
  );
}

function SessionGroup({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="session-launcher-section" aria-labelledby={id}>
      <h3 id={id} className="session-launcher-heading">
        {label}
      </h3>
      <ul className="session-launcher-rows">{children}</ul>
    </section>
  );
}
