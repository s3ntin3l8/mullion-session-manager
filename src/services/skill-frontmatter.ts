// The frontmatter parser for a SKILL.md / agent / command file: a
// deliberately minimal, hand-rolled reader for the flat scalar fields those
// files carry.
//
// It lives in its own module because the bundle managers need it
// (src/services/hook-adapters/mullion-bundle.ts), and they used to import
// skills.ts for it — while skills.ts imports the bundle managers back. That
// is an import cycle between the skill discovery service and the adapters
// that write the bundle (issue #2414).
//
// skills.ts re-exports the parser, so every existing importer keeps its
// path.

export interface ParsedFrontmatter {
  name: string;
  description: string;
  /**
   * Issue #1731 — the `opencode-model:` key: the model a project's reviewer
   * subagent should run on under opencode, as `provider/model`.
   *
   * A SEPARATE key, not the plain `model:`, because the frontmatter blob is
   * shared by all four CLIs and Claude Code's copy is passed through
   * VERBATIM (it is that CLI's native agent format, where `model:` IS a
   * first-class key with its own meaning — "inherit" matches the spawning
   * conversation). opencode's `agents.<name>.model` accepts only
   * `provider/model` (or `provider/model#variant`): a bare Claude alias does
   * not match, so the two CLIs need different values from the same source
   * document. A dedicated key keeps them apart.
   */
  opencodeModel?: string;
}

function stripYamlScalarQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

// A deliberately minimal, hand-rolled parser for exactly the two flat
// scalar fields a SKILL.md/agent/command frontmatter block can carry (name,
// description — see the plan's verified format: "YAML frontmatter (name,
// description required) plus a Markdown body"). Not a general YAML parser:
// this repo has no YAML dependency, and pulling one in for two string
// fields would be the wrong trade for a read-only discovery slice. A
// block-scalar description (`description: |` / `description: >`) is
// deliberately treated as unparseable rather than mis-captured as the
// literal "|"/">" character — such an entry is skipped (see the callers),
// same as any other malformed frontmatter. Returns `{name, description}`
// with either possibly `null` — callers (parseSkillFrontmatter,
// parseAgentOrCommandFrontmatter) decide which fields are actually required
// for their kind; a command's `name` is optional (see the latter's own
// comment), everything else requires both.
function parseFlatFrontmatterFields(
  raw: string,
): { name: string | null; description: string | null; opencodeModel: string | null } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return null;

  let name: string | null = null;
  let description: string | null = null;
  // Issue #1731 — the `opencode-model:` key. See ParsedFrontmatter's own
  // comment for why it is a separate key from the plain `model:`.
  let opencodeModel: string | null = null;
  for (const line of match[1].split(/\r?\n/)) {
    // CodeQL (js/polynomial-redos), PR #894 — `\s*(.*)$` overlaps `\s` and
    // `.` on the same input, a superlinear-backtracking shape newly
    // reachable from arbitrary HTTP-body text once PR-894's project-skill/
    // reviewer-agent write routes started feeding attacker-controlled
    // content through this parser (every prior caller only ever ran it
    // against committed/discovered skill files). Dropping the `\s*` is
    // behavior-preserving, not just a workaround: `kv[2].trim()` right
    // below already strips exactly the leading whitespace `\s*` used to
    // consume, so capturing it into the group and trimming it afterward
    // produces the identical `value`.
    // `name`/`description` keep the original strict pattern; the new
    // `opencode-model` key ALSO tolerates whitespace before its colon, so it
    // parses exactly what stripOpenCodeModelKey removes. Without that
    // alignment a valid-YAML `opencode-model : x` would be stripped from
    // Claude Code's copy and never parsed at all — a silent no-op, with no
    // model and no warning.
    const kv = /^(?:(name|description):(.*)|(opencode-model)\s*:(.*))$/.exec(line);
    if (!kv) continue;
    const value = (kv[2] ?? kv[4]).trim();
    if (/^[|>][+-]?\d?$/.test(value)) continue; // block-scalar indicator, unsupported
    const unquoted = stripYamlScalarQuotes(value);
    if (unquoted.length === 0) continue;
    const key = kv[1] ?? kv[3];
    if (key === "name" && name === null) name = unquoted;
    if (key === "description" && description === null) description = unquoted;
    if (key === "opencode-model" && opencodeModel === null) opencodeModel = unquoted;
  }
  return { name, description, opencodeModel };
}

// Exported so a guard test can assert Mullion's own shipped bundle skills
// (src/bundle/skills/) actually parse under this exact parser, rather than
// just "looking like" valid frontmatter — a bundle edit that silently broke
// discovery would otherwise only surface live, against a real Claude Code
// session.
export function parseSkillFrontmatter(raw: string): ParsedFrontmatter | null {
  const parsed = parseFlatFrontmatterFields(raw);
  if (!parsed?.name || !parsed.description) return null;
  const result: ParsedFrontmatter = { name: parsed.name, description: parsed.description };
  // Issue #1731 — carried through only when present, so a frontmatter block
  // without the key parses to exactly the same object it did before.
  if (parsed.opencodeModel !== null) result.opencodeModel = parsed.opencodeModel;
  return result;
}

// Issue #885 — a subagent file (kind "agent") needs both fields, same as a
// skill (Claude Code's own `.claude/agents/*.md` format is name+description
// frontmatter, verified against this repo's own `mullion-reviewer.md`). A
// command file (kind "command") does NOT: verified against real
// `~/.claude/commands/*.md` files that a slash command's own `name:` key is
// commonly just absent — Claude Code names a command by its FILENAME, not
// its frontmatter — so `fallbackName` (the file's basename, sans `.md`) is
// used whenever frontmatter carries no name of its own. `description` is
// still required either way; a command/agent file with no description at
// all is skipped, same as a skill with malformed frontmatter.
export function parseAgentOrCommandFrontmatter(
  raw: string,
  kind: "agent" | "command",
  fallbackName: string,
): ParsedFrontmatter | null {
  const parsed = parseFlatFrontmatterFields(raw);
  if (!parsed?.description) return null;
  if (kind === "agent" && !parsed.name) return null;
  return { name: parsed.name ?? fallbackName, description: parsed.description };
}
