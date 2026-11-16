// Where the child's PTY byte counter stood when it began answering (#3159).
//
// `prompt_session` hands back the session's event head (`afterSeq`); a
// following wait_for_output uses it to start its match window at the first
// `turn_start`/`progress` hook after that seq — the TUI's redraw of the
// submitted prompt is behind that point, so a marker the prompt itself
// contains no longer matches the echo. Kept out of pty-manager.ts, which is
// size-ratcheted.

/** The slice of a Session this needs. */
interface OffsetSource {
  readonly eventSeqHead: number;
  readonly outputOffset: number;
}

interface AnswerStart {
  seq: number;
  offset: number;
}

const MAX_ENTRIES = 64;
const starts = new WeakMap<object, AnswerStart[]>();

/** Call BEFORE a hook message is dispatched: `seq` is the seq its event would
 * carry, so "after `afterSeq`" means "arrived after that prompt's own events". */
export function noteHookForAnswerStart(session: OffsetSource, kind: string): void {
  if (kind !== "turn_start" && kind !== "progress") return;
  let list = starts.get(session);
  if (!list) starts.set(session, (list = []));
  list.push({ seq: session.eventSeqHead + 1, offset: session.outputOffset });
  if (list.length > MAX_ENTRIES) list.shift();
}

/** The PTY offset at which the first turn_start/progress hook after event seq
 * `afterSeq` arrived, or undefined when none has (or the CLI emits no hooks). */
export function answerStartOffsetAfter(session: object, afterSeq: number): number | undefined {
  return starts.get(session)?.find((e) => e.seq > afterSeq)?.offset;
}
