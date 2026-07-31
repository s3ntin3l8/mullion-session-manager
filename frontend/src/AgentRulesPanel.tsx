import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import type { AgentRuleTarget } from "./api.js";
import { FileTextIcon } from "./icons.js";

export interface AgentRulesPanelParams {
  projectId: number;
}

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  shadowed: "Shadowed",
};

const SCOPE_LABEL: Record<string, string> = {
  project: "Project",
  global: "Global",
};

function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// A dockview panel (opened from the CommandPalette's Integrations section,
// same pattern as GitPanel/GitHubPanel) showing every CLAUDE.md/AGENTS.md/
// AGENTS.override.md/GEMINI.md target for a project — one row per (agent,
// scope), grouped by agent. Deliberately a raw source editor, not a
// structured "toggle individual rules" UI: tessera reached the same
// conclusion (see the plan) — parsing `## Rules` sections into fields risks
// a lossy round-trip rewrite of a hand-authored, often git-tracked file.
// What genuinely adds value over editing the file directly is the
// precedence indicator (active vs. shadowed — e.g. Codex's
// AGENTS.override.md shadowing AGENTS.md), not a parsed-and-reserialized
// view.
//
// Fetched once on open, never polled — these files change rarely (same
// "fetch once" precedent as GitPanel's branches/worktrees list, which cites
// the same reasoning: unlike live git status, there's no tick-driven reason
// to keep re-fetching).
export function AgentRulesPanel({ params }: { params: AgentRulesPanelParams }) {
  const [targets, setTargets] = useState<AgentRuleTarget[] | undefined>(undefined);
  const [loadError, setLoadError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchTargets = useCallback(
    async (cancelledRef?: { current: boolean }) => {
      try {
        const result = await api.listAgentRules(params.projectId);
        if (cancelledRef?.current) return;
        setTargets(result);
        setLoadError(false);
      } catch (err) {
        if (cancelledRef?.current) return;
        // Same "don't clear what's already shown" posture as GitPanel's own
        // fetchStatus — a transient failure keeps the last-known-good list
        // rather than blanking the panel. Only surfaces as an error state
        // if this is the very first fetch (targets is still undefined).
        console.debug("[AgentRulesPanel] listAgentRules failed", err);
        setLoadError(true);
      }
    },
    [params.projectId],
  );

  useEffect(() => {
    const cancelledRef = { current: false };
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchTargets(cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
  }, [fetchTargets]);

  const grouped = useMemo(() => {
    if (!targets) return [];
    const byAgent = new Map<string, { label: string; rows: AgentRuleTarget[] }>();
    for (const t of targets) {
      const group = byAgent.get(t.agent) ?? { label: t.agentLabel, rows: [] };
      group.rows.push(t);
      byAgent.set(t.agent, group);
    }
    return [...byAgent.values()];
  }, [targets]);

  const selected = targets?.find((t) => t.id === selectedId) ?? null;

  const selectTarget = useCallback((target: AgentRuleTarget) => {
    setSelectedId(target.id);
    setDraft(target.content ?? "");
    setDirty(false);
    setActionError(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    setActionError(null);
    try {
      const updated =
        selected.scope === "project"
          ? await api.writeProjectAgentRule(params.projectId, selected.id, draft)
          : await api.writeGlobalAgentRule(selected.id, draft);
      setTargets((prev) => prev?.map((t) => (t.id === updated.id ? updated : t)));
      setDirty(false);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [selected, draft, params.projectId]);

  const handleDelete = useCallback(async () => {
    if (!selected) return;
    setDeleting(true);
    setActionError(null);
    try {
      if (selected.scope === "project") {
        await api.deleteProjectAgentRule(params.projectId, selected.id);
      } else {
        await api.deleteGlobalAgentRule(selected.id);
      }
      setTargets((prev) =>
        prev?.map((t) =>
          t.id === selected.id
            ? {
                ...t,
                exists: false,
                content: null,
                size: null,
                mtimeMs: null,
                status: null,
                truncated: false,
              }
            : t,
        ),
      );
      setDraft("");
      setDirty(false);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Failed to delete");
    } finally {
      setDeleting(false);
    }
  }, [selected, params.projectId]);

  if (targets === undefined) {
    if (loadError) {
      return <div className="github-panel-empty">Couldn't load agent rules — retrying…</div>;
    }
    return <div className="github-panel-empty">Loading…</div>;
  }

  return (
    <div className="agent-rules-panel">
      <div className="agent-rules-panel-list cmux-scroll">
        {grouped.map((group) => (
          <div key={group.label} className="github-panel-section">
            <div className="github-panel-section-title">{group.label}</div>
            {group.rows.map((row) => (
              <button
                key={row.id}
                className={`agent-rules-panel-row${row.id === selectedId ? " selected" : ""}`}
                onClick={() => selectTarget(row)}
              >
                <span
                  className={`github-panel-ci-dot ${row.exists ? (row.status === "shadowed" ? "pending" : "good") : "none"}`}
                />
                <span className="agent-rules-panel-row-name">{row.fileName}</span>
                <span className="agent-rules-panel-row-meta">
                  {SCOPE_LABEL[row.scope]}
                  {row.exists && row.status && ` · ${STATUS_LABEL[row.status]}`}
                  {row.exists && row.size !== null && ` · ${formatSize(row.size)}`}
                  {!row.exists && " · not present"}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="agent-rules-panel-editor">
        {!selected ? (
          <div className="github-panel-empty">
            <FileTextIcon size={20} />
            <div>Select a file to view or edit it.</div>
          </div>
        ) : (
          <>
            <div className="agent-rules-panel-editor-header">
              <div className="agent-rules-panel-editor-title">
                <FileTextIcon size={14} />
                {selected.fileName}
                <span className="agent-rules-panel-row-meta">
                  {selected.agentLabel} · {SCOPE_LABEL[selected.scope]}
                </span>
              </div>
              <div className="agent-rules-panel-editor-actions">
                {selected.exists && (
                  <button
                    className="git-panel-fetch-btn"
                    onClick={handleDelete}
                    disabled={deleting || saving}
                  >
                    {deleting ? "Deleting…" : "Delete"}
                  </button>
                )}
                <button
                  className="git-panel-fetch-btn"
                  onClick={handleSave}
                  disabled={!dirty || saving || selected.truncated}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
            {selected.status === "shadowed" && (
              <div className="agent-rules-panel-notice">
                Shadowed — a higher-precedence file for {selected.agentLabel} already wins, so this
                one isn't currently read.
              </div>
            )}
            {actionError && <div className="agent-rules-panel-notice error">{actionError}</div>}
            {selected.truncated ? (
              <div className="github-panel-empty">
                This file is over the 512 KB edit limit ({formatSize(selected.size)}) — too large to
                edit here.
              </div>
            ) : (
              <textarea
                className="agent-rules-panel-textarea"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setDirty(true);
                }}
                placeholder={
                  selected.exists
                    ? ""
                    : `${selected.fileName} doesn't exist yet — start typing to create it.`
                }
                spellCheck={false}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
