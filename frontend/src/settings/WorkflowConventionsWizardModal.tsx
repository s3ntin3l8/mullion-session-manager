import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, ApiError } from "../api/index.js";
import type { WorkflowConventionQuestion } from "../api/index.js";
import { Modal } from "../ui/Modal.js";

// Issue #937 — a fixed, structured multiple-choice flow, NOT an agent turn
// and not a blank text box (see the issue's own "Corrected design" section
// for why a deterministic form beats both alternatives here). Completing it
// calls api.previewWorkflowConventionsText and hands the assembled text
// (and the raw answers behind it) back to the caller via `onApply` — the
// caller (SessionsSection) is the one that actually writes both into
// settings.sessions via the normal PATCH /api/settings path.
//
// Issue #1203 (Phase 2 of the follow-up plan) — this used to be a pure
// one-shot: "No wizard-answer state is persisted anywhere; re-opening this
// modal always starts from a blank slate." Now pre-fills from
// `initialAnswers` (settings.sessions.workflowConventionAnswers) and, when
// every question already has a real answer, opens on a REVIEW step instead
// of the question flow — so changing one answer is open, click it, apply,
// not re-answer everything from scratch.
//
// Question/option content itself is fetched from GET
// /api/workflow-conventions/questions rather than duplicated here, so this
// component can never drift from the actual assembly table
// buildWorkflowConventionsText (workflow-conventions.ts) reads server-side.
export function WorkflowConventionsWizardModal({
  onClose,
  onApply,
  initialAnswers,
  currentText,
}: {
  onClose: () => void;
  onApply: (text: string, answers: Record<string, string>) => void;
  // settings.sessions.workflowConventionAnswers — every current question id
  // mapped to its stored answer, or "" if that question was never answered
  // (see that field's own doc comment in settings.ts for why the default is
  // shaped this way, not a bare `{}`).
  initialAnswers: Record<string, string>;
  // settings.sessions.workflowConventionsText — the currently-saved text,
  // used only for the hand-edit comparison below.
  currentText: string;
}) {
  // "The wizard has been run with persistence before" — deliberately NOT
  // `Object.keys(initialAnswers).length > 0`: the default value already has
  // every question id as a key (mapped to ""), so a key-count check would
  // be true even for an install that never ran the wizard. At least one
  // REAL (non-empty) answer is what actually distinguishes "has run" from
  // "never run."
  const hasRunBefore = Object.values(initialAnswers).some((v) => v.length > 0);

  const [questions, setQuestions] = useState<WorkflowConventionQuestion[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Starts on the review step when there's something to review; otherwise
  // goes straight into the question flow, same as before this issue.
  const [viewMode, setViewMode] = useState<"review" | "questions">(
    hasRunBefore ? "review" : "questions",
  );
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>(initialAnswers);
  // Set once every question has an answer and the assembled preview has
  // been fetched — the review/confirm step ("This replaces your current
  // text") shown in place of the question flow.
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // The text `initialAnswers` would actually produce, fetched once (only
  // when there's a prior run to compare against) so the hand-edit warning
  // below never hand-derives that text itself — the same "never duplicate
  // buildWorkflowConventionsText's own assembly logic" rule the rest of
  // this component already follows.
  const [derivedText, setDerivedText] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .getWorkflowConventionQuestions()
      .then((result) => {
        if (cancelled) return;
        setQuestions(result.questions);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof ApiError ? err.message : "Failed to load wizard questions");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasRunBefore) return;
    let cancelled = false;
    void api
      .previewWorkflowConventionsText(initialAnswers)
      .then((result) => {
        if (!cancelled) setDerivedText(result.text);
      })
      .catch(() => {
        // Best-effort — a failed fetch here just means the hand-edit
        // warning doesn't render; the wizard itself is still fully usable.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial-mount fetch only, deliberately not re-run on prop changes
  }, []);

  const handEdited = derivedText !== null && derivedText !== currentText;

  const currentQuestion = questions?.[stepIndex];
  const isLastQuestion = questions !== null && stepIndex === questions.length - 1;

  const handleSelect = (questionId: string, optionId: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: optionId }));
  };

  const requestPreview = (answersToUse: Record<string, string> = answers) => {
    setPreviewError(null);
    void api
      .previewWorkflowConventionsText(answersToUse)
      .then((result) => setPreviewText(result.text))
      .catch((err: unknown) => {
        setPreviewError(err instanceof ApiError ? err.message : "Failed to build preview");
      });
  };

  const handleNext = () => {
    if (!questions) return;
    if (isLastQuestion) {
      requestPreview();
      return;
    }
    setStepIndex((i) => i + 1);
  };

  const handleBack = () => {
    if (previewError !== null) {
      setPreviewError(null);
      return;
    }
    if (previewText !== null) {
      setPreviewText(null);
      // Returning from the preview step to a fully-answered question flow
      // that started from the review step goes back to review, not to the
      // last question — "Back" should undo one step of navigation, not
      // silently re-enter the question loop for someone who never meant to
      // walk through it.
      if (viewMode === "review" || hasRunBefore) {
        setViewMode("review");
        return;
      }
      return;
    }
    if (viewMode === "questions" && stepIndex === 0 && hasRunBefore) {
      setViewMode("review");
      return;
    }
    setStepIndex((i) => Math.max(0, i - 1));
  };

  const handleApply = () => {
    if (previewText === null) return;
    onApply(previewText, answers);
    onClose();
  };

  const questionLabel = (questionId: string, optionId: string): string => {
    const question = questions?.find((q) => q.id === questionId);
    const option = question?.options.find((o) => o.id === optionId);
    return option?.label ?? "Not answered";
  };

  let body: ReactNode;
  let footer: ReactNode;

  if (loadError) {
    body = <div className="agent-rules-panel-notice error">{loadError}</div>;
    footer = (
      <button className="create-modal-cancel" onClick={onClose}>
        Close
      </button>
    );
  } else if (!questions) {
    body = <div className="agent-rules-panel-notice">Loading…</div>;
    footer = null;
  } else if (previewError) {
    // Issue #937 review finding — a rejected previewWorkflowConventionsText
    // call used to leave `previewText` at `null` with nothing rendering
    // `previewError` at all (that branch only existed inside the
    // `previewText !== null` case below, which a failure never reaches):
    // clicking "Preview" after a network hiccup silently did nothing. This
    // is its own dedicated step now, with a way back to either retry or
    // return to the question flow.
    body = <div className="agent-rules-panel-notice error">{previewError}</div>;
    footer = (
      <>
        <button className="create-modal-cancel" onClick={handleBack}>
          Back
        </button>
        <button className="create-modal-submit" onClick={() => requestPreview()}>
          Retry
        </button>
      </>
    );
  } else if (previewText !== null) {
    body = (
      <>
        <div className="agent-rules-panel-notice">
          This replaces your current workflow conventions text. You can still hand-edit it afterward
          — nothing about the wizard's answers is remembered as an ongoing sync, just stored so this
          wizard can be reopened and re-run without starting over.
        </div>
        <textarea
          className="agent-rules-panel-textarea"
          value={previewText}
          readOnly
          spellCheck={false}
        />
      </>
    );
    footer = (
      <>
        <button className="create-modal-cancel" onClick={handleBack}>
          Back
        </button>
        <button className="create-modal-cancel" onClick={onClose}>
          Cancel
        </button>
        <button className="create-modal-submit" onClick={handleApply}>
          Replace current text
        </button>
      </>
    );
  } else if (viewMode === "review") {
    body = (
      <>
        {handEdited && (
          <div className="agent-rules-panel-notice warning">
            Your conventions text has been edited by hand since the wizard last ran — regenerating
            below will replace those edits.
          </div>
        )}
        <div className="agent-rules-panel-notice">
          Your last answers. Click one to change it, or regenerate as-is.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {questions.map((question, index) => (
            <button
              key={question.id}
              className="agent-rules-panel-row"
              onClick={() => {
                setStepIndex(index);
                setViewMode("questions");
              }}
            >
              <span className="agent-rules-panel-row-name">{question.question}</span>
              <span style={{ color: "var(--muted)", fontSize: 12 }}>
                {questionLabel(question.id, answers[question.id])}
              </span>
            </button>
          ))}
        </div>
      </>
    );
    footer = (
      <>
        <button className="create-modal-cancel" onClick={onClose}>
          Cancel
        </button>
        <button className="create-modal-submit" onClick={() => requestPreview()}>
          Regenerate
        </button>
      </>
    );
  } else if (currentQuestion) {
    const selected = answers[currentQuestion.id];
    body = (
      <>
        <div className="agent-rules-panel-notice">
          Question {stepIndex + 1} of {questions.length}
        </div>
        <div style={{ fontSize: 13.5, fontWeight: 500, marginBottom: 10 }}>
          {currentQuestion.question}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {currentQuestion.options.map((option) => (
            <button
              key={option.id}
              className={`agent-rules-panel-row${selected === option.id ? " selected" : ""}`}
              onClick={() => handleSelect(currentQuestion.id, option.id)}
            >
              <span className="agent-rules-panel-row-name">{option.label}</span>
            </button>
          ))}
        </div>
      </>
    );
    footer = (
      <>
        {/* Hermes review, PR #1204 — restores the pre-#1201 disabled guard
            for the never-run flow only. In that flow (hasRunBefore false)
            there is no review step to fall back to, so Back on the FIRST
            question is a genuine no-op and should be disabled, same as
            before this issue. In the review-entered flow, Back on step 0
            correctly falls through to the review step (handleBack's own
            `stepIndex === 0 && hasRunBefore` branch) — must stay enabled
            there. */}
        <button
          className="create-modal-cancel"
          onClick={handleBack}
          disabled={!hasRunBefore && stepIndex === 0}
        >
          Back
        </button>
        <button
          className="create-modal-submit"
          onClick={handleNext}
          disabled={selected === undefined || selected === ""}
        >
          {isLastQuestion ? "Preview" : "Next"}
        </button>
      </>
    );
  }

  return (
    <Modal onClose={onClose} title="Generate workflow conventions" footer={footer}>
      {body}
    </Modal>
  );
}
