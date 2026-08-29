import { useCallback, useState } from "react";
import { api, ApiError } from "./api/index.js";
import { parseUnifiedDiff } from "./diffUtils.js";
import { EmptyStateNote } from "./ui/EmptyState.js";
import { FileTextIcon } from "./ui/icons.js";

export interface ProjectSetupPanelParams {
  projectId: number;
}

interface PreviewState {
  previewId: string;
  diff: string;
  files: string[];
}

interface ApplyResult {
  ok: boolean;
  mode?: "pull-request" | "local-branch";
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  detail?: string;
}

// Issue: apply Mullion tooling to other repos, Layer 3 (PR-6) — a
// project-scoped panel (same "project-scoped panel kind" family as
// ProjectBriefingPanel/AgentRulesPanel — see usePanelOpener.ts's
// ProjectPanelKindConfig) for scaffolding a committed briefing region,
// project skill, and reviewer subagent into a repo via a real PR, using
// routes/project-setup.ts's preview-then-apply split. Unlike
// ProjectBriefingPanel (a DB row, no repo write at all), this ALWAYS
// writes real files into a real worktree and, when a GitHub remote and
// token are available, opens a real PR — so the UI never lets Apply fire
// without the user having seen the exact diff Preview produced first.
export function ProjectSetupPanel({ params }: { params: ProjectSetupPanelParams }) {
  const [slug, setSlug] = useState("");
  const [includeGemini, setIncludeGemini] = useState(false);
  const [includeOverride, setIncludeOverride] = useState(false);
  const [symlinkAgentsSkills, setSymlinkAgentsSkills] = useState(false);
  const [includeDockConfig, setIncludeDockConfig] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePreview = useCallback(async () => {
    setPreviewing(true);
    setError(null);
    setApplyResult(null);
    try {
      const mirrors: Array<"GEMINI.md" | "AGENTS.override.md"> = [
        ...(includeGemini ? (["GEMINI.md"] as const) : []),
        ...(includeOverride ? (["AGENTS.override.md"] as const) : []),
      ];
      const result = await api.previewProjectSetup(params.projectId, {
        slug,
        mirrors,
        symlinkAgentsSkills,
        includeDockConfig,
      });
      setPreview(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to preview");
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  }, [
    params.projectId,
    slug,
    includeGemini,
    includeOverride,
    symlinkAgentsSkills,
    includeDockConfig,
  ]);

  const handleApply = useCallback(async () => {
    if (!preview) return;
    setApplying(true);
    setError(null);
    try {
      const result = await api.applyProjectSetup(params.projectId, preview.previewId);
      setApplyResult(result);
      setPreview(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to apply");
    } finally {
      setApplying(false);
    }
  }, [params.projectId, preview]);

  const handleBack = useCallback(() => {
    setPreview(null);
    setApplyResult(null);
    setError(null);
  }, []);

  if (applyResult) {
    return (
      <div className="agent-rules-panel-editor" style={{ padding: "12px 14px" }}>
        <div className="agent-rules-panel-editor-title">
          <FileTextIcon size={14} />
          Mullion integration
        </div>
        {applyResult.mode === "pull-request" ? (
          <div className="agent-rules-panel-notice">
            Opened{" "}
            <a href={applyResult.prUrl} target="_blank" rel="noreferrer">
              PR #{applyResult.prNumber}
            </a>{" "}
            with the scaffolded files. Review and edit the placeholder sections before merging.
          </div>
        ) : (
          <div className="agent-rules-panel-notice">
            Committed to branch <code>{applyResult.branch}</code> — {applyResult.detail}
          </div>
        )}
        <button className="git-panel-fetch-btn" onClick={handleBack}>
          Scaffold another
        </button>
      </div>
    );
  }

  if (preview) {
    const diffLines = parseUnifiedDiff(preview.diff);
    return (
      <div className="agent-rules-panel-editor" style={{ padding: "12px 14px" }}>
        <div className="agent-rules-panel-editor-header">
          <div className="agent-rules-panel-editor-title">
            <FileTextIcon size={14} />
            Preview — {preview.files.length} file{preview.files.length === 1 ? "" : "s"}
          </div>
          <div className="agent-rules-panel-editor-actions">
            <button className="git-panel-fetch-btn" onClick={handleBack} disabled={applying}>
              Back
            </button>
            <button className="git-panel-fetch-btn" onClick={handleApply} disabled={applying}>
              {applying ? "Applying…" : "Apply"}
            </button>
          </div>
        </div>
        <div className="agent-rules-panel-notice">
          This opens a real pull request (or a local branch, if no GitHub remote/token is
          configured) — nothing is written until you click Apply.
        </div>
        {error && <div className="agent-rules-panel-notice error">{error}</div>}
        {diffLines.length === 0 ? (
          <EmptyStateNote>No changes to show.</EmptyStateNote>
        ) : (
          <div className="session-file-change-diff" style={{ maxHeight: "none" }}>
            {diffLines.map((line, i) => (
              <span key={i} className={`session-diff-line session-diff-${line.type}`}>
                {line.text}
                {"\n"}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="agent-rules-panel-editor" style={{ padding: "12px 14px" }}>
      <div className="agent-rules-panel-editor-title">
        <FileTextIcon size={14} />
        Scaffold Mullion integration
      </div>
      <div className="agent-rules-panel-notice">
        Commits an AGENTS.md briefing region, a starter project skill, and a starter reviewer
        subagent into this project's own repo, and opens a pull request — for codex and agy, which
        need a repo-level skill file rather than Mullion's per-project skill/reviewer settings (see
        the Mullion Briefing panel).
      </div>
      {error && <div className="agent-rules-panel-notice error">{error}</div>}
      <div className="settings-row">
        <div className="settings-row-text">
          <label className="settings-row-label" htmlFor="setup-slug">
            Slug
          </label>
          <div className="settings-row-desc">
            Names the scaffolded skill/reviewer files (e.g. <code>my-project</code>).
          </div>
        </div>
        <div className="settings-row-control">
          <input
            id="setup-slug"
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="my-project"
          />
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <label className="settings-row-label" htmlFor="setup-mirror-gemini">
            Mirror to GEMINI.md
          </label>
          <div className="settings-row-desc">Keeps a byte-identical briefing region for agy.</div>
        </div>
        <div className="settings-row-control">
          <input
            id="setup-mirror-gemini"
            type="checkbox"
            checked={includeGemini}
            onChange={(e) => setIncludeGemini(e.target.checked)}
          />
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <label className="settings-row-label" htmlFor="setup-mirror-override">
            Mirror to AGENTS.override.md
          </label>
          <div className="settings-row-desc">
            Only if this project already uses an AGENTS.override.md for Codex.
          </div>
        </div>
        <div className="settings-row-control">
          <input
            id="setup-mirror-override"
            type="checkbox"
            checked={includeOverride}
            onChange={(e) => setIncludeOverride(e.target.checked)}
          />
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <label className="settings-row-label" htmlFor="setup-symlink-agents-skills">
            Symlink .agents/skills
          </label>
          <div className="settings-row-desc">
            Default is a plain file copy — a symlink is a review-hostile diff and breaks on Windows
            checkouts without core.symlinks.
          </div>
        </div>
        <div className="settings-row-control">
          <input
            id="setup-symlink-agents-skills"
            type="checkbox"
            checked={symlinkAgentsSkills}
            onChange={(e) => setSymlinkAgentsSkills(e.target.checked)}
          />
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <label className="settings-row-label" htmlFor="setup-include-dock-config">
            Include an empty .crs/dock.json
          </label>
          <div className="settings-row-desc">
            A starting point for this project's own dock controls.
          </div>
        </div>
        <div className="settings-row-control">
          <input
            id="setup-include-dock-config"
            type="checkbox"
            checked={includeDockConfig}
            onChange={(e) => setIncludeDockConfig(e.target.checked)}
          />
        </div>
      </div>
      <button
        className="git-panel-fetch-btn"
        onClick={handlePreview}
        disabled={previewing || slug.trim().length === 0}
      >
        {previewing ? "Previewing…" : "Preview"}
      </button>
    </div>
  );
}
