// Issue #2933 — a restructure that drops the repo's command table should be
// visible before Apply. The conflict is about AGENTS.md and carries no
// disposition: a disposition on CLAUDE.md is what allows that file to shrink,
// and this check must not look like one.

// Only a backticked token counts. A bare "make sure" / "make it" in a list
// or table cell is prose, and it used to flip the half-kept rule.
const COMMAND_TOKEN = String.raw`(?:make\s+[A-Za-z0-9_.:-]+|npm\s+run\s+[A-Za-z0-9_.:-]+)`;
const BACKTICK_COMMAND_RE = new RegExp(String.raw`\`${COMMAND_TOKEN}\``, "g");

export interface CommandsConflict {
  file: string;
  excerpt: string;
  kind: string;
  note: string;
}

function isCommandLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("|")) {
    const cells = trimmed.replace(/\|/g, "");
    return cells.trim().length > 0 && !/^[:\-\s]+$/.test(cells);
  }
  return /^\s*(?:[-*+]|\d+\.)\s+\S/.test(line);
}

function addBackticked(found: Set<string>, text: string): void {
  BACKTICK_COMMAND_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BACKTICK_COMMAND_RE.exec(text)) !== null) {
    found.add(match[0].replace(/[`\s]+/g, " ").trim());
  }
}

/** Backticked `make <target>` / `npm run <script>` tokens from markdown
 * tables and lists. Unfenced "make <word>" is prose and is ignored. */
export function repoCommands(text: string): string[] {
  const found = new Set<string>();
  for (const line of text.split("\n")) {
    if (!isCommandLine(line)) continue;
    addBackticked(found, line);
  }
  return [...found];
}

function covers(rewritten: string, command: string): boolean {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\w.-])${escaped}(?![\\w.-])`).test(rewritten);
}

/** A panel conflict when the rewritten AGENTS.md keeps fewer than half of the
 * command-table entries from the original AGENTS.md / CLAUDE.md. Exactly half
 * is kept quiet. No disposition: this must not unlock a CLAUDE.md reduction. */
export function commandsTableConflict(
  originals: Array<string | null | undefined>,
  rewritten: string | undefined,
): CommandsConflict | undefined {
  if (!rewritten) return undefined;
  const commands = repoCommands(
    originals.filter((text): text is string => Boolean(text)).join("\n"),
  );
  if (commands.length === 0) return undefined;
  const kept = commands.filter((command) => covers(rewritten, command));
  if (kept.length * 2 >= commands.length) return undefined;
  const dropped = commands.filter((command) => !kept.includes(command));
  return {
    file: "AGENTS.md",
    excerpt: dropped.join(", ").slice(0, 200),
    kind: "commands",
    note: "The rewrite covers fewer than half of the repo's command table or list. Keep it in AGENTS.md.",
  };
}
