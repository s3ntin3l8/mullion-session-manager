import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import type { SkillAgent, SkillInfo, SkillScope } from "./api.js";
import { SkillIcon } from "./icons.js";
import { Toggle } from "./settings/primitives.js";

export interface SkillsPanelParams {
  projectId: number;
}

const SCOPE_LABEL: Record<SkillScope, string> = {
  project: "Project",
  global: "Global",
  builtin: "Builtin",
};

const SCOPE_ORDER: SkillScope[] = ["project", "global", "builtin"];

const AGENT_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "opencode",
  agy: "agy",
};

// A dockview panel (opened from the CommandPalette's Integrations section,
// same pattern as GitPanel/AgentRulesPanel) showing every skill discovered
// for a project — discovery (issue #432's slice 1) plus, for Codex/opencode
// only, an enable/disable toggle (issue #463; see skills.ts's own header
// comment for why Claude Code/agy stay read-only this slice —
// `enabledByAgent[agent]` is `null` for those). Fetched once on open, never
// polled — same "these files change rarely" reasoning as AgentRulesPanel.
export function SkillsPanel({ params }: { params: SkillsPanelParams }) {
  const [skills, setSkills] = useState<SkillInfo[] | undefined>(undefined);
  const [loadError, setLoadError] = useState(false);
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  // Hermes review, PR #469, round 4 — was a single SkillAgent|null flag, so
  // an in-flight toggle silently dropped clicks on every OTHER toggle too
  // (e.g. codex mid-flight blocked clicking opencode's toggle on the same
  // skill). Keyed by `${sourceDir}:${agent}` so only the specific toggle
  // actually in flight is disabled.
  const [togglingKey, setTogglingKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchSkills = useCallback(
    async (cancelledRef?: { current: boolean }) => {
      try {
        const result = await api.listProjectSkills(params.projectId);
        if (cancelledRef?.current) return;
        setSkills(result);
        setLoadError(false);
      } catch (err) {
        if (cancelledRef?.current) return;
        console.debug("[SkillsPanel] listProjectSkills failed", err);
        setLoadError(true);
      }
    },
    [params.projectId],
  );

  useEffect(() => {
    const cancelledRef = { current: false };
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchSkills(cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
  }, [fetchSkills]);

  // Non-optimistic by design — same posture as AgentRulesPanel's
  // handleSave/handleDelete: a full refetch after every write rather than
  // patching just the toggled row into client state, because
  // `enabledByAgent` is derived server-side from files this client doesn't
  // model (config.toml/opencode.json), not from anything the client could
  // recompute itself.
  const handleToggle = useCallback(
    async (skill: SkillInfo, agent: SkillAgent, nextEnabled: boolean) => {
      setTogglingKey(`${skill.sourceDir}:${agent}`);
      setActionError(null);
      try {
        await api.writeSkillEnabled(params.projectId, agent, skill.name, nextEnabled);
        await fetchSkills();
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : "Failed to toggle skill");
      } finally {
        setTogglingKey(null);
      }
    },
    [params.projectId, fetchSkills],
  );

  const grouped = useMemo(() => {
    if (!skills) return [];
    const byScope = new Map<SkillScope, SkillInfo[]>();
    for (const skill of skills) {
      const rows = byScope.get(skill.scope) ?? [];
      rows.push(skill);
      byScope.set(skill.scope, rows);
    }
    return SCOPE_ORDER.filter((scope) => byScope.has(scope)).map((scope) => ({
      scope,
      rows: byScope.get(scope)!.sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }, [skills]);

  const selected = skills?.find((s) => s.sourceDir === selectedDir) ?? null;

  if (skills === undefined) {
    if (loadError) {
      return (
        <div className="github-panel-empty">
          <div>Couldn't load skills.</div>
          <button className="git-panel-fetch-btn" onClick={() => void fetchSkills()}>
            Retry
          </button>
        </div>
      );
    }
    return <div className="github-panel-empty">Loading…</div>;
  }

  if (skills.length === 0) {
    return (
      <div className="github-panel-empty">
        <SkillIcon size={20} />
        <div>No skills found for this project or its host.</div>
      </div>
    );
  }

  return (
    <div className="agent-rules-panel">
      <div className="agent-rules-panel-list cmux-scroll">
        {grouped.map((group) => (
          <div key={group.scope} className="github-panel-section">
            <div className="github-panel-section-title">{SCOPE_LABEL[group.scope]}</div>
            {group.rows.map((row) => (
              <button
                key={row.sourceDir}
                className={`agent-rules-panel-row${row.sourceDir === selectedDir ? " selected" : ""}`}
                onClick={() => {
                  // Hermes review, PR #469, round 4 — actionError used to
                  // persist across selection changes, showing a stale error
                  // for a previously-selected skill's failed toggle.
                  setActionError(null);
                  setSelectedDir(row.sourceDir);
                }}
              >
                <span className="agent-rules-panel-row-name">{row.name}</span>
                <span className="agent-rules-panel-row-meta">
                  {row.agents.map((a) => AGENT_LABEL[a] ?? a).join(", ")}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="agent-rules-panel-editor">
        {!selected ? (
          <div className="github-panel-empty">
            <SkillIcon size={20} />
            <div>Select a skill to view its details.</div>
          </div>
        ) : (
          <>
            <div className="agent-rules-panel-editor-header">
              <div className="agent-rules-panel-editor-title">
                <SkillIcon size={14} />
                {selected.name}
                <span className="agent-rules-panel-row-meta">
                  {SCOPE_LABEL[selected.scope]} ·{" "}
                  {selected.agents.map((a) => AGENT_LABEL[a] ?? a).join(", ")}
                </span>
              </div>
            </div>
            <div className="agent-rules-panel-notice">{selected.description}</div>
            <div className="agent-rules-panel-row-meta">{selected.sourceDir}</div>
            {actionError && <div className="agent-rules-panel-notice error">{actionError}</div>}
            {
              // Only agents whose enabledByAgent is a real boolean get a
              // toggle — null (claude-code/agy, an ambiguous name, or an
              // unreadable config) stays read-only, already covered by the
              // agent list in the title line above.
              selected.agents
                .filter((agent) => typeof selected.enabledByAgent[agent] === "boolean")
                .map((agent) => {
                  const enabled = selected.enabledByAgent[agent] as boolean;
                  const key = `${selected.sourceDir}:${agent}`;
                  return (
                    <div key={agent} className="skills-panel-toggle-row">
                      <Toggle
                        size="small"
                        on={enabled}
                        disabled={togglingKey === key}
                        onChange={(next) => {
                          if (togglingKey === key) return;
                          void handleToggle(selected, agent, next);
                        }}
                        ariaLabel={`${AGENT_LABEL[agent] ?? agent} skill enabled`}
                      />
                      <span className="git-panel-toggle-label">
                        {AGENT_LABEL[agent] ?? agent}: {enabled ? "Enabled" : "Disabled"}
                      </span>
                    </div>
                  );
                })
            }
          </>
        )}
      </div>
    </div>
  );
}
