import { useId, useState } from "react";
import { formatRelativeAge } from "../relativeTime.js";
import { ChevronDownIcon } from "../ui/icons.js";
import { SafeHtml } from "../ui/SafeHtml.js";
import { StatusChip } from "../ui/sidebar/index.js";
import type { Tone } from "../lib/statusTone.js";
import { roundLabelFromHtml } from "../lib/reviewRounds.js";

/**
 * One comment or review on a PR or issue, as its own card: a header that
 * folds the body away (author, review verdict, round, age) over the rendered
 * HTML. The same card renders a PR's timeline and an issue's comments, so the
 * two read alike; `defaultOpen` picks which are expanded when first shown.
 */
export function CommentCard({
  author,
  at,
  bodyHtml,
  state,
  defaultOpen,
}: {
  author: string | null;
  /** ISO timestamp the comment was posted. */
  at: string;
  bodyHtml: string;
  /** A review's verdict; plain comments have none. */
  state?: { label: string; tone: Tone };
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const round = roundLabelFromHtml(bodyHtml);
  return (
    <div className="gh-card">
      <button
        type="button"
        className="gh-card-h"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDownIcon size={12} className={open ? "sb-chev" : "sb-chev sb-chev--closed"} />
        <b className="gh-card-author">{author ?? "unknown"}</b>
        {state && <StatusChip tone={state.tone}>{state.label}</StatusChip>}
        {round && <span className="gh-card-round">{round}</span>}
        <span className="gh-card-age">{formatRelativeAge(Date.parse(at))}</span>
      </button>
      {open && (
        <div id={bodyId} className="gh-card-b">
          <SafeHtml className="gh-html" html={bodyHtml} />
        </div>
      )}
    </div>
  );
}
