import type { IBuffer } from "@xterm/xterm";

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
