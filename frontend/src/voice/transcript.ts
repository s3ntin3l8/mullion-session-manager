// Pure joining rules for dictated text, shared by the buffered-insert path
// in useVoiceDictation.ts. Kept separate from that hook so it's testable
// under vitest's default `environment: "node"` with no DOM at all.

/**
 * Joins the finalized segments collected over one press-to-release
 * dictation into the single string handed to pasteToTerminal
 * (TerminalPane.tsx). Buffering until release (rather than inserting each
 * segment as it arrives) is a deliberate design choice — see the plan's
 * "Getting text into the PTY" section: it makes an abort() genuinely free,
 * and turns N dribbled pastes into a redrawing TUI into one atomic paste.
 *
 * - Each segment is trimmed and empties are dropped (a provider can emit an
 *   empty final on a garbled utterance).
 * - Internal whitespace runs collapse to a single space.
 * - Any embedded \r/\n is stripped — defence in depth: pasteToTerminal only
 *   strips a *trailing* newline (issue #66), and an embedded one would
 *   submit the CLI's prompt mid-dictation.
 * - Segments join with a single space.
 * - Returns "" (not a bare space) when there is nothing to insert, so the
 *   caller can treat that as "no-op" without a separate emptiness check.
 */
export function formatForInsert(segments: string[]): string {
  const cleaned = segments
    .map((segment) =>
      segment
        .replace(/[\r\n]+/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((segment) => segment.length > 0);
  return cleaned.join(" ");
}

/**
 * The text actually handed to pasteToTerminal: the joined transcript plus
 * one trailing space, so dictated text doesn't run into whatever the user
 * types next — same rationale as TerminalPane.tsx's own
 * `uploadAndInjectImage`'s `${path} ` convention. Returns "" (not " ") for
 * an empty buffer so callers can skip the paste entirely.
 */
export function formatForPaste(segments: string[]): string {
  const text = formatForInsert(segments);
  return text ? `${text} ` : "";
}
