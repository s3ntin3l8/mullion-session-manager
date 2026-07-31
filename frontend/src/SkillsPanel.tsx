import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api.js";
import type { SkillInfo, SkillScope } from "./api.js";
import { SkillIcon } from "./icons.js";

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
// for a project — read-only, discovery-only (issue #432's slice 1; see
// skills.ts's own header comment for why enable/disable is a follow-up).
// Fetched once on open, never polled — same "these files change rarely"
// reasoning as AgentRulesPanel.
export function SkillsPanel({ params }: { params: SkillsPanelParams }) {
  const [skills, setSkills] = useState<SkillInfo[] | undefined>(undefined);
  const [loadError, setLoadError] = useState(false);
  const [selectedDir, setSelectedDir] = useState<string | null>(null);

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
                onClick={() => setSelectedDir(row.sourceDir)}
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
          </>
        )}
      </div>
    </div>
  );
}
