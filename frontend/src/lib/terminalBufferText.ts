import type { IBuffer, Terminal } from "@xterm/xterm";

/** The whole buffer (scrollback + screen) as plain text: soft-wrapped rows
 * are rejoined into their logical line, trailing whitespace on each line and
 * trailing blank lines are dropped. A row is only right-trimmed when the next
 * row doesn't continue it — a space sitting in the last column of a wrapped
 * row is real content (`"abcdefghi jkl"` at 10 columns). */
export function bufferToText(buffer: IBuffer): string {
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const continuesOnNextRow = buffer.getLine(i + 1)?.isWrapped === true;
    const text = line.translateToString(!continuesOnNextRow);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.map((l) => l.replace(/\s+$/, "")).join("\n");
}

/** The "real" scrollback for a session: xterm's NORMAL buffer — which holds
 * the inline transcript (and its scrollback) when the program is on the
 * main screen, AND keeps holding that same transcript while the program has
 * switched to the alternate screen. While the active buffer is alternate
 * (Codex's full-screen question dialog, vim, tmux's copy mode, ...), reading
 * `term.buffer.active` would only return the dialog's own pixels and
 * "scrollback" would be the dialog — useless. `term.buffer.normal` is the
 * one buffer that always carries the session's persistent history, so
 * routing the scrollback viewer through it covers both the "normal" and
 * the "alt-screen-with-history-trapped-behind-it" cases from a single
 * code path. When the program is on the normal screen, `term.buffer.normal`
 * IS the active buffer, so this is a no-op there. */
export function scrollbackToText(term: Terminal): string {
  return bufferToText(term.buffer.normal);
}
