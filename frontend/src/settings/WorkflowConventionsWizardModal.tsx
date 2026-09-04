import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, ApiError } from "../api/index.js";
import type { WorkflowConventionQuestion } from "../api/index.js";
import { Modal } from "../ui/Modal.js";

// Issue #937 — a fixed, structured multiple-choice flow, NOT an agent turn
// and not a blank text box (see the issue's own "Corrected design" section
// for why a deterministic form beats both alternatives here). This is a
// STARTER, not an ongoing mode: completing it calls
// api.previewWorkflowConventionsText and hands the assembled text back to
// the caller via `onApply` — the caller (SessionsSection) is the one that
// actually writes it into settings.sessions.workflowConventionsText via the
// normal PATCH /api/settings path, same as any other field in that
// section. No wizard-answer state is persisted anywhere; re-opening this
// modal always starts from a blank slate.
//
// Question/option content itself is fetched from GET
// /api/workflow-conventions/questions rather than duplicated here, so this
// component can never drift from the actual assembly table
// buildWorkflowConventionsText (workflow-conventions.ts) reads server-side.
export function WorkflowConventionsWizardModal({
  onClose,
  onApply,
}: {
  onClose: () => void;
  onApply: (text: string) => void;
}) {
  const [questions, setQuestions] = useState<WorkflowConventionQuestion[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // Set once every question has an answer and the assembled preview has
  // been fetched — the review/confirm step ("This replaces your current
  // text") shown in place of the question flow.
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

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

  const currentQuestion = questions?.[stepIndex];
  const isLastQuestion = questions !== null && stepIndex === questions.length - 1;

  const handleSelect = (questionId: string, optionId: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: optionId }));
  };

  const handleNext = () => {
    if (!questions) return;
    if (isLastQuestion) {
      void api
        .previewWorkflowConventionsText(answers)
        .then((result) => setPreviewText(result.text))
        .catch((err: unknown) => {
          setPreviewError(err instanceof ApiError ? err.message : "Failed to build preview");
        });
      return;
    }
    setStepIndex((i) => i + 1);
  };

  const handleBack = () => {
    if (previewText !== null) {
      setPreviewText(null);
      return;
    }
    setStepIndex((i) => Math.max(0, i - 1));
  };

  const handleApply = () => {
    if (previewText === null) return;
    onApply(previewText);
    onClose();
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
  } else if (previewText !== null) {
    body = (
      <>
        <div className="agent-rules-panel-notice">
          This replaces your current workflow conventions text. You can still hand-edit it afterward
          — nothing about the wizard's answers is remembered.
        </div>
        {previewError && <div className="agent-rules-panel-notice error">{previewError}</div>}
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
        <button className="create-modal-cancel" onClick={handleBack} disabled={stepIndex === 0}>
          Back
        </button>
        <button
          className="create-modal-submit"
          onClick={handleNext}
          disabled={selected === undefined}
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
