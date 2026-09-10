import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api/index.js";
import { parseUnifiedDiff } from "./diffUtils.js";
import { EmptyStateNote } from "./ui/EmptyState.js";
import { FileTextIcon } from "./ui/icons.js";
import { useDashboardStore } from "./store/index.js";

export interface ProjectSetupPanelParams {
  projectId: number;
}

interface PreviewState {
  previewId: string;
  diff: string;
  files: string[];
  // Issue #1201 — true when the target repo already has its own
  // AGENTS.override.md. computeScaffold never writes to that path (codex
  // reads it INSTEAD OF AGENTS.md), so the committed Workflow Conventions
  // this scaffold writes into AGENTS.md would never reach codex sessions
  // for this specific project — surfaced here so that's a decision the
  // user makes with the fact in front of them, not a silent gap.
  hasAgentsOverride: boolean;
}

interface ApplyResult {
  ok: boolean;
  mode?: "pull-request" | "local-branch";
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  detail?: string;
}

// Phase 3 (drift detection, issue #1205, follow-up to #1201) — shown at the top of the
// initial form, before Preview is even clicked, so the signal is visible
// the moment the user opens this panel on a drifted project. Kept as its
// own small component rather than inlined so the copy has one definition.
function ConventionsDriftBanner() {
  return (
    <div className="agent-rules-panel-notice warning">
      This install's own workflow conventions have changed since this project was last scaffolded —
      re-run Preview and Apply below to update the committed text.
    </div>
  );
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
  // Issue #1201 — same install-wide text every session already gets
  // injected from (settings.sessions.workflowConventionsText, Settings ->
  // Sessions), read here purely for disclosure: computeScaffold on the
  // backend resolves and commits the SAME text server-side (project-setup.ts's
  // own /setup/preview and /setup/generate handlers) — this is not a
  // second source of truth, just showing the user what's about to be
  // committed before they see the diff.
  const workflowConventionsText = useDashboardStore(
    (s) => s.settings.sessions.workflowConventionsText,
  );
  // Hermes review, PR #1200 round 2 — the disclosure above used to read
  // ONLY the install-wide text, ignoring this project's own
  // injectWorkflowConventions opt-out, which resolveScaffoldWorkflowConventionsText
  // (project-setup.ts) already gates the SERVER-side resolution on. For an
  // opted-out project the server falls back to the fixed defaults
  // regardless of this text, but the disclosure kept claiming "the same
  // text already injected into every session on this project" — false on
  // both counts for exactly that project. Same store-read pattern
  // ProjectBriefingPanel.tsx uses for the identical column, and the same
  // `?? true` default resolveScaffoldWorkflowConventionsText applies.
  const project = useDashboardStore((s) => s.projects.find((p) => p.id === params.projectId));
  const injectWorkflowConventions = project?.injectWorkflowConventions ?? true;
  const refreshProjects = useDashboardStore((s) => s.refreshProjects);
  const updateProject = useDashboardStore((s) => s.updateProject);
  // Hermes review, PR #1200 round 3 (suggestion) — the disclosure used to
  // hand-copy a prose paraphrase of mullion-scaffold.ts's
  // SCAFFOLD_DEFAULT_WORKFLOW_ANSWERS ("always branch + PR, Conventional
  // Commits titles, squash merge, ..."), which a later edit to that answer
  // set could silently drift out of sync with. Fetched once here instead,
  // from the same source (GET /api/workflow-conventions/scaffold-defaults,
  // itself just buildWorkflowConventionsText(SCAFFOLD_DEFAULT_WORKFLOW_ANSWERS))
  // — `null` while loading or on fetch failure, in which case the
  // disclosure below falls back to naming the defaults without quoting
  // them verbatim, rather than blocking the panel on this fetch.
  const [scaffoldDefaultsText, setScaffoldDefaultsText] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api
      .getScaffoldDefaultConventionsText()
      .then((result) => {
        if (!cancelled) setScaffoldDefaultsText(result.text);
      })
      .catch(() => {
        // Disclosure-only fetch — a failure here degrades to the
        // no-verbatim-text fallback below, never an error banner.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [slug, setSlug] = useState("");
  const [includeContributingPointer, setIncludeContributingPointer] = useState(false);
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
      const result = await api.previewProjectSetup(params.projectId, {
        slug,
        includeContributingPointer,
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
  }, [params.projectId, slug, includeContributingPointer, symlinkAgentsSkills, includeDockConfig]);

  const handleApply = useCallback(async () => {
    if (!preview) return;
    setApplying(true);
    setError(null);
    try {
      const result = await api.applyProjectSetup(params.projectId, preview.previewId);
      setApplyResult(result);
      setPreview(null);
      // Hermes review, PR #1206 round 2 — apply just changed this project's
      // conventionsHash server-side, which flips project.conventionsDrifted
      // too. Without this, the store's stale copy could keep the drift
      // banner showing through "Scaffold another" until the next
      // unrelated /api/projects poll happened to land. Same fire-and-forget
      // pattern as createProject/updateProject above (projects.ts slice) —
      // apply already succeeded, so a refresh failure here must not surface
      // as an apply error.
      void refreshProjects().catch(() => {});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to apply");
    } finally {
      setApplying(false);
    }
  }, [params.projectId, preview, refreshProjects]);

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
        {/* Issue #1208, the properly-scoped follow-up to PR #1206 round 1's
            reverted checkbox: THAT checkbox flipped injectWorkflowConventions,
            which also controls what text gets resolved/hashed (see this
            column's own doc comment, schema.ts) — flipping it here would
            have permanently false-positived the drift badge and made the
            banner's own "re-run Preview and Apply" advice silently
            overwrite the just-committed real text with the generic
            defaults on the next apply. This one PATCHes a column that
            touches only session-lifecycle.ts's injection gate — drift
            tracking (conventionsDrifted, above) is UNAFFECTED and keeps
            working exactly as before, which the copy below says
            explicitly. Only shown when there is install-wide text to
            suppress in the first place (an opted-out or empty-text project
            just committed the generic defaults, and the spawn gate
            wouldn't have injected anything for it anyway). */}
        {workflowConventionsText.length > 0 && injectWorkflowConventions && (
          <div className="settings-row">
            <div className="settings-row-text">
              <label className="settings-row-label" htmlFor="setup-suppress-injection">
                Skip per-session injection
              </label>
              <div className="settings-row-desc">
                This project's <code>AGENTS.md</code> now carries the same conventions text. Mullion
                keeps checking it against your install's conventions and will still flag it if they
                drift — this only stops delivering it a second way at session start.
              </div>
            </div>
            <div className="settings-row-control">
              <input
                id="setup-suppress-injection"
                type="checkbox"
                checked={project?.suppressConventionsInjectionAfterScaffold ?? false}
                onChange={(e) =>
                  void updateProject(params.projectId, {
                    suppressConventionsInjectionAfterScaffold: e.target.checked,
                  })
                }
              />
            </div>
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
        {preview.hasAgentsOverride && (
          <div className="agent-rules-panel-notice warning">
            This repo already has its own <code>AGENTS.override.md</code> — codex reads that file
            INSTEAD OF AGENTS.md, so the Workflow Conventions section this scaffold just committed
            into AGENTS.md will never reach codex sessions on this project. Nothing here writes to
            AGENTS.override.md; if codex needs to see these conventions, add them there by hand.
          </div>
        )}
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

  // A single <details> disclosure, referenced from both the opted-out and
  // no-conventions-configured branches below, so there is exactly one
  // place rendering the fetched text — never two copies that could show
  // different things while `scaffoldDefaultsText` is still loading in one
  // but not the other (impossible in practice, since both read the same
  // state, but keeping it to one definition removes even that question).
  const scaffoldDefaultsDisclosure = scaffoldDefaultsText !== null && (
    <details style={{ display: "inline" }}>
      <summary style={{ display: "inline", cursor: "pointer" }}>(see the exact defaults)</summary>
      <pre className="session-file-change-diff" style={{ whiteSpace: "pre-wrap" }}>
        {scaffoldDefaultsText}
      </pre>
    </details>
  );

  return (
    <div className="agent-rules-panel-editor" style={{ padding: "12px 14px" }}>
      <div className="agent-rules-panel-editor-title">
        <FileTextIcon size={14} />
        Scaffold Mullion integration
      </div>
      {project?.conventionsDrifted && <ConventionsDriftBanner />}
      <div className="agent-rules-panel-notice">
        Commits an AGENTS.md briefing region, a CLAUDE.md @AGENTS.md import (Claude Code doesn't
        read AGENTS.md on its own — the import is what puts it in context), a starter project skill,
        and a starter reviewer subagent into this project's own repo, and opens a pull request — for
        codex and agy, which need a repo-level skill file rather than Mullion's per-project
        skill/reviewer settings (see the Mullion Briefing panel).
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
          <label className="settings-row-label" htmlFor="setup-contributing-pointer">
            Add a CONTRIBUTING.md pointer
          </label>
          <div className="settings-row-desc">
            Upserts a short pointer to AGENTS.md's Workflow Conventions section — creates
            CONTRIBUTING.md if this project doesn't have one yet, or upserts into it without
            touching anything else already there.
          </div>
        </div>
        <div className="settings-row-control">
          <input
            id="setup-contributing-pointer"
            type="checkbox"
            checked={includeContributingPointer}
            onChange={(e) => setIncludeContributingPointer(e.target.checked)}
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
      <div className="settings-row">
        <div className="settings-row-text">
          <label className="settings-row-label">Workflow Conventions to commit</label>
          <div className="settings-row-desc">
            {!injectWorkflowConventions ? (
              <>
                This project has opted out of workflow-conventions injection (Session injection for
                this project → Workflow conventions, in the Mullion Briefing panel), so this will
                commit Mullion's own built-in defaults{scaffoldDefaultsDisclosure} regardless of
                anything configured in Settings → Sessions.
              </>
            ) : workflowConventionsText.length > 0 ? (
              <>
                This install's own conventions, from Settings → Sessions — the same text already
                injected into every session on this project.
              </>
            ) : (
              <>
                No conventions configured yet in Settings → Sessions, so this will commit Mullion's
                own built-in defaults{scaffoldDefaultsDisclosure} — configure your own there first
                if these aren't right for this project.
              </>
            )}
          </div>
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
