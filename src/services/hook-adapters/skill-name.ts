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
const DANGEROUS_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);
// eslint-disable-next-line no-control-regex -- deliberately matching C0 controls + DEL
const CONTROL_CHARACTER_RE = /[\x00-\x1f\x7f]/;

export class InvalidSkillNameError extends Error {
  constructor(name: string) {
    super(`Refusing to use "${name}" as a skill name`);
    this.name = "InvalidSkillNameError";
  }
}

export function assertSafeSkillName(name: string): void {
  if (DANGEROUS_PROPERTY_NAMES.has(name) || CONTROL_CHARACTER_RE.test(name)) {
    throw new InvalidSkillNameError(name);
  }
}
