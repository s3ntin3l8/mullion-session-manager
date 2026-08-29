import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api/index.js";
import { FileTextIcon } from "./ui/icons.js";
import { ConfirmButton } from "./ui/ConfirmButton.js";
import { EmptyStateNote } from "./ui/EmptyState.js";

export interface ProjectBriefingPanelParams {
  projectId: number;
}

// A dockview panel (opened from the CommandPalette's Integrations section,
// same "project-scoped panel kind" shape AgentRulesPanel/DockConfigPanel/
// SkillsPanel already use — see usePanelOpener.ts's ProjectPanelKindConfig)
// for authoring a project's DB-backed Mullion briefing
// (src/services/project-tooling.ts). Unlike AgentRulesPanel, there's no
// target list here — this is one DB row, one textarea. `briefing === null`
// means the project has no DB-authored briefing yet, the ordinary case; the
// project may still have its own committed AGENTS.md/CLAUDE.md briefing
// region on disk, which this row — once saved — takes precedence over (see
// project-tooling.ts's own doc comment for why: the DB entry is the more
// recently and deliberately authored artifact).
//
// Fetched once on open, never polled — same "these change rarely" precedent
// as AgentRulesPanel/GitPanel's own fetch-once posture.
export function ProjectBriefingPanel({ params }: { params: ProjectBriefingPanelParams }) {
  const [briefing, setBriefing] = useState<string | null | undefined>(undefined);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Same "read the LIVE draft after an in-flight await" reasoning as
  // AgentRulesPanel's own draftRef (Hermes review, PR #458) — a remote round
  // trip can take long enough for more keystrokes to land before it resolves.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const fetchBriefing = useCallback(
    async (cancelledRef?: { current: boolean }) => {
      try {
        const result = await api.getProjectTooling(params.projectId);
        if (cancelledRef?.current) return;
        setBriefing(result.briefing);
        setDraft(result.briefing ?? "");
        setDirty(false);
        setLoadError(false);
      } catch (err) {
        if (cancelledRef?.current) return;
        console.debug("[ProjectBriefingPanel] getProjectTooling failed", err);
        setLoadError(true);
      }
    },
    [params.projectId],
  );

  useEffect(() => {
    const cancelledRef = { current: false };
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchBriefing(cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
  }, [fetchBriefing]);

  const handleDiscard = useCallback(() => {
    setDraft(briefing ?? "");
    setDirty(false);
    setActionError(null);
  }, [briefing]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setActionError(null);
    const savedContent = draft;
    try {
      const result = await api.writeProjectTooling(params.projectId, savedContent);
      setBriefing(result.briefing);
      // Same "only clear dirty if the draft is still exactly what got
      // saved" guard as AgentRulesPanel's handleSave.
      if (draftRef.current === savedContent) setDirty(false);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [draft, params.projectId]);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    setActionError(null);
    const draftAtDeleteTime = draft;
    try {
      await api.deleteProjectTooling(params.projectId);
      setBriefing(null);
      if (draftRef.current === draftAtDeleteTime) {
        setDraft("");
        setDirty(false);
      }
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Failed to delete");
    } finally {
      setDeleting(false);
    }
  }, [draft, params.projectId]);

  if (briefing === undefined) {
    if (loadError) {
      return (
        <EmptyStateNote>
          <div>Couldn't load this project's briefing.</div>
          <button className="git-panel-fetch-btn" onClick={() => void fetchBriefing()}>
            Retry
          </button>
        </EmptyStateNote>
      );
    }
    return <EmptyStateNote>Loading…</EmptyStateNote>;
  }

  return (
    <div className="agent-rules-panel">
      <div className="agent-rules-panel-editor">
        <div className="agent-rules-panel-editor-header">
          <div className="agent-rules-panel-editor-title">
            <FileTextIcon size={14} />
            Mullion briefing
          </div>
          <div className="agent-rules-panel-editor-actions">
            {briefing !== null &&
              (deleting || saving ? (
                <button className="git-panel-fetch-btn" disabled>
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              ) : (
                <ConfirmButton
                  title="Delete this project's Mullion briefing? This restores any committed AGENTS.md/CLAUDE.md briefing region instead — it can't be undone."
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
              disabled={!dirty || saving}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
        <div className="agent-rules-panel-notice">
          Carried into every session's context at startup, taking precedence over any{" "}
          <code>&lt;!-- mullion:briefing:start --&gt;</code> region already committed in this
          project's own AGENTS.md or CLAUDE.md. Delete this to fall back to that committed region,
          if one exists.
        </div>
        {actionError && <div className="agent-rules-panel-notice error">{actionError}</div>}
        <textarea
          className="agent-rules-panel-textarea"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setDirty(true);
          }}
          placeholder="No Mullion briefing set for this project yet — start typing to create one."
          spellCheck={false}
        />
      </div>
    </div>
  );
}
