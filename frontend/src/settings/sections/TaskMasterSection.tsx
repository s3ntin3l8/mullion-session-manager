import { useState } from "react";
import { useDashboardStore, FALLBACK_TASK_MASTER_ENV } from "../../store/index.js";
import { resolveTaskMaster } from "../../taskConfig.js";
import {
  Dropdown,
  Eyebrow,
  NumberField,
  Row,
  SecondaryButton,
  Toggle,
} from "../../ui/primitives.js";
import { clampNumberFieldOnCommit, clampTaskMasterFieldMax } from "../clamp.js";
import { AGENT_OPTIONS, REVIEW_AGENT_OPTIONS } from "../agentOptions.js";

// Task Master Settings UI follow-up — the first place settings.taskMaster
// is surfaced at all (it previously only had a backend/API surface, per
// docs/tasks.md's own "No dedicated Settings UI" limitation entry, which
// this section retires). Every control here writes and displays the
// *effective* (env-default-or-override) value — the -1/"inherit" sentinels
// settings.ts's taskMaster field uses are never shown to the user, per the
// plan's "sentinels are invisible in the UI" decision; Reset below is the
// only thing that ever writes a sentinel back.
export function TaskMasterSection() {
  const { settings, updateSettings, taskMasterEnv } = useDashboardStore();
  const tm = settings.taskMaster;
  const env = taskMasterEnv ?? FALLBACK_TASK_MASTER_ENV;
  const resolved = resolveTaskMaster(tm, env);

  // Local drafts for the two 0-is-a-real-value fields (budget, throttle) —
  // see the comment above the "Per-task budget" row. `onChange` only updates
  // this draft (so typing/clearing stays responsive); the settings PATCH
  // fires from `onCommit` (blur/Enter) instead, so a momentarily-cleared
  // field never reaches the debounced patch as a persisted "0".
  const [maxConcurrentDraft, setMaxConcurrentDraft] = useState<number | null>(null);
  const [budgetDraft, setBudgetDraft] = useState<number | null>(null);
  const [throttleDraft, setThrottleDraft] = useState<number | null>(null);
  const [ciWaitDraft, setCiWaitDraft] = useState<number | null>(null);

  return (
    <>
      <Row
        label="Enable Task Master"
        desc={`Picks up labeled GitHub issues, claims ready tasks automatically, and hands finished work to review. When off, the task board still works and tasks already running keep their budget and GitHub status. Server default: ${env.enabled ? "on" : "off"}.`}
      >
        <Toggle
          on={resolved.enabled}
          onChange={(v) => updateSettings({ taskMaster: { enabled: v ? "on" : "off" } })}
        />
      </Row>
      <Row
        label="Pause auto-claim"
        desc={
          "Stop claiming new ready tasks. Tasks already running are unaffected, and you can" +
          " still claim a task manually from the Tasks panel." +
          (resolved.enabled ? "" : " Has no effect while Task Master is off.")
        }
      >
        <Toggle
          on={tm.autoClaimPaused}
          disabled={!resolved.enabled}
          onChange={(v) => updateSettings({ taskMaster: { autoClaimPaused: v } })}
        />
      </Row>
      <Row
        label="Max concurrent claims"
        desc={`The most tasks that can be claimed or running at the same time. Server default: ${env.maxConcurrent}.`}
      >
        <NumberField
          value={maxConcurrentDraft ?? resolved.maxConcurrent}
          min={1}
          max={20}
          width={46}
          suffix="tasks"
          onChange={(v) => setMaxConcurrentDraft(clampTaskMasterFieldMax(v, 20))}
          onCommit={(v) => {
            setMaxConcurrentDraft(null);
            // Two-sided clamp on commit only (Hermes review, PR #480,
            // second pass) — unlike budget/throttle, a repaired
            // maxConcurrent lands on the -1 "inherit" sentinel server-side
            // (safeSentinelNumber's dangerousBelow), not a fixed default,
            // so a displayed "0" would be doubly misleading. Clamping the
            // lower bound here is safe: onCommit is a one-shot blur/Enter
            // event, so there's no next keystroke for a snap-to-1 to
            // corrupt the way there would be on every keystroke.
            updateSettings({ taskMaster: { maxConcurrent: clampNumberFieldOnCommit(v, 1, 20) } });
          }}
        />
      </Row>
      {/*
        Hermes review, PR #480 — clearing this field (or the throttle one
        below) fires onChange(0), and 0 IS this field's real "unlimited"
        value, so persisting every keystroke (like every other Settings
        number field does) risked a debounced PATCH landing mid-edit with
        "no budget enforcement". Fixed by decoupling display from commit:
        onChange only updates local draft state (kept responsive), and the
        settings PATCH fires from onCommit (blur/Enter) instead — an
        in-progress "0" from clearing the field never reaches the store
        unless the user actually stops editing there.
      */}
      <Row
        label="Per-task budget"
        desc={`How long a task may run before it's stopped and marked failed. 0 means no limit. Server default: ${env.budgetMinutes} min.`}
      >
        <NumberField
          value={budgetDraft ?? resolved.budgetMinutes}
          min={0}
          max={10080}
          width={54}
          suffix="minutes"
          onChange={setBudgetDraft}
          onCommit={(v) => {
            setBudgetDraft(null);
            updateSettings({
              taskMaster: { budgetMinutes: clampNumberFieldOnCommit(v, 0, 10080) },
            });
          }}
        />
      </Row>
      <Row
        label="Progress-comment throttle"
        desc={`Minimum time between progress comments on the same GitHub issue. 0 posts every update. Server default: ${env.progressCommentMinutes} min.`}
      >
        <NumberField
          value={throttleDraft ?? resolved.progressCommentMinutes}
          min={0}
          max={1440}
          width={46}
          suffix="minutes"
          onChange={setThrottleDraft}
          onCommit={(v) => {
            setThrottleDraft(null);
            updateSettings({
              taskMaster: { progressCommentMinutes: clampNumberFieldOnCommit(v, 0, 1440) },
            });
          }}
        />
      </Row>
      <Row
        label="Review-agent CI wait"
        desc="How long the review agent waits for CI results on the pull request before it starts, so the review sees real pass/fail results. 0 starts the review immediately."
      >
        <NumberField
          value={ciWaitDraft ?? resolved.reviewCiWaitMinutes}
          min={0}
          max={240}
          width={54}
          suffix="minutes"
          onChange={setCiWaitDraft}
          onCommit={(v) => {
            setCiWaitDraft(null);
            updateSettings({
              taskMaster: { reviewCiWaitMinutes: clampNumberFieldOnCommit(v, 0, 240) },
            });
          }}
        />
      </Row>
      <Row
        label="Skip permissions on unattended spawns"
        desc={`Start unattended task and review sessions with the agent's skip-permissions mode, so they don't stall at a permission prompt. This lets agents run any tool without asking — enable it only if you trust the tasks. Server default: ${env.skipPermissions ? "on" : "off"}.`}
      >
        <Toggle
          on={resolved.skipPermissions}
          onChange={(v) => updateSettings({ taskMaster: { skipPermissions: v ? "on" : "off" } })}
        />
      </Row>
      <Row
        label="Default agent"
        desc="Agent used for a task when neither the task nor its project names one."
      >
        <Dropdown
          value={tm.defaultAgent}
          onChange={(v) => updateSettings({ taskMaster: { defaultAgent: v } })}
          options={AGENT_OPTIONS}
        />
      </Row>
      <Row
        label="Default review agent"
        desc="Agent that reviews a finished task when neither the task nor its project names one. None leaves the review to a person."
      >
        <Dropdown
          value={tm.defaultReviewAgent}
          onChange={(v) => updateSettings({ taskMaster: { defaultReviewAgent: v } })}
          options={REVIEW_AGENT_OPTIONS}
        />
      </Row>
      <Row
        label="Reset to server defaults"
        desc="Return Enable, Max concurrent claims, Per-task budget, Progress-comment throttle, and Skip permissions to the server's defaults. Pause auto-claim and Review-agent CI wait are left as they are."
      >
        <SecondaryButton
          onClick={() => {
            setMaxConcurrentDraft(null);
            setBudgetDraft(null);
            setThrottleDraft(null);
            updateSettings({
              taskMaster: {
                enabled: "inherit",
                maxConcurrent: -1,
                budgetMinutes: -1,
                progressCommentMinutes: -1,
                skipPermissions: "inherit",
              },
            });
          }}
        >
          Reset
        </SecondaryButton>
      </Row>

      <Eyebrow
        title="Server settings"
        desc="Set by the server administrator. Changing them requires a restart."
      />
      <div className="settings-info-table">
        <div className="settings-info-row zebra">
          <span className="settings-info-key">GitHub issue label</span>
          <span className="settings-info-value">{env.issueLabel}</span>
        </div>
        <div className="settings-info-row">
          <span className="settings-info-key">Poll interval</span>
          <span className="settings-info-value">{env.pollIntervalSeconds}s</span>
        </div>
      </div>

      <Eyebrow
        title="Agent selection"
        desc="A task's own Agent: or ReviewAgent: line wins, then the project's setting (project menu → Edit), then the defaults above. Agents → Default agent only affects new terminal sessions."
      />
      <Eyebrow
        title="Auto-tag release"
        desc="Whether a merged task opens or updates a release pull request is set per project (project menu → Edit → Auto-tag release). Off by default."
      />
    </>
  );
}
