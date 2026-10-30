import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, RateLimitedError } from "./api/index.js";
import type { ExistingInstructionsMode, ScaffoldConflict } from "./api/projects.js";
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
  // Only set by the agent-assisted path (/setup/generate). `sandboxed`
  // false means the host ran the turn without bwrap; `possiblyGeneric`
  // means the turn finished without evidence it actually read the repo.
  generated?: boolean;
  sandboxed?: boolean;
  possiblyGeneric?: boolean;
  // What the generation turn was asked to do with existing instructions, and
  // what came back: a conflicts list (report) or a lossy-rewrite signal
  // (restructure).
  instructionsMode?: ExistingInstructionsMode;
  conflicts?: ScaffoldConflict[];
  droppedConflictLines?: number;
  possiblyLossy?: boolean;
}

const INSTRUCTION_MODES: Array<{ id: ExistingInstructionsMode; label: string; desc: string }> = [
  {
    id: "keep",
    label: "Leave it",
    desc: "Mullion's section is added and everything else stays as written.",
  },
  {
    id: "report",
    label: "Tell me about conflicts",
    desc: "Nothing is rewritten. The agent lists passages that contradict or repeat the conventions, so you can fix them yourself.",
  },
  {
    id: "restructure",
    label: "Restructure it",
    desc: "The agent proposes a rewritten AGENTS.md: workflow rules that duplicate the conventions are dropped, repo facts move under “Repo specifics”, and procedural detail moves to CONTRIBUTING.md. You review it in the diff.",
  },
];

function ConflictList({ conflicts, dropped }: { conflicts: ScaffoldConflict[]; dropped: number }) {
  if (conflicts.length === 0) {
    return (
      <div className="agent-rules-panel-notice">
        No existing instructions conflict with the conventions.
      </div>
    );
  }
  return (
    <div className="agent-rules-panel-notice warning">
      {conflicts.length} passage{conflicts.length === 1 ? "" : "s"} outside Mullion&apos;s section
      contradict or repeat the conventions. They are NOT changed by this scaffold — fix them before
      merging, or agents will keep following them.
      <ul>
        {conflicts.map((c, i) => (
          <li key={i}>
            <code>{c.file}</code> — {c.kind}: “{c.excerpt}” — {c.note}
          </li>
        ))}
      </ul>
      {dropped > 0 && (
        <div>
          {dropped} more line{dropped === 1 ? "" : "s"} from the agent could not be read.
        </div>
      )}
    </div>
  );
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
  // Same resolution as the route's `project.defaultAgent ?? launchers.defaultAgent`.
  const launcherDefaultAgent = useDashboardStore((s) => s.settings.launchers?.defaultAgent);
  const defaultAgent = project?.defaultAgent ?? launcherDefaultAgent ?? "the default agent";
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
  const [generating, setGenerating] = useState(false);
  const [existingInstructions, setExistingInstructions] =
    useState<ExistingInstructionsMode>("keep");
  // Set after /setup/generate answered 409 (skill and reviewer already
  // exist): the user then picks which to regenerate and tries again.
  const [offerRefresh, setOfferRefresh] = useState(false);
  const [refreshSkill, setRefreshSkill] = useState(false);
  const [refreshReviewer, setRefreshReviewer] = useState(false);
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

  const generateInFlight = useRef(false);
  // A refresh choice belongs to the slug it was made for.
  const resetRefreshChoice = useCallback(() => {
    setOfferRefresh(false);
    setRefreshSkill(false);
    setRefreshReviewer(false);
  }, []);

  const handleGenerate = useCallback(async () => {
    // State alone can't stop two clicks in one tick; each call is a real,
    // costly agent turn.
    if (generateInFlight.current) return;
    generateInFlight.current = true;
    setGenerating(true);
    setError(null);
    setApplyResult(null);
    try {
      const refresh: Array<"skill" | "reviewer"> = [];
      if (refreshSkill) refresh.push("skill");
      if (refreshReviewer) refresh.push("reviewer");
      const result = await api.generateProjectSetup(params.projectId, {
        slug,
        includeContributingPointer,
        symlinkAgentsSkills,
        includeDockConfig,
        ...(refresh.length > 0 ? { refresh } : {}),
        ...(existingInstructions !== "keep" ? { existingInstructions } : {}),
      });
      setPreview({ ...result, generated: true, instructionsMode: existingInstructions });
      resetRefreshChoice();
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 409) {
        setOfferRefresh(true);
      } else if (err instanceof RateLimitedError) {
        setError(
          `Generation is rate limited — try again in about ${Math.max(1, Math.ceil(err.retryAfterMs / 60_000))} minute(s).`,
        );
      } else {
        setError(err instanceof ApiError ? err.message : "Failed to generate");
      }
      setPreview(null);
    } finally {
      generateInFlight.current = false;
      setGenerating(false);
    }
  }, [
    params.projectId,
    slug,
    includeContributingPointer,
    symlinkAgentsSkills,
    includeDockConfig,
    refreshSkill,
    refreshReviewer,
    resetRefreshChoice,
    existingInstructions,
  ]);

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
    resetRefreshChoice();
    setPreview(null);
    setApplyResult(null);
    setError(null);
  }, [resetRefreshChoice]);

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
        {preview.generated && preview.sandboxed === false && (
          <div className="agent-rules-panel-notice warning">
            The agent turn ran <strong>without a sandbox</strong> on this host (bwrap unavailable or
            disabled). Nothing it wrote outside the parsed output reaches this diff, but it could
            have touched the host&apos;s files.
          </div>
        )}
        {preview.generated && preview.possiblyGeneric && (
          <div className="agent-rules-panel-notice warning">
            The agent may not have read this repo — the generated skill and reviewer look generic.
            Review them carefully, or go back and generate again.
          </div>
        )}
        {preview.generated && preview.instructionsMode === "report" && (
          <ConflictList
            conflicts={preview.conflicts ?? []}
            dropped={preview.droppedConflictLines ?? 0}
          />
        )}
        {preview.generated && preview.instructionsMode === "restructure" && (
          <div className={`agent-rules-panel-notice${preview.possiblyLossy ? " warning" : ""}`}>
            {preview.possiblyLossy
              ? "The rewritten AGENTS.md is much shorter than the original, or most of its sections are gone. Read the diff for lost repo-specific detail before applying."
              : "AGENTS.md is restructured below. Check that nothing repo-specific was dropped before applying."}
          </div>
        )}
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
            onChange={(e) => {
              setSlug(e.target.value);
              resetRefreshChoice();
            }}
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
                anything configured in Settings → Agent context & skills.
              </>
            ) : workflowConventionsText.length > 0 ? (
              <>
                This install's own conventions, from Settings → Agent context & skills — the same
                text already injected into every session on this project.
              </>
            ) : (
              <>
                No conventions configured yet in Settings → Agent context & skills, so this will
                commit Mullion's own built-in defaults{scaffoldDefaultsDisclosure} — configure your
                own there first if these aren't right for this project.
              </>
            )}
          </div>
        </div>
      </div>
      {offerRefresh && (
        <div className="agent-rules-panel-notice warning">
          The skill and reviewer for this slug already exist, and generation never overwrites a file
          by default. Pick what to regenerate (this discards hand edits to it), then generate again.
          <div>
            <label>
              <input
                type="checkbox"
                checked={refreshSkill}
                onChange={(e) => setRefreshSkill(e.target.checked)}
              />{" "}
              Regenerate the skill
            </label>{" "}
            <label>
              <input
                type="checkbox"
                checked={refreshReviewer}
                onChange={(e) => setRefreshReviewer(e.target.checked)}
              />{" "}
              Regenerate the reviewer
            </label>
          </div>
        </div>
      )}
      <div className="settings-row">
        <div className="settings-row-text">
          <label className="settings-row-label">Instructions this repo already has</label>
          <div className="settings-row-desc">
            Only used by “Generate with agent”. If this repo already has its own workflow rules,
            they can contradict the conventions Mullion commits, and agents will follow whichever is
            in the file.
          </div>
        </div>
        <div className="settings-row-control" role="radiogroup" aria-label="Existing instructions">
          {INSTRUCTION_MODES.map((m) => (
            <label key={m.id} style={{ display: "block" }} title={m.desc}>
              <input
                type="radio"
                name="setup-existing-instructions"
                value={m.id}
                checked={existingInstructions === m.id}
                onChange={() => setExistingInstructions(m.id)}
              />{" "}
              {m.label}
            </label>
          ))}
          <div className="settings-row-desc">
            {INSTRUCTION_MODES.find((m) => m.id === existingInstructions)?.desc}
          </div>
        </div>
      </div>
      <div className="settings-row-desc">
        Preview writes starter placeholders. Generate runs your default agent ({defaultAgent}) in a
        read-only sandbox over this repo to write a skill and reviewer specific to it — this can
        take up to ~5 minutes.
      </div>
      <button
        className="git-panel-fetch-btn"
        onClick={handlePreview}
        disabled={previewing || generating || slug.trim().length === 0}
      >
        {previewing ? "Previewing…" : "Preview"}
      </button>{" "}
      <button
        className="git-panel-fetch-btn"
        onClick={handleGenerate}
        disabled={
          previewing ||
          generating ||
          slug.trim().length === 0 ||
          (offerRefresh && !refreshSkill && !refreshReviewer)
        }
      >
        {generating ? "Generating…" : "Generate with agent"}
      </button>
    </div>
  );
}
