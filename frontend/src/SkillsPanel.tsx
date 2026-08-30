import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api/index.js";
import type { SkillAgent, SkillInfo, SkillKind, SkillScope } from "./api/index.js";
import { SkillIcon } from "./ui/icons.js";
import { Toggle } from "./ui/primitives.js";
import { EmptyStateNote } from "./ui/EmptyState.js";

export interface SkillsPanelParams {
  projectId: number;
}

const SCOPE_LABEL: Record<SkillScope, string> = {
  project: "Project",
  global: "Global",
  builtin: "Builtin",
};

const SCOPE_ORDER: SkillScope[] = ["project", "global", "builtin"];

// Issue #885 — a skill's own toggle UI (below) is gated on `kind === "skill"`
// rather than relying solely on `enabledByAgent` staying null for the other
// two kinds: agents/commands are discovery-only by design, not merely
// "nothing to toggle yet," so this is a structural gate, not a data-driven
// one — see skills.ts's own header for why no writer for either kind exists
// or is planned.
const KIND_LABEL: Record<SkillKind, string> = {
  skill: "Skill",
  agent: "Subagent",
  command: "Command",
};

const KIND_ORDER: Record<SkillKind, number> = { skill: 0, agent: 1, command: 2 };

const AGENT_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "opencode",
  agy: "agy",
};

// A dockview panel (opened from the CommandPalette's Integrations section,
// same pattern as GitPanel/AgentRulesPanel) showing every skill, subagent,
// and slash command discovered for a project — discovery (issue #432's
// slice 1, extended to the latter two kinds by issue #885) plus, for
// Codex/opencode SKILLS only, an enable/disable toggle (issue #463; see
// skills.ts's own header comment for why Claude Code/agy stay read-only this
// slice, and why subagents/commands stay read-only permanently —
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
        // Issue #885 — a remote agent host on a pre-#885 build serves
        // /internal/skills from its OWN old code and returns rows with no
        // `kind` at all (this project's TypeScript type says it's always
        // present, but that's not enforced across a version-skewed wire).
        // Normalized to "skill" here, once, rather than at every KIND_LABEL/
        // KIND_ORDER lookup below — matches every pre-#885 row's actual
        // behavior (a real skill) and fails closed for the toggle gate
        // (`selected.kind === "skill"` still renders it toggleable, correct
        // for what an old build actually is).
        setSkills(result.map((s) => ({ ...s, kind: s.kind ?? "skill" })));
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
      // Issue #885 — skills first, then subagents, then commands, within
      // each scope group; alphabetical within a kind.
      rows: byScope
        .get(scope)!
        .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name)),
    }));
  }, [skills]);

  const selected = skills?.find((s) => s.sourceDir === selectedDir) ?? null;

  if (skills === undefined) {
    if (loadError) {
      return (
        <EmptyStateNote>
          <div>Couldn't load skills.</div>
          <button className="git-panel-fetch-btn" onClick={() => void fetchSkills()}>
            Retry
          </button>
        </EmptyStateNote>
      );
    }
    return <EmptyStateNote>Loading…</EmptyStateNote>;
  }

  if (skills.length === 0) {
    return (
      <EmptyStateNote>
        <SkillIcon size={20} />
        <div>No skills, subagents, or slash commands found for this project or its host.</div>
      </EmptyStateNote>
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
                  {KIND_LABEL[row.kind]} · {row.agents.map((a) => AGENT_LABEL[a] ?? a).join(", ")}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="agent-rules-panel-editor">
        {!selected ? (
          <EmptyStateNote>
            <SkillIcon size={20} />
            <div>Select a skill to view its details.</div>
          </EmptyStateNote>
        ) : (
          <>
            <div className="agent-rules-panel-editor-header">
              <div className="agent-rules-panel-editor-title">
                <SkillIcon size={14} />
                {selected.name}
                <span className="agent-rules-panel-row-meta">
                  {SCOPE_LABEL[selected.scope]} · {KIND_LABEL[selected.kind]} ·{" "}
                  {selected.agents.map((a) => AGENT_LABEL[a] ?? a).join(", ")}
                </span>
              </div>
            </div>
            <div className="agent-rules-panel-notice">{selected.description}</div>
            <div className="agent-rules-panel-row-meta">{selected.sourceDir}</div>
            {actionError && <div className="agent-rules-panel-notice error">{actionError}</div>}
            {
              // Issue #885 — gated on kind === "skill" structurally (not
              // just relying on enabledByAgent staying null for the other
              // two kinds): subagents/commands are discovery-only by
              // design, never write-eligible. Within a skill, only agents
              // whose enabledByAgent is a real boolean get a toggle — null
              // (claude-code/agy, an ambiguous name, or an unreadable
              // config) stays read-only, already covered by the agent list
              // in the title line above.
              selected.kind === "skill" &&
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
