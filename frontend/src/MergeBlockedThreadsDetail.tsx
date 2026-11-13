import type { MouseEvent } from "react";
import {
  blockedThreadText,
  parseMergeBlockedThreads,
  safeGithubUrl,
  type MergeBlockedThreadsInfo,
} from "./needsHuman.js";

/** On a task card a click bubbles to the card and opens the task drawer;
 * following a link out must not do that too. */
const stopCardClick = (e: MouseEvent) => e.stopPropagation();

/** The open threads blocking a merge, linking each thread and its alert.
 * Renders nothing when the detail is unavailable, so the generic text stands. */
export function MergeBlockedThreadsDetail({ raw }: { raw: string | null | undefined }) {
  const info: MergeBlockedThreadsInfo | null = parseMergeBlockedThreads(raw);
  if (!info) return null;
  const more = info.total - info.threads.length;
  return (
    <ul className="merge-blocked-threads" data-testid="merge-blocked-threads">
      {info.threads.map((t, i) => {
        const threadUrl = safeGithubUrl(t.url);
        const alertUrl = safeGithubUrl(t.alert?.url);
        return (
          <li key={i}>
            {threadUrl ? (
              <a href={threadUrl} target="_blank" rel="noreferrer" onClick={stopCardClick}>
                {blockedThreadText(t)}
              </a>
            ) : (
              blockedThreadText(t)
            )}
            {alertUrl && (
              <>
                {" "}
                <a href={alertUrl} target="_blank" rel="noreferrer" onClick={stopCardClick}>
                  alert
                </a>
              </>
            )}
          </li>
        );
      })}
      {more > 0 && <li>{`and ${more} more`}</li>}
    </ul>
  );
}
