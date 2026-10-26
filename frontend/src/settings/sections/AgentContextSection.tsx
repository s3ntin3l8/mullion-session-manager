import { useEffect, useState } from "react";
import { api } from "../../api/index.js";
import { readString, STORAGE_KEYS, writeString } from "../../lib/persistedState.js";
import { useDashboardStore } from "../../store/index.js";
import { ConfirmButton } from "../../ui/ConfirmButton.js";
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

  // Issue #1979 — text the wizard saved before the server kept a snapshot of
  // it (`workflowConventionsAppliedText`) is never regenerated when the rules
  // change, and from here it can't be told apart from a hand edit. When the
  // saved answers now generate something else, say so and offer the wizard's
  // own apply. Only the answers decide the generated text, so typing in the
  // textarea doesn't refetch it.
  const answers = s.workflowConventionAnswers;
  const answersKey = JSON.stringify(answers);
  const unsnapshotted =
    !s.workflowConventionsAppliedText &&
    s.workflowConventionsText !== "" &&
    Object.values(answers).some((answer) => answer !== "");
  // Keyed by the answers it was generated from, so a stale result is ignored
  // rather than reset from inside the effect.
  const [preview, setPreview] = useState<{ key: string; text: string } | null>(null);
  useEffect(() => {
    if (!unsnapshotted) return;
    let cancelled = false;
    api
      .previewWorkflowConventionsText(JSON.parse(answersKey) as Record<string, string>)
      .then(({ text }) => {
        if (!cancelled) setPreview({ key: answersKey, text });
      })
      // No notice when the preview can't be had: it is advice, not state.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [unsnapshotted, answersKey]);
  const generated = unsnapshotted && preview?.key === answersKey ? preview.text : null;
  // A hand edit after a wizard apply also clears the snapshot server-side, so
  // this can't tell it from pre-snapshot text: let the user dismiss it, until
  // the generator's output changes again.
  const [dismissed, setDismissed] = useState(() =>
    readString(STORAGE_KEYS.dismissedConventionsNotice, ""),
  );
  const staleConventions =
    generated !== null &&
    generated !== "" &&
    generated !== s.workflowConventionsText &&
    generated !== dismissed;

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
        <div style={{ fontSize: "0.84375rem", fontWeight: 500 }}>Workflow conventions</div>
        <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: 3, marginBottom: 8 }}>
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
        {staleConventions && generated !== null && (
          <div className="settings-footer-note" role="status">
            This text differs from what your saved wizard answers generate now. Text saved before
            Mullion tracked the wizard's output isn't refreshed when the wizard's rules change, so
            if you didn't edit it by hand, re-apply to pick up the current rules. Re-applying
            replaces the text above, hand edits included.{" "}
            <ConfirmButton
              variant="neutral"
              title="Replace the conventions with what your saved answers generate now"
              armedLabel="Replace text"
              onConfirm={() =>
                // The wizard's own apply (see onApply below): text and answers
                // in one PATCH, which also records the snapshot server-side.
                updateSettings({
                  sessions: {
                    workflowConventionsText: generated,
                    workflowConventionAnswers: answers,
                  },
                })
              }
            >
              Re-apply
            </ConfirmButton>{" "}
            <button
              className="git-panel-fetch-btn"
              onClick={() => {
                writeString(STORAGE_KEYS.dismissedConventionsNotice, generated);
                setDismissed(generated);
              }}
            >
              Dismiss
            </button>
          </div>
        )}
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
