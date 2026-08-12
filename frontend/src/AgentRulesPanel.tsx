import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api.js";
import type { AgentRuleTarget } from "./api.js";
import { FileTextIcon } from "./icons.js";
import { ConfirmButton } from "./ConfirmButton.js";
import { EmptyStateNote } from "./ui/EmptyState.js";

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
  // Hermes review, PR #458 — handleSave needs the LIVE draft value after its
  // await, not the one closed over at call time, to tell whether the user
  // kept typing during the round trip. A ref is the standard way to read
  // "current" state inside an already-in-flight async callback.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

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

  // Hermes review, PR #458 — switching targets used to discard an unsaved
  // draft with no warning at all. Rows for every OTHER target are disabled
  // while dirty (see the row `disabled` prop below), so a switch attempt is
  // simply blocked rather than silently losing the edit; handleDiscard
  // below is the explicit way out.
  const selectTarget = useCallback((target: AgentRuleTarget) => {
    setSelectedId(target.id);
    setDraft(target.content ?? "");
    setDirty(false);
    setActionError(null);
  }, []);

  const handleDiscard = useCallback(() => {
    if (!selected) return;
    setDraft(selected.content ?? "");
    setDirty(false);
    setActionError(null);
  }, [selected]);

  // Hermes review, PR #458 — a save/delete used to patch only the ONE
  // touched target's client-side state. That leaves a sibling target's
  // shadow status stale: creating/deleting Codex's AGENTS.override.md
  // changes whether the sibling AGENTS.md row is "active" or "shadowed",
  // but that row was never re-derived. Refetching the whole list after a
  // successful write/delete is the simple, correct fix — recomputing
  // shadowing relationships client-side would need to duplicate
  // agent-rules.ts's own precedence logic and risks drifting from it.
  //
  // Also (same review round): a global-scope target used to route through a
  // standalone, primary-host-only endpoint, so a remote-hosted project's
  // global CLAUDE.md/AGENTS.md silently saved to the *primary's* filesystem
  // instead of that project's own host. Both scopes now go through the
  // project-scoped route either way, which the backend routes to
  // project.hostId (see routes/agent-rules.ts's own file header).
  const handleSave = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    setActionError(null);
    const savedContent = draft;
    try {
      await api.writeProjectAgentRule(params.projectId, selected.id, savedContent);
      await fetchTargets();
      // Hermes review, PR #458 — only clear dirty if the draft is still
      // exactly what got saved; a remote-hosted project's round trip can
      // take seconds, long enough for more keystrokes to land, and those
      // shouldn't get silently marked "saved" when they weren't.
      if (draftRef.current === savedContent) setDirty(false);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [selected, draft, params.projectId, fetchTargets]);

  const handleDelete = useCallback(async () => {
    if (!selected) return;
    setDeleting(true);
    setActionError(null);
    const draftAtDeleteTime = draft;
    try {
      await api.deleteProjectAgentRule(params.projectId, selected.id);
      await fetchTargets();
      // Hermes review, PR #458 (round 6) — same draftRef guard handleSave
      // has: if the user kept typing during the delete's round trip, don't
      // silently wipe it just because the underlying file is now gone.
      if (draftRef.current === draftAtDeleteTime) {
        setDraft("");
        setDirty(false);
      }
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Failed to delete");
    } finally {
      setDeleting(false);
    }
  }, [selected, draft, params.projectId, fetchTargets]);

  if (targets === undefined) {
    if (loadError) {
      // Hermes review, PR #458 — "retrying…" previously implied an
      // automatic retry that didn't exist (fetchTargets only ever runs
      // once, on mount). A manual retry button is both more honest and
      // more useful than just rewording the copy.
      return (
        <EmptyStateNote>
          <div>Couldn't load agent rules.</div>
          <button className="git-panel-fetch-btn" onClick={() => void fetchTargets()}>
            Retry
          </button>
        </EmptyStateNote>
      );
    }
    return <EmptyStateNote>Loading…</EmptyStateNote>;
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
                disabled={dirty && row.id !== selectedId}
                title={
                  dirty && row.id !== selectedId ? "Save or discard your changes first" : undefined
                }
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
          <EmptyStateNote>
            <FileTextIcon size={20} />
            <div>Select a file to view or edit it.</div>
          </EmptyStateNote>
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
                {selected.exists &&
                  (deleting || saving ? (
                    <button className="git-panel-fetch-btn" disabled>
                      {deleting ? "Deleting…" : "Delete"}
                    </button>
                  ) : (
                    // Hermes review, PR #458 — a plain click used to delete
                    // a hand-authored, often git-tracked file with no
                    // confirmation at all. ConfirmButton is this repo's own
                    // in-app "click again to confirm" pattern (see its own
                    // header comment for why not window.confirm()).
                    <ConfirmButton
                      title={`Delete ${selected.fileName}? This can't be undone.`}
                      onConfirm={handleDelete}
                    >
                      Delete
                    </ConfirmButton>
                  ))}
                {dirty && (
                  <button className="git-panel-fetch-btn" onClick={handleDiscard} disabled={saving}>
                    Discard
                  </button>
                )}
                <button
                  className="git-panel-fetch-btn"
                  onClick={handleSave}
                  disabled={!dirty || saving || selected.truncated || selected.isSymlink}
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
            {
              // Hermes review, PR #458 — statTarget's stat() follows a
              // symlink to show its real content, but writeAgentRule
              // refuses to save through one (AgentRuleSymlinkError) —
              // read-only here instead of offering an edit whose Save is
              // guaranteed to 400.
              selected.isSymlink && (
                <div className="agent-rules-panel-notice">
                  {selected.fileName} is a symlink — shown read-only, since saving through it is
                  refused.
                </div>
              )
            }
            {selected.truncated ? (
              <EmptyStateNote>
                This file is over the 512 KB edit limit ({formatSize(selected.size)}) — too large to
                edit here.
              </EmptyStateNote>
            ) : (
              <textarea
                className="agent-rules-panel-textarea"
                value={draft}
                readOnly={selected.isSymlink}
                onChange={(e) => {
                  if (selected.isSymlink) return;
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
