import { useState } from "react";
import { useDashboardStore, FALLBACK_TASK_MASTER_ENV } from "../../store/index.js";
import { resolveTaskMaster } from "../../taskConfig.js";
import { Eyebrow, NumberField, Row, SecondaryButton, Toggle } from "../../ui/primitives.js";
import { clampNumberFieldOnCommit, clampTaskMasterFieldMax } from "../clamp.js";

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

  return (
    <>
      <Row
        label="Enable Task Master"
        desc={`Turns on the background watcher's GitHub ingest and auto-claim, the claim/approve endpoints, and a claimed task's transition into "reviewing" (including spawning its review-agent session). Reject stays available even while off, so a task already in reviewing can still be sent back rather than getting stranded. A claimed/in_progress task still keeps its own budget enforced and its status synced to GitHub either way — a safety net, not new work. The local task board (create/edit/drag/delete) works either way too. Environment default: ${env.enabled ? "on" : "off"}.`}
      >
        <Toggle
          on={resolved.enabled}
          onChange={(v) => updateSettings({ taskMaster: { enabled: v ? "on" : "off" } })}
        />
      </Row>
      <Row
        label="Pause auto-claim"
        desc={
          "Stops the watcher from claiming new ready tasks. Takes effect on the next sweep —" +
          " tasks already claimed or in progress are unaffected. A manual claim from the Tasks" +
          " panel still works while paused." +
          (resolved.enabled ? "" : " (Task Master is off — this has no effect right now.)")
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
        desc={`Tasks in "claimed"/"in_progress" count against this cap — a hard ceiling, not a soft throttle. Environment default: ${env.maxConcurrent}.`}
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
        desc={`How long a claimed task may run before it's force-failed and its session terminated. 0 = unlimited. Environment default: ${env.budgetMinutes} min.`}
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
        desc={`Minimum minutes between two "in progress" comments posted to the same linked GitHub issue. 0 = no throttle. Environment default: ${env.progressCommentMinutes} min.`}
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
        label="Skip permissions on unattended spawns"
        desc={`Passes the resolved agent's own skip-permissions flag (e.g. --dangerously-skip-permissions) to a claim/auto-claim/retry/review-agent spawn, so an unattended agent doesn't stall at a permission prompt with no one to answer it. Off by default: an autonomous agent bypassing every tool-permission check is an explicit opt-in, not a safe default. Environment default: ${env.skipPermissions ? "on" : "off"}.`}
      >
        <Toggle
          on={resolved.skipPermissions}
          onChange={(v) => updateSettings({ taskMaster: { skipPermissions: v ? "on" : "off" } })}
        />
      </Row>
      <Row
        label="Reset to environment defaults"
        desc="Clears every env override above (Enable, Max concurrent, Budget, Throttle, Skip permissions) so this install falls back to its deploy-time MULLION_TASK_* configuration. Pause auto-claim has no env equivalent and is left as-is."
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
        title="Deploy-time settings"
        desc="Set via MULLION_TASK_LABEL / MULLION_TASK_POLL_INTERVAL — changing either requires editing the environment and restarting, since a live label change would orphan already-labeled GitHub issues and the poll interval is a fixed rate-limit tradeoff."
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
        desc="Default Agent and Default Review Agent are per-project, not install-wide — set them on a project's kebab menu → Edit. With neither set, a claim falls back to Launchers & agents → Default agent."
      />
    </>
  );
}
