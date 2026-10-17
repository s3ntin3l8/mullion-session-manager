// Issue #1637: a path pasted into the terminal is typed text, so a cwd with a
// space (or any shell metacharacter) would split into several arguments.
// Backslash-escaping the unsafe characters matches what native terminals
// insert when a file is dropped on them, and works in a shell and the
// hosted CLIs' prompts alike. A path made only of safe characters is
// returned untouched so every ordinary paste stays byte-identical.
const SAFE_PATH = /^[A-Za-z0-9._/@%+=:,-]+$/;

export function quotePastedPath(p: string): string {
  if (SAFE_PATH.test(p)) return p;
  // `u`: match whole code points, so an astral character (emoji) is escaped
  // as one unit rather than split between its surrogate halves.
  return p.replace(/[^A-Za-z0-9._/@%+=:,-]/gu, "\\$&");
}
