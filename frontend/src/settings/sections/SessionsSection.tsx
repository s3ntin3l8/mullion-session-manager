import { Fragment, useState } from "react";
import { useDashboardStore } from "../../store/index.js";
import { resolveAgentLogo } from "../../cliLogos.js";
import { NumberField, Row, Toggle } from "../../ui/primitives.js";
import { clampNumberFieldOnCommit } from "../clamp.js";
import { BundleSyncPanel } from "../BundleSyncPanel.js";
import { WorkflowConventionsWizardModal } from "../WorkflowConventionsWizardModal.js";

export function SessionsSection() {
  const {
    settings,
    updateSettings,
    hideEndedSessions,
    setHideEndedSessions,
    showTaskSessions,
    setShowTaskSessions,
  } = useDashboardStore();
  const theme = useDashboardStore((s) => s.theme);
  const s = settings.sessions;
  const agentLogoUrl = resolveAgentLogo("claude", theme);
  const namePreviewParts = s.namePattern.split("{agent}");

  // Hermes review, PR #563 round 4 — every other Settings number field
  // PATCHes on every keystroke (400ms-debounced, see settingsMerge.ts), but
  // both of these two immediately trigger a REAL, destructive sweep on
  // arrival (routes/settings.ts calls app.reconfigureEventRetention()
  // unconditionally whenever either value changes, which runs the sweep
  // now, not just re-arms a future timer). Typing "50" as "5" then "0"
  // would PATCH an intermediate "5" the instant the debounce elapses,
  // permanently deleting all but the newest 5 events of every session
  // before "50" ever lands — before this fix, the smaller field was already
  // that dangerous at cap=1. Same onChange-draft/onCommit-PATCH split
  // TaskMasterSection's budget/throttle fields already use for their own
  // "0 is a real value, don't persist mid-edit" reason (Hermes review, PR
  // #480) — same clampNumberFieldOnCommit helper too.
  const [eventRetentionDaysDraft, setEventRetentionDaysDraft] = useState<number | null>(null);
  const [eventRetentionPerSessionDraft, setEventRetentionPerSessionDraft] = useState<number | null>(
    null,
  );

  // Issue #937 — the wizard is a one-shot "regenerate from scratch" action,
  // not a live-synced mode: it has no state of its own here beyond whether
  // its modal is open. Applying its result just calls updateSettings the
  // same way typing in the textarea below does.
  const [wizardOpen, setWizardOpen] = useState(false);

  return (
    <>
      <div style={{ padding: "6px 0 12px" }}>
        <div style={{ fontSize: 13.5, fontWeight: 500 }}>New-session name pattern</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3 }}>
          Tokens:{" "}
          <span style={{ fontFamily: "Geist Mono, monospace", color: "var(--c)" }}>
            {"{agent}"}
          </span>{" "}
          <span style={{ fontFamily: "Geist Mono, monospace", color: "var(--c)" }}>
            {"{project}"}
          </span>{" "}
          <span style={{ fontFamily: "Geist Mono, monospace", color: "var(--c)" }}>{"{n}"}</span>
        </div>
        <div className="settings-numberfield" style={{ marginTop: 11, width: "100%" }}>
          <input
            style={{ flex: 1, textAlign: "left", width: "auto" }}
            value={s.namePattern}
            onChange={(e) => updateSettings({ sessions: { namePattern: e.target.value } })}
          />
          <span
            className="settings-numberfield-suffix"
            style={{ display: "flex", alignItems: "center", gap: 4 }}
          >
            →{" "}
            {namePreviewParts.map((part, i) => (
              <Fragment key={i}>
                {i > 0 && (
                  <>
                    {agentLogoUrl && <img src={agentLogoUrl} alt="" width={14} height={14} />}
                    <span>Claude Code</span>
                  </>
                )}
                <span>{part.replaceAll("{project}", "mullion-hq").replaceAll("{n}", "1")}</span>
              </Fragment>
            ))}
          </span>
        </div>
      </div>

      <Row label="Confirm before kill" desc="Arm-then-confirm on the kill button.">
        <Toggle
          on={s.confirmBeforeKill}
          onChange={(v) => updateSettings({ sessions: { confirmBeforeKill: v } })}
        />
      </Row>
      <Row
        label="Show exited & killed sessions"
        desc="Keep dead sessions visible in the inventory."
      >
        <Toggle on={!hideEndedSessions} onChange={(v) => setHideEndedSessions(!v)} />
      </Row>
      <Row
        label="Show task sessions"
        desc="Keep Task Master's worker/review sessions visible in the sidebar, alongside your own. A killed one is hidden either way."
      >
        <Toggle on={showTaskSessions} onChange={setShowTaskSessions} />
      </Row>
      <Row label="Auto-reconcile interval" desc="How often exited sessions are swept.">
        <NumberField
          value={s.reconcileIntervalSeconds}
          min={5}
          max={3600}
          width={46}
          suffix="seconds"
          onChange={(v) => updateSettings({ sessions: { reconcileIntervalSeconds: v } })}
        />
      </Row>
      <Row
        label="Stale error timeout"
        desc="How long an unresolved API/tool error stays flagged before it's swept."
      >
        <NumberField
          value={s.staleErrorSeconds}
          min={30}
          max={86400}
          width={46}
          suffix="seconds"
          onChange={(v) => updateSettings({ sessions: { staleErrorSeconds: v } })}
        />
      </Row>
      <Row
        label="Stale busy timeout"
        desc="How long compacting/subagent activity stays flagged with no PTY output before it's swept — longer than the error timeout since these can legitimately run for a while."
      >
        <NumberField
          value={s.staleBusySeconds}
          min={30}
          max={86400}
          width={46}
          suffix="seconds"
          onChange={(v) => updateSettings({ sessions: { staleBusySeconds: v } })}
        />
      </Row>
      <Row
        label="Git auto-fetch interval"
        desc="How often to fetch origin for auto-fetch projects. 0 to disable."
      >
        <NumberField
          value={s.gitAutoFetchIntervalSeconds}
          min={0}
          max={3600}
          width={46}
          suffix="seconds"
          onChange={(v) => updateSettings({ sessions: { gitAutoFetchIntervalSeconds: v } })}
        />
      </Row>
      <Row
        label="Persist session event history"
        desc={
          "Record session notification events to disk so they survive a" +
          " restart (mullion history, GET /api/events). Off by default." +
          " Turning it on does not backfill — only events emitted from that" +
          " moment are captured, and only for sessions this server itself" +
          " spawned."
        }
      >
        <Toggle
          on={s.eventPersistence}
          onChange={(v) => updateSettings({ sessions: { eventPersistence: v } })}
        />
      </Row>
      <Row
        label="Event history retention"
        desc="Persisted events older than this are swept hourly — and once immediately when you change this value. 0 keeps them forever. Only meaningful while persistence is on — with it off, no new events accumulate to sweep."
      >
        <NumberField
          value={eventRetentionDaysDraft ?? s.eventRetentionDays}
          min={0}
          max={3650}
          width={46}
          suffix="days"
          onChange={setEventRetentionDaysDraft}
          onCommit={(v) => {
            setEventRetentionDaysDraft(null);
            updateSettings({
              sessions: { eventRetentionDays: clampNumberFieldOnCommit(v, 0, 3650) },
            });
          }}
        />
      </Row>
      <Row
        label="Event history cap per session"
        desc="Keeps only the newest N persisted events per session, swept hourly — and once immediately when you change this value — alongside the age-based retention above; the two limits apply independently. 0 keeps them all, regardless of count."
      >
        <NumberField
          value={eventRetentionPerSessionDraft ?? s.eventRetentionPerSession}
          min={0}
          max={100_000}
          width={70}
          suffix="events"
          onChange={setEventRetentionPerSessionDraft}
          onCommit={(v) => {
            setEventRetentionPerSessionDraft(null);
            updateSettings({
              sessions: { eventRetentionPerSession: clampNumberFieldOnCommit(v, 0, 100_000) },
            });
          }}
        />
      </Row>
      <Row
        label="Inject agent guide"
        desc={
          "On SessionStart, carry a short excerpt of the Mullion agent guide" +
          " (docs/agent-guide.md) — the control-socket scope model, browser" +
          " automation, and dock-control limits — into every session's own" +
          " context, plus a pointer to the full file. Reaches all four" +
          " agents (Claude Code, Codex, opencode, agy), just via different" +
          " mechanisms per agent."
        }
      >
        <Toggle
          on={s.injectAgentGuide}
          onChange={(v) => updateSettings({ sessions: { injectAgentGuide: v } })}
        />
      </Row>
      <Row
        label="Inject project briefing"
        desc={
          "On SessionStart, carry a project-authored block into every" +
          " session's starting context: a <!-- mullion:briefing:start -->" +
          " region in the project's AGENTS.md or CLAUDE.md, or a" +
          " .agents/briefing.md file. The extracted region is capped at 4 KB" +
          " (a short header and, if truncated, a truncation note add a" +
          " little on top). Projects with no such region are unaffected —" +
          " nothing is injected."
        }
      >
        <Toggle
          on={s.injectProjectBriefing}
          onChange={(v) => updateSettings({ sessions: { injectProjectBriefing: v } })}
        />
      </Row>
      <div style={{ padding: "12px 0" }}>
        <div style={{ fontSize: 13.5, fontWeight: 500 }}>Workflow conventions</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3, marginBottom: 8 }}>
          A single, install-wide "how we work" policy (branching, merge strategy, review process,
          ...), carried into every session's starting context via the same SessionStart mechanism as
          the agent guide/project briefing above — unless a project has opted out (see that
          project's own toggle in its briefing panel). A project's own AGENTS.md is always
          authoritative on top of this; this is a default, not an override.
        </div>
        <textarea
          className="agent-rules-panel-textarea"
          style={{ minHeight: 120 }}
          value={s.workflowConventionsText}
          placeholder="No workflow conventions configured yet — start typing, or generate a starting point with the wizard."
          spellCheck={false}
          onChange={(e) =>
            updateSettings({ sessions: { workflowConventionsText: e.target.value } })
          }
        />
        <div style={{ marginTop: 8 }}>
          <button className="git-panel-fetch-btn" onClick={() => setWizardOpen(true)}>
            Generate with wizard
          </button>
        </div>
      </div>
      {wizardOpen && (
        <WorkflowConventionsWizardModal
          onClose={() => setWizardOpen(false)}
          onApply={(text) => updateSettings({ sessions: { workflowConventionsText: text } })}
        />
      )}

      <Row
        label="Inject Mullion tooling bundle"
        desc={
          "Ship Mullion's own agent-facing skills and subagents into Claude" +
          " Code, Codex, opencode, and agy, in any project — not just this" +
          " repo's own checkout. A host-local sync installs them once," +
          " globally, into each tool's own skills/agents directory at" +
          " Mullion boot, and keeps them in sync across Mullion updates." +
          " Claude Code and opencode also get a per-session fallback" +
          " delivery mechanism, so those two keep working even between" +
          " syncs; Codex and agy have no such fallback and rely on the" +
          " global install alone. Turning this off" +
          " removes the global install on the next restart (Codex and agy" +
          " also remove their own copy immediately, on the next session" +
          " they launch). Not currently toggleable per-skill in the Skills" +
          " Manager below — this setting is the toggle. The status/re-sync/" +
          "remove panel just below reports on this without gating it — the" +
          " sync itself runs whether or not that panel is ever opened."
        }
      >
        <Toggle
          on={s.injectMullionBundle}
          onChange={(v) => updateSettings({ sessions: { injectMullionBundle: v } })}
        />
      </Row>
      <BundleSyncPanel />
      <Row
        label="Auto-open child session panels"
        desc={
          "When an agent spawns a child session (Phase 5, issue #193), open" +
          " its panel next to its parent's automatically. A spawned child" +
          " always shows in the sidebar regardless of this setting — it only" +
          " governs whether the panel itself opens with no user gesture."
        }
      >
        <Toggle
          on={s.autoOpenChildPanels}
          onChange={(v) => updateSettings({ sessions: { autoOpenChildPanels: v } })}
        />
      </Row>
      <Row
        label="Max child sessions per parent"
        desc="How many live child sessions an agent may have spawned at once before sessions.spawn_child starts rejecting new ones."
      >
        <NumberField
          value={s.maxChildSessionsPerParent}
          min={1}
          max={50}
          width={46}
          suffix="children"
          onChange={(v) => updateSettings({ sessions: { maxChildSessionsPerParent: v } })}
        />
      </Row>
    </>
  );
}
