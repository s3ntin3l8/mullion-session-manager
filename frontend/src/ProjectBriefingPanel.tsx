import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, LOCAL_HOST_ID } from "./api/index.js";
import { FileTextIcon } from "./ui/icons.js";
import { ConfirmButton } from "./ui/ConfirmButton.js";
import { EmptyStateNote } from "./ui/EmptyState.js";
import { Toggle } from "./ui/primitives.js";
import { useDashboardStore } from "./store/index.js";

export interface ProjectBriefingPanelParams {
  projectId: number;
}

// Hermes review, PR #893 — kept in sync BY HAND with
// src/services/project-tooling.ts's MAX_PROJECT_TOOLING_FIELD_BYTES (which
// is itself kept in sync by hand with internal-schemas.ts's
// spawnSessionSchema projectSkill/projectReviewerAgent maxLength) — the
// frontend has no access to backend source, so this is a third copy of the
// same number, same posture as that file's own header comment. Only used
// here to show a live hint before Save — the backend's own check is still
// the actual enforcement. Shared by skill/reviewerAgent (PR-5); the pinned
// note has its own, much smaller cap — see MAX_BRIEFING_FIELD_BYTES below
// (issue #942).
const MAX_TOOLING_FIELD_BYTES = 8192;

// Issue #942 — kept in sync BY HAND with project-tooling.ts's
// MAX_PROJECT_BRIEFING_FIELD_BYTES. The pinned note is a short, live "pay
// attention to this" note, not a document, so it gets its own much smaller
// cap rather than sharing skill/reviewerAgent's 8192-byte one.
const MAX_BRIEFING_FIELD_BYTES = 512;

// PR-5 — a starting point for the reviewer-agent field, mirroring
// .claude/agents/mullion-reviewer.md's own shape with this repo's specific
// invariants stripped out (per the plan's PR-5 section: "ship a starter
// template ... the shape, with this repo's invariants stripped"). Not
// auto-inserted — the "Use starter template" button below only fills the
// textarea when it's still empty, so it never clobbers existing content.
const REVIEWER_AGENT_TEMPLATE = `---
name: my-project-reviewer
description: "Review a diff or PR in this project for correctness against this project's own domain invariants, not just general code quality."
tools: Read, Grep, Glob, Bash
model: inherit
---

You are reviewing a change in this project. Your job is to catch violations
of this project's own domain invariants — the kind of mistake that looks
reasonable in isolation but breaks an assumption another part of the
codebase depends on.

## What to check

1. (Replace this with your project's own invariants — the things a careful
   reviewer who knows this codebase would check that a generic reviewer
   wouldn't know to look for.)
2. General correctness and test coverage: does the diff do what it claims,
   are edge cases covered, do the new/changed tests actually exercise the
   changed behavior.

## How to report

For each finding: file, line if applicable, what's wrong, and — for
invariant violations specifically — which invariant it breaks and why that
matters. If you find nothing, say so plainly rather than manufacturing a
nitpick to seem thorough.
`;

const SKILL_TEMPLATE = `---
name: my-project-skill
description: "A short sentence describing what this skill does and when an agent should use it — this is what Claude Code shows in its skill list."
---

Describe what an agent following this skill should do. This body is only
loaded when the skill is actually invoked, so it can be as long as it needs
to be.
`;

// Issue #1082(b) — since #956 shipped agent-assisted scaffold generation (a
// real agent turn analyzing the actual codebase), free-text authoring here
// is now the lower-quality, manual-override path for skill/reviewer content,
// not the primary one. Shown above both fields' own `notice` below, not
// folded into it, so it reads as a distinct "try this first" pointer rather
// than one more sentence in the field's own description. Deliberately not
// shown for the pinned note — that field has no Scaffold Mullion equivalent
// at all (a live note, not a repo-committable artifact).
const SCAFFOLD_RECOMMENDATION_NOTICE =
  "Recommended: use Scaffold Mullion (Command Palette → “Scaffold Mullion: <project>”) " +
  "to generate this from your actual codebase — a real agent turn analyzing this project " +
  "produces higher-quality, project-specific content than a blank text box. Edit the field " +
  "below directly only if you need a manual override.";

// Issue #895 — Scaffold Mullion is local-host projects only (a remote
// project's scaffold request 501s, not silently no-ops), so the above
// recommendation is dead advice for a remote-hosted project: there's
// nothing to click. Shown instead of SCAFFOLD_RECOMMENDATION_NOTICE
// whenever `isRemoteProject` is true.
const SCAFFOLD_RECOMMENDATION_NOTICE_REMOTE =
  "Scaffold Mullion only supports local-host projects today (issue #895) — this project is " +
  "remote-hosted, so the field below is the only way to author this content for now.";

// Issue #1083 — codex and agy have no ephemeral per-session channel at all
// (see docs/project-briefing.md's delivery table), so the project skill
// only ever reaches them via Scaffold Mullion's committed
// `.agents/skills/<slug>` mirror. Saving this field here changes only what
// Claude Code/opencode see live; it does not touch that committed file, so
// once a project has been scaffolded this field can silently drift out of
// sync with what codex/agy actually read until the scaffold is re-run.
const SKILL_SCAFFOLD_STALENESS_NOTICE =
  "codex and agy never read this field live — the only path to them is Scaffold Mullion's " +
  "committed .agents/skills/<slug> mirror. If this project has already been scaffolded, " +
  "editing this field here won't change what codex/agy actually see until you re-scaffold.";

// Issue #1083 + #895 — for a remote-hosted project, "re-scaffold" isn't an
// available action at all (Scaffold Mullion is local-host only), so the
// local variant's call to action is misleading here: there's currently no
// way to deliver this field's content to codex/agy for this project, full
// stop, not just "not yet re-scaffolded."
const SKILL_SCAFFOLD_STALENESS_NOTICE_REMOTE =
  "codex and agy never read this field live, and Scaffold Mullion — the only path that " +
  "would reach them — only supports local-host projects (issue #895). For this " +
  "remote-hosted project, there's currently no way to deliver this content to codex/agy " +
  "at all.";

// Issue #1083 — unlike the skill, the reviewer has no committed mirror for
// codex/agy at all: Scaffold Mullion's reviewer file only ever lands at
// `.claude/agents/<slug>-reviewer.md`, a Claude-Code-only subagent location.
// Codex genuinely has no subagent concept at all (bundle-sync.ts's own
// comment: "Codex has no static per-agent file format at all," confirmed by
// spike #946 — it invokes a skill by name at runtime instead). agy DOES have
// one — a single flat `<name>.md` file under its host-global agents
// directory (`resolveAgyGlobalAgentsDir()`, spike #950) — but nothing routes
// a PROJECT's own reviewer content there today: bundle-sync.ts's
// AGENT_TARGETS only ever installs Mullion's own shipped bundle agent to
// that path, not a per-project one, and Scaffold Mullion's reviewer file
// (above) never targets it either. So the practical effect is the same for
// both CLIs today (this field never reaches either one), even though the
// underlying reason differs — codex structurally can't, agy currently has
// nothing wired to its otherwise-real subagent mechanism. No remote-project
// variant needed: this is already true independent of local vs. remote
// hosting.
const REVIEWER_SCAFFOLD_STALENESS_NOTICE =
  "codex has no subagent concept at all, and while agy does, nothing routes a project's " +
  "own reviewer content to it — Scaffold Mullion's reviewer file only ever lands in a " +
  "Claude-Code-specific location. Either way, this field never reaches codex or agy, " +
  "scaffolded or not.";

type ToolingFieldKey = "briefing" | "skill" | "reviewerAgent";

interface ToolingFieldConfig {
  key: ToolingFieldKey;
  label: string;
  placeholder: string;
  notice: string;
  deleteConfirmTitle: string;
  template?: string;
  maxBytes: number;
  write: (projectId: number, value: string) => Promise<{ [k: string]: string | null }>;
  remove: (projectId: number) => Promise<void>;
  // Issue #1082(b)/#1083 — set for skill/reviewerAgent only (not the pinned
  // note, which has no Scaffold Mullion equivalent). Drives both the
  // "use Scaffold Mullion first" recommendation (always, once this is set)
  // and the codex/agy scaffold-staleness warning (once savedValue !== null)
  // rendered by ToolingFieldEditor below.
  scaffoldStalenessNotice?: string;
  // Remote-hosted-project variant of the above (issue #895) — falls back to
  // scaffoldStalenessNotice when unset (the reviewer's own notice is already
  // hosting-agnostic, so it doesn't need one).
  scaffoldStalenessNoticeRemote?: string;
}

const FIELD_CONFIGS: ToolingFieldConfig[] = [
  {
    key: "briefing",
    label: "Pinned note",
    placeholder: "No pinned note set for this project yet — start typing to create one.",
    notice:
      "A short, live note pushed at the start of every session, on top of whatever AGENTS.md " +
      "already says — it's never a substitute for AGENTS.md, and never competes with it. Delete " +
      "this to stop pushing a note at all.",
    deleteConfirmTitle: "Delete this project's pinned note? This can't be undone.",
    maxBytes: MAX_BRIEFING_FIELD_BYTES,
    write: (projectId, value) => api.writeProjectTooling(projectId, value),
    remove: (projectId) => api.deleteProjectTooling(projectId),
  },
  {
    key: "skill",
    label: "Skill",
    placeholder:
      "No project skill set yet — start typing (or use the starter template) to create one.",
    notice:
      "A project-specific Claude Code/opencode skill, composed into every session's tooling " +
      "alongside Mullion's own bundle (never written into this project's own repo). " +
      "Requires YAML frontmatter with name and description. codex and agy need a repo-level " +
      "skill file instead — see “Scaffold Mullion integration” for those two.",
    deleteConfirmTitle: "Delete this project's skill? This can't be undone.",
    template: SKILL_TEMPLATE,
    maxBytes: MAX_TOOLING_FIELD_BYTES,
    write: (projectId, value) => api.writeProjectSkill(projectId, value),
    remove: (projectId) => api.deleteProjectSkill(projectId),
    scaffoldStalenessNotice: SKILL_SCAFFOLD_STALENESS_NOTICE,
    scaffoldStalenessNoticeRemote: SKILL_SCAFFOLD_STALENESS_NOTICE_REMOTE,
  },
  {
    key: "reviewerAgent",
    label: "Reviewer agent",
    placeholder:
      "No project reviewer subagent set yet — start typing (or use the starter template) to create one.",
    notice:
      "A project-specific reviewer subagent, in the same shape as this session's own " +
      "mullion-reviewer.md. Composed into Claude Code's plugin bundle verbatim; translated " +
      "automatically for opencode (its own agent format can't carry the tools:/model: fields " +
      "here, so those are stripped for that one CLI only — the description and body still " +
      "apply everywhere). codex has no subagent concept at all; agy has one, but nothing " +
      "delivers this project-specific field to it today (see the notice below).",
    deleteConfirmTitle: "Delete this project's reviewer agent? This can't be undone.",
    template: REVIEWER_AGENT_TEMPLATE,
    maxBytes: MAX_TOOLING_FIELD_BYTES,
    write: (projectId, value) => api.writeProjectReviewerAgent(projectId, value),
    remove: (projectId) => api.deleteProjectReviewerAgent(projectId),
    scaffoldStalenessNotice: REVIEWER_SCAFFOLD_STALENESS_NOTICE,
  },
];

interface InjectOverrideRowProps {
  label: string;
  // The project's own override column value (null = inherit).
  value: boolean | null;
  globalValue: boolean;
  onChange: (value: boolean | null) => void;
}

// Issue #884 — reuses GitPanel.tsx's own toggle + "inherited" label + reset-
// to-default pattern verbatim (same CSS classes, same three-state shape:
// null = inherit the global setting, true/false = explicit per-project
// override) rather than inventing a new tri-state control for what's
// structurally the identical shape as that panel's own autoFetch override.
function InjectOverrideRow({ label, value, globalValue, onChange }: InjectOverrideRowProps) {
  const effective = value ?? globalValue;
  const isInherited = value === null;
  return (
    <span className="git-panel-toggle-wrapper">
      <Toggle size="small" on={effective} onChange={(next) => onChange(next)} ariaLabel={label} />
      {isInherited ? (
        <span className="git-panel-toggle-inherited" title="Inherited from the global setting">
          {label}
        </span>
      ) : (
        <>
          <span className="git-panel-toggle-label">{label}</span>
          <button
            className="git-panel-toggle-reset"
            onClick={() => onChange(null)}
            title="Reset to the global default"
          >
            ×
          </button>
        </>
      )}
    </span>
  );
}

interface FieldEditorProps {
  config: ToolingFieldConfig;
  projectId: number;
  savedValue: string | null;
  onSaved: (value: string | null) => void;
  onDeleted: () => void;
  // Lets the parent gate switching to another field while this one has
  // unsaved changes — same posture as AgentRulesPanel's own
  // `disabled={dirty && row.id !== selectedId}` on its target list.
  onDirtyChange: (dirty: boolean) => void;
  // Issue #895 — Scaffold Mullion is local-host projects only, so the
  // scaffold-recommendation/staleness copy below needs a different, still-
  // actionable message for a remote-hosted project rather than pointing at
  // an action that 501s.
  isRemoteProject: boolean;
}

// One field's editor — a textarea plus Save/Discard/Delete, shared by all
// three targets below. Each field is an independent DB column
// (project-tooling.ts's clearToolingColumn), so each instance owns its own
// draft/dirty/saving/deleting state entirely separately from its siblings.
function ToolingFieldEditor({
  config,
  projectId,
  savedValue,
  onSaved,
  onDeleted,
  onDirtyChange,
  isRemoteProject,
}: FieldEditorProps) {
  const [draft, setDraft] = useState(savedValue ?? "");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Same "read the LIVE draft after an in-flight await" reasoning as
  // AgentRulesPanel's own draftRef (Hermes review, PR #458).
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  // No effect syncing `draft` from `savedValue` here — the parent remounts
  // this whole component (`key={activeConfig.key}` at the call site) on
  // every field switch, so the `useState(savedValue ?? "")` initializer
  // above already handles "switched to a different field" correctly. The
  // only way `savedValue` changes while THIS instance stays mounted is via
  // its own handleSave/handleDelete below, which already update
  // draft/dirty locally at the same time — a prop-sync effect here would
  // just redundantly re-set state React already has.

  const draftByteLength = useMemo(() => new TextEncoder().encode(draft).length, [draft]);
  const overCap = draftByteLength > config.maxBytes;

  const handleDiscard = useCallback(() => {
    setDraft(savedValue ?? "");
    setDirty(false);
    setActionError(null);
  }, [savedValue]);

  const handleUseTemplate = useCallback(() => {
    if (!config.template) return;
    setDraft(config.template);
    setDirty(true);
    setActionError(null);
  }, [config.template]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setActionError(null);
    const savedContent = draft;
    try {
      const result = await config.write(projectId, savedContent);
      onSaved(result[config.key] ?? null);
      if (draftRef.current === savedContent) setDirty(false);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [config, draft, onSaved, projectId]);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    setActionError(null);
    const draftAtDeleteTime = draft;
    try {
      await config.remove(projectId);
      onDeleted();
      if (draftRef.current === draftAtDeleteTime) {
        setDraft("");
        setDirty(false);
      }
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Failed to delete");
    } finally {
      setDeleting(false);
    }
  }, [config, draft, onDeleted, projectId]);

  return (
    <div className="agent-rules-panel-editor">
      <div className="agent-rules-panel-editor-header">
        <div className="agent-rules-panel-editor-title">
          <FileTextIcon size={14} />
          {config.label}
        </div>
        <div className="agent-rules-panel-editor-actions">
          {config.template && draft.length === 0 && !dirty && (
            <button className="git-panel-fetch-btn" onClick={handleUseTemplate} disabled={saving}>
              Use starter template
            </button>
          )}
          {savedValue !== null &&
            (deleting || saving ? (
              <button className="git-panel-fetch-btn" disabled>
                {deleting ? "Deleting…" : "Delete"}
              </button>
            ) : (
              <ConfirmButton title={config.deleteConfirmTitle} onConfirm={handleDelete}>
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
            disabled={!dirty || saving || overCap}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      {config.scaffoldStalenessNotice && (
        <div className="agent-rules-panel-notice">
          {isRemoteProject ? SCAFFOLD_RECOMMENDATION_NOTICE_REMOTE : SCAFFOLD_RECOMMENDATION_NOTICE}
        </div>
      )}
      <div className="agent-rules-panel-notice">{config.notice}</div>
      {config.scaffoldStalenessNotice && savedValue !== null && (
        <div className="agent-rules-panel-notice warning">
          {isRemoteProject
            ? (config.scaffoldStalenessNoticeRemote ?? config.scaffoldStalenessNotice)
            : config.scaffoldStalenessNotice}
        </div>
      )}
      {actionError && <div className="agent-rules-panel-notice error">{actionError}</div>}
      <textarea
        className="agent-rules-panel-textarea"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setDirty(true);
        }}
        placeholder={config.placeholder}
        spellCheck={false}
      />
      <div className={`agent-rules-panel-row-meta${overCap ? " error" : ""}`}>
        {draftByteLength.toLocaleString()} / {config.maxBytes.toLocaleString()} bytes
        {overCap && " — over the limit, trim before saving"}
      </div>
    </div>
  );
}

// A dockview panel (opened from the CommandPalette's Integrations section,
// same "project-scoped panel kind" shape AgentRulesPanel/DockConfigPanel/
// SkillsPanel already use — see usePanelOpener.ts's ProjectPanelKindConfig)
// for authoring a project's DB-backed Mullion tooling
// (src/services/project-tooling.ts): a briefing, a project-specific skill,
// and a reviewer subagent, one project_tooling row with three independent
// columns. Reuses AgentRulesPanel's own two-pane target-list/editor shell
// (`.agent-rules-panel-list` + `.agent-rules-panel-row`) for the field
// switcher — each row here is a DB column instead of a file target, but the
// "pick one, edit it, Save/Discard/Delete gated on this one's own dirty
// state" shape is identical.
//
// Fetched once on open, never polled — same "these change rarely" precedent
// as AgentRulesPanel/GitPanel's own fetch-once posture.
export function ProjectBriefingPanel({ params }: { params: ProjectBriefingPanelParams }) {
  const [tooling, setTooling] = useState<
    { briefing: string | null; skill: string | null; reviewerAgent: string | null } | undefined
  >(undefined);
  const [loadError, setLoadError] = useState(false);
  const [activeField, setActiveField] = useState<ToolingFieldKey>("briefing");
  const [activeFieldDirty, setActiveFieldDirty] = useState(false);

  // Issue #884 — per-project override of the two global session-injection
  // settings. Read from the project list already in the store (same
  // "cheap enough to ride along" posture as every other project field —
  // no separate fetch needed) rather than `tooling`'s own
  // project_tooling-backed state, since these two live on the `projects`
  // table itself, not project_tooling.
  const project = useDashboardStore((s) => s.projects.find((p) => p.id === params.projectId));
  // Issue #895 — same "hostId !== LOCAL_HOST_ID" convention as
  // SourceControlSection.tsx's own isRemoteProject; undefined `project`
  // (not yet loaded into the store) defaults to false/local rather than
  // guessing remote.
  const isRemoteProject = project != null && project.hostId !== LOCAL_HOST_ID;
  const globalInjectAgentGuide = useDashboardStore((s) => s.settings.sessions.injectAgentGuide);
  const globalInjectProjectBriefing = useDashboardStore(
    (s) => s.settings.sessions.injectProjectBriefing,
  );
  const updateProject = useDashboardStore((s) => s.updateProject);

  const fetchTooling = useCallback(
    async (cancelledRef?: { current: boolean }) => {
      try {
        const result = await api.getProjectTooling(params.projectId);
        if (cancelledRef?.current) return;
        setTooling(result);
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
    void fetchTooling(cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
  }, [fetchTooling]);

  if (tooling === undefined) {
    if (loadError) {
      return (
        <EmptyStateNote>
          <div>Couldn't load this project's Mullion tooling.</div>
          <button className="git-panel-fetch-btn" onClick={() => void fetchTooling()}>
            Retry
          </button>
        </EmptyStateNote>
      );
    }
    return <EmptyStateNote>Loading…</EmptyStateNote>;
  }

  const activeConfig = FIELD_CONFIGS.find((c) => c.key === activeField) ?? FIELD_CONFIGS[0];

  return (
    <div className="agent-rules-panel-shell">
      <div className="agent-rules-panel-notice project-briefing-inject-overrides">
        <span>Session injection for this project:</span>
        <InjectOverrideRow
          label="Agent guide"
          value={project?.injectAgentGuide ?? null}
          globalValue={globalInjectAgentGuide}
          onChange={(value) => void updateProject(params.projectId, { injectAgentGuide: value })}
        />
        <InjectOverrideRow
          label="Project briefing"
          value={project?.injectProjectBriefing ?? null}
          globalValue={globalInjectProjectBriefing}
          onChange={(value) =>
            void updateProject(params.projectId, { injectProjectBriefing: value })
          }
        />
        <InjectOverrideRow
          label="Workflow conventions"
          value={project?.injectWorkflowConventions ?? null}
          // Issue #937 — unlike the two rows above, there's no matching
          // GLOBAL boolean setting to read here (the global tier is the
          // TEXT itself, Settings -> Sessions' "Workflow conventions"
          // field) — `null` always inherits `true` (inject), so this is a
          // fixed constant, not a store read.
          globalValue={true}
          onChange={(value) =>
            void updateProject(params.projectId, { injectWorkflowConventions: value })
          }
        />
      </div>
      <div className="agent-rules-panel">
        <div className="agent-rules-panel-list cmux-scroll">
          {FIELD_CONFIGS.map((config) => (
            <button
              key={config.key}
              className={`agent-rules-panel-row${activeField === config.key ? " selected" : ""}`}
              onClick={() => setActiveField(config.key)}
              disabled={activeFieldDirty && config.key !== activeField}
              title={
                activeFieldDirty && config.key !== activeField
                  ? "Save or discard your changes first"
                  : undefined
              }
            >
              <span
                className={`github-panel-ci-dot ${tooling[config.key] !== null ? "good" : "none"}`}
              />
              <span className="agent-rules-panel-row-name">{config.label}</span>
              <span className="agent-rules-panel-row-meta">
                {tooling[config.key] !== null ? "set" : "not set"}
              </span>
            </button>
          ))}
        </div>
        <ToolingFieldEditor
          key={activeConfig.key}
          config={activeConfig}
          projectId={params.projectId}
          savedValue={tooling[activeConfig.key]}
          onSaved={(value) =>
            setTooling((prev) => (prev ? { ...prev, [activeConfig.key]: value } : prev))
          }
          onDeleted={() =>
            setTooling((prev) => (prev ? { ...prev, [activeConfig.key]: null } : prev))
          }
          onDirtyChange={setActiveFieldDirty}
          isRemoteProject={isRemoteProject}
        />
      </div>
    </div>
  );
}
