// Issue #463 — a shared guard for both writers (codex-skills.ts,
// opencode-skills.ts). `name` reaching either writer ultimately originates
// from an HTTP request body. In normal operation it's already constrained
// to an actually-discovered skill's frontmatter `name` — skills.ts's
// `resolveSkillForToggle` only matches an already-parsed skill, and
// `parseSkillFrontmatter`'s per-line regex can never capture a raw newline
// — but both writers validate independently rather than trusting that
// invariant, so a static analyzer (and any future caller that bypasses
// `toggleSkillEnabled`) sees the actual sink itself guarded, not just an
// upstream caller. Two concrete classes this closes:
//
// 1. `__proto__`/`constructor`/`prototype` used as an object property key
//    (opencode-skills.ts's `skill[name] = ...` / `delete skill[name]`) —
//    CodeQL's js/remote-property-injection. Not exploitable today (`{
//    ...existingSkill }` spreads onto a plain object, and `__proto__`'s
//    accessor silently no-ops for a non-object assignment like `"deny"`),
//    but refusing the dangerous keys outright is the correct posture
//    regardless of today's exact (non-)exploitability — this is the class
//    of bug that becomes exploitable the moment someone innocently changes
//    `"deny"` to an object-shaped value in a later edit.
// 2. A raw control character (most importantly a literal newline) reaching
//    codex-skills.ts's TOML writer — `escapeTomlBasicString` only escapes
//    `\` and `"`, not control characters, so an unescaped newline embedded
//    in a `name = "..."` line would write a value spanning two physical
//    lines: syntactically invalid TOML that a subsequent read (smol-toml or
//    this repo's own line-based marker scan) can't correctly round-trip.
// Exported (not just wrapped in a function) so callers can inline the check
// immediately next to their own sink — CodeQL, PR #469: a call to
// `assertSafeSkillName` alone, even called before every use of `name`, was
// NOT recognized as a barrier by js/remote-property-injection or the
// tainted-file-write query (both still fired on the exact same lines after
// that fix). Both writers now inline this same check directly guarding
// their own sink, which is the pattern those queries' dataflow analysis
// does recognize.
export const DANGEROUS_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);
// eslint-disable-next-line no-control-regex -- deliberately matching C0 controls + DEL
export const CONTROL_CHARACTER_RE = /[\x00-\x1f\x7f]/;
// Hermes review, PR #894 — this guard's ORIGINAL two checks above assumed
// `name` was only ever used as an OBJECT KEY (opencode-skills.ts's
// `skill[name] = ...`) or a fixed-depth DIRECTORY NAME under an
// already-fully-resolved parent (codex.ts/agy.ts's installBundleSkills,
// TOGGLE callers matched against an already-discovered skill on disk).
// PR-894 added a THIRD kind of caller (mullion-bundle.ts's
// composeClaudeSessionBundle, opencode.ts's project-skill wiring) that
// derives `name` from a project's own, arbitrary, HTTP-body-authored
// frontmatter and joins it straight into a path:
// `path.join(destDir, "skills", name, "SKILL.md")`. Neither prior check
// rejects `/`, `\`, or `..` — a frontmatter `name: ../../x` sailed through
// write-time validation and, at spawn time (on remote hosts too, since this
// content rides the ordinary spawn body), resolved OUTSIDE the intended
// per-session directory entirely. `/` and `\` cover POSIX and Windows
// separators alike (this repo's release story includes both); `.`/`..`
// are rejected explicitly since a single traversal segment contains no
// separator by itself.
const PATH_SEPARATOR_RE = /[/\\]/;

export class InvalidSkillNameError extends Error {
  constructor(name: string) {
    super(`Refusing to use "${name}" as a skill name`);
    this.name = "InvalidSkillNameError";
  }
}

export function isDangerousSkillName(name: string): boolean {
  return (
    DANGEROUS_PROPERTY_NAMES.has(name) ||
    CONTROL_CHARACTER_RE.test(name) ||
    PATH_SEPARATOR_RE.test(name) ||
    name === "." ||
    name === ".."
  );
}

/** Kept for the toggleSkillEnabled entry point (skills.ts), which isn't
 * itself a CodeQL sink — an early, clean rejection there before a bad name
 * even reaches discovery or either writer. Both writers additionally inline
 * `isDangerousSkillName` directly at their own sink (see this file's header)
 * rather than relying on this call alone. */
export function assertSafeSkillName(name: string): void {
  if (isDangerousSkillName(name)) throw new InvalidSkillNameError(name);
}
