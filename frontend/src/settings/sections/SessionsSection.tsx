import { Fragment, useState } from "react";
import { useDashboardStore } from "../../store/index.js";
import { resolveAgentLogo } from "../../cliLogos.js";
import { GroupHeading, NumberField, Row, Toggle } from "../../ui/primitives.js";
import { clampNumberFieldOnCommit } from "../clamp.js";

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

      <Row label="Confirm before kill" desc="Require a second click to kill a session.">
        <Toggle
          on={s.confirmBeforeKill}
          onChange={(v) => updateSettings({ sessions: { confirmBeforeKill: v } })}
        />
      </Row>
      <Row
        label="Show exited & killed sessions"
        desc="Keep sessions that have ended visible in the sidebar."
      >
        <Toggle on={!hideEndedSessions} onChange={(v) => setHideEndedSessions(!v)} />
      </Row>
      <Row
        label="Show task sessions"
        desc="Show Task Master's worker and review sessions in the sidebar alongside your own."
      >
        <Toggle on={showTaskSessions} onChange={setShowTaskSessions} />
      </Row>
      <div style={{ paddingTop: 6 }}>
        <GroupHeading title="Child sessions" />
      </div>
      <Row
        label="Auto-open child session panels"
        desc={
          "When an agent starts a child session, open its panel next to the" +
          " parent automatically. Child sessions always appear in the sidebar."
        }
      >
        <Toggle
          on={s.autoOpenChildPanels}
          onChange={(v) => updateSettings({ sessions: { autoOpenChildPanels: v } })}
        />
      </Row>
      <Row
        label="Max child sessions per parent"
        desc="The most child sessions one agent can have running at the same time."
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

      <div style={{ paddingTop: 6 }}>
        <GroupHeading title="Cleanup & history" />
      </div>
      <Row
        label="Auto-reconcile interval"
        desc="How often Mullion checks for sessions that have exited."
      >
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
        desc="How long an unresolved error stays on a session before it's cleared."
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
        desc="How long a busy state (compacting, running subagents) stays on a silent session before it's cleared."
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
        label="Persist session event history"
        desc={
          "Save session events so the timeline survives a restart. Only events" +
          " from now on are recorded."
        }
      >
        <Toggle
          on={s.eventPersistence}
          onChange={(v) => updateSettings({ sessions: { eventPersistence: v } })}
        />
      </Row>
      <Row
        label="Event history retention"
        desc="Delete saved events older than this. 0 keeps them forever."
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
        desc="Keep only this many of the newest saved events per session. 0 means no limit."
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
    </>
  );
}
