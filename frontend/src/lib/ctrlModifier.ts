import type { CtrlModifierMode } from "../terminalInputRegistry.js";

/** The control code for `data` typed with Ctrl held, or null when `data`
 * isn't a single character that has one (Ctrl+letter, Ctrl+@[\]^_, Ctrl+Space
 * = NUL, Ctrl+? = DEL) — the same mapping a hardware terminal keyboard uses. */
export function applyCtrl(data: string): string | null {
  if (data.length !== 1) return null;
  const code = data.charCodeAt(0);
  if (code >= 0x61 && code <= 0x7a) return String.fromCharCode(code - 0x60);
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code - 0x40);
  if (data === " ") return "\x00";
  if (data === "?") return "\x7f";
  return null;
}

/** Ctrl applied to a chunk of typed input. Android soft keyboards (Gboard
 * and friends) often hold letters back until the word is committed and then
 * deliver them in one chunk — typically the letter plus the committing
 * space. The modifier applies to the chunk's first character; a lone
 * committing space after it is dropped, anything else passes through.
 * Returns null when the first character has no control code (the modifier
 * then stays armed, same as for a single such key). */
export function applyCtrlToChunk(data: string): string | null {
  const ctrl = applyCtrl(data.slice(0, 1));
  if (ctrl === null) return null;
  const rest = data.slice(1);
  return ctrl + (rest === " " ? "" : rest);
}

/** Key-bar Ctrl tap cycle: off → once (next key only) → locked → off. */
export function nextCtrlMode(mode: CtrlModifierMode): CtrlModifierMode {
  if (mode === "off") return "once";
  if (mode === "once") return "locked";
  return "off";
}
