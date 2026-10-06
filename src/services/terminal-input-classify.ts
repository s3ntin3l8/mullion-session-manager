// Follow-up to #275 (attention-hook hardening, gap #3): the same
// browser->pty write() channel USER_INPUT_ECHO_MS documents above also
// carries a handful of AUTOMATED terminal-protocol replies xterm.js sends on
// the program's behalf (not real human keystrokes) — see that comment's
// "Known limitation" for the enumerated set this mirrors. USER_INPUT_ECHO_MS
// itself tolerates these as a rare, self-limiting false "idle" because the
// cost of being wrong is small; isGenuineUserInput() below is held to a much
// stricter bar, because it gates the ONLY thing that can clear an
// OUTPUT_IMMUNE_KINDS-confirmed attention flag (a "needs permission"
// notification) via a real keystroke — a false positive here would silently
// dismiss a pending permission prompt the user never actually answered,
// exactly the bug this hardening pass fixes. Each regex matches one COMPLETE
// automated-reply shape; isGenuineUserInput() strips every match and treats
// a nonempty remainder as genuine. This is a denylist, not an allowlist of
// printable bytes, deliberately: Ctrl-C, Esc, arrow keys, and bracketed-paste
// content must all still count as a real decision.
// eslint-disable-next-line no-control-regex
const FOCUS_REPORT = /\x1b\[[IO]/g; // DECSET ?1004 focus in/out report
// eslint-disable-next-line no-control-regex
const X10_MOUSE_REPORT = /\x1b\[M[\s\S]{3}/g; // legacy X10 mouse report (3 fixed data bytes)
// eslint-disable-next-line no-control-regex
const SGR_MOUSE_REPORT = /\x1b\[<\d+;\d+;\d+[Mm]/g; // SGR (?1006) mouse report
// eslint-disable-next-line no-control-regex
const CURSOR_POSITION_REPORT = /\x1b\[\d+;\d+R/g; // CPR
// eslint-disable-next-line no-control-regex
const DEVICE_ATTRIBUTES_REPLY = /\x1b\[>?\??[\d;]*c/g; // primary/secondary DA reply
// TerminalPane.tsx's OSC 10/11/12 color-query reply (the `rgb:` form) and its
// theme-toggle color SET push (the `#rrggbb` form) share this same OSC-ident
// shape — see that file's oscColorSubs handler and its settings-sync effect.
// eslint-disable-next-line no-control-regex
const OSC_COLOR_REPLY = /\x1b\](?:10|11|12);[^\x07\x1b]*(?:\x07|\x1b\\)/g;
// TerminalPane.tsx's DEC "color scheme update" notification, bundled into the
// same write() as OSC_COLOR_REPLY's SET-push form on every theme toggle.
// eslint-disable-next-line no-control-regex
const COLOR_SCHEME_NOTIFICATION = /\x1b\[\?997;[12]n/g;

const AUTO_REPORT_SHAPES: ReadonlyArray<RegExp> = [
  FOCUS_REPORT,
  X10_MOUSE_REPORT,
  SGR_MOUSE_REPORT,
  CURSOR_POSITION_REPORT,
  DEVICE_ATTRIBUTES_REPLY,
  OSC_COLOR_REPLY,
  COLOR_SCHEME_NOTIFICATION,
];

/**
 * Strips every known automated terminal-protocol reply/push from `data` and
 * reports whether anything survives — see the block comment above for why
 * this must be a strict denylist rather than USER_INPUT_ECHO_MS's more
 * tolerant timing heuristic. Used only to gate Session.write()'s
 * authoritative "userInput" attention-clear signal (see below).
 */

export function isGenuineUserInput(data: string): boolean {
  // Every AUTO_REPORT_SHAPES entry starts with ESC, so ESC-free input (the
  // overwhelmingly common case: plain typed characters) has nothing to strip.
  if (!data.includes("\x1b")) return data.length > 0;
  let remainder = data;
  for (const shape of AUTO_REPORT_SHAPES) {
    remainder = remainder.replace(shape, "");
  }
  return remainder.length > 0;
}
