import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api.js";
import type { DockControlInput } from "./api.js";
import { PlusIcon, CloseIcon, DockIcon } from "./icons.js";
import { ConfirmButton } from "./ConfirmButton.js";
import { Row } from "./settings/primitives.js";
import { useDashboardStore } from "./store.js";

export interface DockConfigPanelParams {
  projectId: number;
}

// U4 (finding U4, .claude/plans/can-we-do-a-moonlit-treasure.md) — a
// dockview panel (opened from the CommandPalette's Integrations section,
// same "open-or-focus-by-stable-id" pattern as GitPanel/AgentRulesPanel/
// SkillsPanel) editing a project's own `.crs/dock.json` — the monitor list
// docs/dock.md documents as hand-edited-on-the-host today. Structured
// (add/remove/edit monitor entries with labeled fields) rather than a raw
// JSON textarea: unlike agent-rules.ts's target files (hand-authored prose,
// where a parse-and-reserialize round trip risks mangling formatting),
// dock.json is genuinely structured data with a small, fixed shape
// (DockControl), so a form is both safer (can't produce malformed JSON at
// all) and not meaningfully lossier than editing the file directly.
//
// Fetched once on open, never polled — same "these files change rarely"
// reasoning AgentRulesPanel/SkillsPanel already use for their own project
// config reads. Whole-document save (not a per-control PATCH): the backend
// route replaces `.crs/dock.json` wholesale on every PUT, same "send the
// full already-edited list" contract agent-rules.ts's PUT has for a single
// target's content.
export function DockConfigPanel({ params }: { params: DockConfigPanelParams }) {
  const [invalid, setInvalid] = useState<{ reason: string | null } | null>(null);
  const [controls, setControls] = useState<DockControlInput[] | undefined>(undefined);
  const [loadError, setLoadError] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Same "read the LIVE value after an await, not the one closed over at
  // call time" reasoning as AgentRulesPanel's own draftRef — handleSave
  // needs to know whether the user kept editing during a (potentially
  // multi-second, for a remote-hosted project) round trip before deciding
  // whether to clear `dirty`.
  const controlsRef = useRef(controls);
  useEffect(() => {
    controlsRef.current = controls;
  }, [controls]);

  const fetchConfig = useCallback(
    async (cancelledRef?: { current: boolean }) => {
      try {
        const result = await api.getProjectDockConfig(params.projectId);
        if (cancelledRef?.current) return;
        setControls(result.controls);
        setInvalid(result.invalid ? { reason: result.reason } : null);
        setLoadError(false);
        setDirty(false);
        setSelectedIndex(null);
      } catch (err) {
        if (cancelledRef?.current) return;
        console.debug("[DockConfigPanel] getProjectDockConfig failed", err);
        setLoadError(true);
      }
    },
    [params.projectId],
  );

  useEffect(() => {
    const cancelledRef = { current: false };
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchConfig(cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
  }, [fetchConfig]);

  const updateControl = useCallback((index: number, patch: Partial<DockControlInput>) => {
    setControls((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
    setDirty(true);
  }, []);

  const addMonitor = useCallback(() => {
    setControls((prev) => [...(prev ?? []), { id: "", title: "", command: "" }]);
    // Selecting the new row is a separate effect from the state update
    // above, not folded into that updater — setControls' updater function
    // can run more than once (React StrictMode, a rebased update), and a
    // side effect like "select the new index" belongs outside it. `prev`
    // here is stale-safe: addMonitor is only ever wired to a plain
    // onClick, so there's no concurrent call that could race it.
    setSelectedIndex((controls ?? []).length);
    setDirty(true);
    setActionError(null);
  }, [controls]);

  const removeMonitor = useCallback((index: number) => {
    setControls((prev) => {
      if (!prev) return prev;
      return prev.filter((_, i) => i !== index);
    });
    setSelectedIndex((current) => (current === index ? null : current));
    setDirty(true);
  }, []);

  const handleDiscard = useCallback(() => {
    void fetchConfig();
  }, [fetchConfig]);

  const handleSave = useCallback(async () => {
    if (!controls) return;
    setSaving(true);
    setActionError(null);
    const savedControls = controls;
    try {
      const result = await api.writeProjectDockConfig(params.projectId, savedControls);
      // Same "only clear dirty if the draft is still exactly what got
      // saved" guard as AgentRulesPanel's handleSave — a remote-hosted
      // project's round trip can take seconds, long enough for more edits
      // to land, which shouldn't get silently marked "saved" when they
      // weren't.
      if (controlsRef.current === savedControls) {
        setControls(result.controls);
        setInvalid(result.invalid ? { reason: result.reason } : null);
        setDirty(false);
      }
      // The Dock's own bottom-panel columns (Dock.tsx) only re-fetch
      // GET .../dock (the MERGED view) on a ~15s poll otherwise — see
      // docs/dock.md's own troubleshooting note. Bumping this shared
      // counter makes a save take effect immediately, without a page
      // reload or waiting out the poll.
      useDashboardStore.getState().bumpDockConfigRefreshTrigger();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [controls, params.projectId]);

  const selected = useMemo(
    () => (selectedIndex !== null ? (controls?.[selectedIndex] ?? null) : null),
    [controls, selectedIndex],
  );

  const envEntries = useMemo(() => Object.entries(selected?.env ?? {}), [selected]);

  const setEnvEntries = useCallback(
    (entries: [string, string][]) => {
      if (selectedIndex === null) return;
      updateControl(selectedIndex, {
        env: entries.length > 0 ? Object.fromEntries(entries) : undefined,
      });
    },
    [selectedIndex, updateControl],
  );

  if (controls === undefined) {
    if (loadError) {
      return (
        <div className="github-panel-empty">
          <div>Couldn't load dock.json.</div>
          <button className="git-panel-fetch-btn" onClick={() => void fetchConfig()}>
            Retry
          </button>
        </div>
      );
    }
    return <div className="github-panel-empty">Loading…</div>;
  }

  return (
    <div className="dock-config-panel">
      {/* Save/Discard are document-level actions (the PUT always replaces
          the whole `controls` array — see this component's own header
          comment), so they live in a toolbar OUTSIDE the per-monitor
          `selected` branch below. Keeping them inside it (an earlier
          version of this panel did) meant removing the only monitor, or
          the currently-selected one, unmounted the whole header along
          with Save — dirty with literally no way to persist it. */}
      <div className="agent-rules-panel-editor-header dock-config-panel-toolbar">
        <div className="agent-rules-panel-editor-title">
          <DockIcon size={14} />
          Dock config
        </div>
        <div className="agent-rules-panel-editor-actions">
          {dirty && (
            <button className="git-panel-fetch-btn" onClick={handleDiscard} disabled={saving}>
              Discard
            </button>
          )}
          <button className="git-panel-fetch-btn" onClick={handleSave} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      {invalid && (
        <div className="agent-rules-panel-notice error dock-config-panel-toolbar-notice">
          The existing dock.json is invalid{invalid.reason ? `: ${invalid.reason}` : ""} — saving
          below replaces it with a fresh, valid config.
        </div>
      )}
      {actionError && (
        <div className="agent-rules-panel-notice error dock-config-panel-toolbar-notice">
          {actionError}
        </div>
      )}

      <div className="agent-rules-panel">
        <div className="agent-rules-panel-list cmux-scroll">
          {controls.length === 0 && (
            <div className="dock-config-panel-empty-hint">No monitors configured yet.</div>
          )}
          {controls.map((control, index) => (
            <button
              key={index}
              className={`agent-rules-panel-row${index === selectedIndex ? " selected" : ""}`}
              onClick={() => setSelectedIndex(index)}
            >
              <DockIcon size={13} style={{ color: "var(--muted)", flexShrink: 0 }} />
              <span className="agent-rules-panel-row-name">
                {control.title || control.id || "Untitled monitor"}
              </span>
            </button>
          ))}
          <button className="git-panel-fetch-btn dock-config-panel-add" onClick={addMonitor}>
            <PlusIcon size={12} /> Add monitor
          </button>
        </div>

        <div className="agent-rules-panel-editor">
          {!selected ? (
            <div className="github-panel-empty">
              <DockIcon size={20} />
              <div>Select a monitor to edit it, or add a new one.</div>
            </div>
          ) : (
            <>
              <div className="dock-config-panel-monitor-header">
                <span>{controlTitle(selected)}</span>
                <ConfirmButton
                  title={`Remove ${controlTitle(selected)}? This can't be undone once saved.`}
                  onConfirm={() => selectedIndex !== null && removeMonitor(selectedIndex)}
                >
                  Remove
                </ConfirmButton>
              </div>

              <div className="dock-config-panel-form cmux-scroll">
                <Row label="ID" desc="A stable, unique identifier for this monitor.">
                  <input
                    type="text"
                    placeholder="dev-server"
                    value={selected.id}
                    onChange={(e) =>
                      selectedIndex !== null && updateControl(selectedIndex, { id: e.target.value })
                    }
                  />
                </Row>
                <Row label="Title" desc="Display name shown in the Dock's column header.">
                  <input
                    type="text"
                    placeholder="Dev server"
                    value={selected.title}
                    onChange={(e) =>
                      selectedIndex !== null &&
                      updateControl(selectedIndex, { title: e.target.value })
                    }
                  />
                </Row>
                <Row label="Command" desc="Shell command to run when this monitor is toggled on.">
                  <input
                    type="text"
                    placeholder="npm run dev"
                    value={selected.command}
                    onChange={(e) =>
                      selectedIndex !== null &&
                      updateControl(selectedIndex, { command: e.target.value })
                    }
                  />
                </Row>
                <Row label="Working directory" desc="Optional — defaults to the project root.">
                  <input
                    type="text"
                    placeholder="packages/frontend"
                    value={selected.cwd ?? ""}
                    onChange={(e) =>
                      selectedIndex !== null &&
                      updateControl(selectedIndex, { cwd: e.target.value || undefined })
                    }
                  />
                </Row>
                <Row label="Height" desc="Optional — initial terminal height in pixels.">
                  <div className="settings-numberfield" style={{ width: 100 }}>
                    <input
                      type="number"
                      min={1}
                      value={selected.height ?? ""}
                      onChange={(e) => {
                        if (selectedIndex === null) return;
                        const raw = e.target.value;
                        updateControl(selectedIndex, {
                          height: raw === "" ? undefined : Number(raw),
                        });
                      }}
                    />
                  </div>
                </Row>
                <Row
                  label="Sync worktree on commit"
                  desc="Periodically reset a preview worktree to the branch's local tip (HMR dev servers only)."
                >
                  <input
                    type="checkbox"
                    checked={selected.worktreeRefresh ?? false}
                    onChange={(e) =>
                      selectedIndex !== null &&
                      updateControl(selectedIndex, { worktreeRefresh: e.target.checked })
                    }
                  />
                </Row>

                <div className="dock-config-panel-env">
                  <div className="settings-row-label">Environment variables</div>
                  {envEntries.map(([key, value], i) => (
                    <div className="dock-config-env-row" key={i}>
                      <input
                        type="text"
                        placeholder="KEY"
                        className="dock-config-env-key"
                        value={key}
                        onChange={(e) => {
                          const next = [...envEntries];
                          next[i] = [e.target.value, value];
                          setEnvEntries(next);
                        }}
                      />
                      <input
                        type="text"
                        placeholder="value"
                        className="dock-config-env-value"
                        value={value}
                        onChange={(e) => {
                          const next = [...envEntries];
                          next[i] = [key, e.target.value];
                          setEnvEntries(next);
                        }}
                      />
                      <button
                        className="dock-config-env-remove"
                        title="Remove"
                        onClick={() => setEnvEntries(envEntries.filter((_, j) => j !== i))}
                      >
                        <CloseIcon size={12} />
                      </button>
                    </div>
                  ))}
                  <button
                    className="git-panel-fetch-btn dock-config-panel-add"
                    onClick={() => setEnvEntries([...envEntries, ["", ""]])}
                  >
                    <PlusIcon size={12} /> Add variable
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function controlTitle(control: DockControlInput): string {
  return control.title || control.id || "Untitled monitor";
}
