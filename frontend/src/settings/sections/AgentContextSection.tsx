import { useState } from "react";
import { useDashboardStore } from "../../store/index.js";
import { GroupHeading, Row, Toggle } from "../../ui/primitives.js";
import { BundleSyncPanel } from "../BundleSyncPanel.js";
import { WorkflowConventionsWizardModal } from "../WorkflowConventionsWizardModal.js";
import { SkillsSection } from "./SkillsSection.js";

export function AgentContextSection() {
  const { settings, updateSettings } = useDashboardStore();
  const s = settings.sessions;

  // Issue #937 — the wizard is a one-shot "regenerate from scratch" action,
  // not a live-synced mode: it has no state of its own here beyond whether
  // its modal is open. Applying its result just calls updateSettings the
  // same way typing in the textarea below does.
  const [wizardOpen, setWizardOpen] = useState(false);

  return (
    <>
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
          "On SessionStart, carry a project's pinned note (set per-project in" +
          " the Mullion Briefing panel) into every session's starting" +
          " context — always additive on top of whatever AGENTS.md already" +
          " told the agent, never a competing alternate to it. Capped at 512" +
          " bytes (a short header and, if truncated, a truncation note add a" +
          " little on top). Projects with no pinned note set are unaffected —" +
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
          initialAnswers={s.workflowConventionAnswers}
          currentText={s.workflowConventionsText}
          onApply={(text, answers) =>
            // Issue #1203 — one PATCH, both fields together: the text and
            // the answers that produced it must land in the same settings
            // write, or a reader between the two (another open tab, a
            // concurrent PATCH) could observe text and answers that don't
            // actually correspond to each other.
            updateSettings({
              sessions: { workflowConventionsText: text, workflowConventionAnswers: answers },
            })
          }
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

      <div style={{ paddingTop: 12 }}>
        <GroupHeading title="Installed skills" />
      </div>
      <SkillsSection />
    </>
  );
}
