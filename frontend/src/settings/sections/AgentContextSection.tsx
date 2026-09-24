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
          "Give every new session a short guide to working inside Mullion" +
          " (browser automation, the dock, child sessions)."
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
          "Add a project's pinned briefing note to every new session in that" +
          " project. Notes are limited to 512 bytes."
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
          How your team works (branching, merging, review), added to every new session. A project
          can opt out from its briefing panel, and a project's own AGENTS.md always takes
          precedence.
        </div>
        <textarea
          className="agent-rules-panel-textarea"
          style={{ minHeight: 120, width: "100%", boxSizing: "border-box", resize: "vertical" }}
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
          "Install Mullion's skills and subagents for Claude Code, Codex," +
          " opencode, and Antigravity on this host, and keep them up to date." +
          " Turning this off removes them again."
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
