import { useState, type KeyboardEvent } from "react";
import type { GitHubPrReviewEvent } from "../api/types.js";
import { ErrorText } from "../ui/ErrorText.js";
import { Button } from "../ui/sidebar/index.js";

// The GitHub sidebar's write surfaces (#1672): a comment box, a review box and
// a review thread's Reply / Resolve. Each takes an async submit that throws on
// failure; the box keeps the draft and shows the error, and clears on success.

const errorText = (err: unknown) => (err instanceof Error ? err.message : "Could not post");

/** Ctrl/Cmd+Enter submits, as on github.com. */
const isSubmitKey = (e: KeyboardEvent) => e.key === "Enter" && (e.metaKey || e.ctrlKey);

export function CommentComposer({
  label,
  placeholder = "Leave a comment",
  submitLabel = "Comment",
  autoFocus,
  onSubmit,
  onCancel,
}: {
  /** Accessible name of the text box. */
  label: string;
  placeholder?: string;
  submitLabel?: string;
  autoFocus?: boolean;
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blank = body.trim() === "";

  const submit = async () => {
    if (blank || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(body.trim());
      setBody("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gh-composer">
      <textarea
        className="create-modal-textarea gh-composer-input"
        aria-label={label}
        placeholder={placeholder}
        rows={3}
        value={body}
        autoFocus={autoFocus}
        disabled={busy}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (isSubmitKey(e)) void submit();
        }}
      />
      {error && <ErrorText>{error}</ErrorText>}
      <div className="gh-detail-actions">
        <Button size="sm" variant="primary" disabled={blank || busy} onClick={submit}>
          {busy ? "Posting…" : submitLabel}
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * One box for everything said on a PR from the sidebar: a comment, or — when
 * `onReview` is given — a review verdict. Comment and Request changes need a
 * body (GitHub refuses them without one); Approve does not. The box grows with
 * what is typed. A verdict GitHub refuses (an author reviewing their own PR)
 * shows the server's reason and keeps the draft.
 */
export function ConversationComposer({
  onComment,
  onReview,
  onClose,
}: {
  onComment: (body: string) => Promise<void>;
  /** Omitted where no review can be submitted (a closed or merged PR). */
  onReview?: (event: GitHubPrReviewEvent, body: string) => Promise<void>;
  onClose: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<GitHubPrReviewEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blank = body.trim() === "";

  const send = async (event: GitHubPrReviewEvent) => {
    if (busy || (blank && event !== "APPROVE")) return;
    setBusy(event);
    setError(null);
    try {
      if (event === "COMMENT" || !onReview) await onComment(body.trim());
      else await onReview(event, body.trim());
      setBody("");
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="gh-composer" role="group" aria-label="Comment or review">
      <textarea
        className="create-modal-textarea gh-composer-input gh-composer-grow"
        aria-label="Comment or review"
        placeholder={
          onReview
            ? "Leave a comment, or write a review summary (Ctrl+Enter posts a comment)"
            : "Leave a comment (Ctrl+Enter posts)"
        }
        rows={3}
        value={body}
        autoFocus
        disabled={busy !== null}
        onChange={(e) => {
          setBody(e.target.value);
          const el = e.currentTarget;
          if (el.scrollHeight > 0) {
            el.style.height = "auto";
            el.style.height = `${el.scrollHeight}px`;
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          } else if (isSubmitKey(e)) void send("COMMENT");
        }}
      />
      {error && <ErrorText>{error}</ErrorText>}
      <div className="gh-detail-actions">
        <Button
          size="sm"
          variant="primary"
          disabled={busy !== null || blank}
          onClick={() => void send("COMMENT")}
        >
          {busy === "COMMENT" ? "Posting…" : "Comment"}
        </Button>
        {onReview && (
          <>
            <Button size="sm" disabled={busy !== null} onClick={() => void send("APPROVE")}>
              {busy === "APPROVE" ? "Submitting…" : "Approve"}
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy !== null || blank}
              onClick={() => void send("REQUEST_CHANGES")}
            >
              {busy === "REQUEST_CHANGES" ? "Submitting…" : "Request changes"}
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** A review thread's Reply (opens an inline box) and Resolve. */
export function ThreadActions({
  resolved,
  onReply,
  onResolve,
}: {
  resolved: boolean;
  onReply: (body: string) => Promise<void>;
  onResolve: () => Promise<void>;
}) {
  const [replying, setReplying] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolve = async () => {
    setResolving(true);
    setError(null);
    try {
      await onResolve();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setResolving(false);
    }
  };

  if (replying) {
    return (
      <CommentComposer
        label="Reply"
        placeholder="Reply…"
        submitLabel="Reply"
        autoFocus
        onSubmit={async (body) => {
          await onReply(body);
          setReplying(false);
        }}
        onCancel={() => setReplying(false)}
      />
    );
  }
  return (
    <>
      {error && <ErrorText>{error}</ErrorText>}
      <div className="gh-detail-actions">
        <button type="button" className="gh-link-button" onClick={() => setReplying(true)}>
          Reply
        </button>
        {!resolved && (
          <button
            type="button"
            className="gh-link-button"
            disabled={resolving}
            onClick={() => void resolve()}
          >
            {resolving ? "Resolving…" : "Resolve"}
          </button>
        )}
      </div>
    </>
  );
}
