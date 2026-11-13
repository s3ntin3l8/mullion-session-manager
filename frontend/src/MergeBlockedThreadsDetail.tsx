import {
  blockedThreadText,
  parseMergeBlockedThreads,
  safeGithubUrl,
  type MergeBlockedThreadsInfo,
} from "./needsHuman.js";

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
              <a href={threadUrl} target="_blank" rel="noreferrer">
                {blockedThreadText(t)}
              </a>
            ) : (
              blockedThreadText(t)
            )}
            {alertUrl && (
              <>
                {" "}
                <a href={alertUrl} target="_blank" rel="noreferrer">
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
