// Cited-path check for a scaffold generation turn (issues #1145, #2532, #2932).
//
// Split out of scaffold-generate.ts so that file stays under the line ceiling.
// The marker strings match that module's section markers; a drift would make
// the remote snapshot look at different text than the primary parses.
import fs from "node:fs";
import path from "node:path";

const SKILL_START = "<<<MULLION_SKILL_START>>>";
const SKILL_END = "<<<MULLION_SKILL_END>>>";
const REVIEWER_START = "<<<MULLION_REVIEWER_START>>>";
const REVIEWER_END = "<<<MULLION_REVIEWER_END>>>";
const REGION_START = "<<<MULLION_SCAFFOLD_REGION_START>>>";
const REGION_END = "<<<MULLION_SCAFFOLD_REGION_END>>>";

/** Paths Mullion's scaffold writes: absent from the worktree until applied. */
const SCAFFOLD_OUTPUT_PATH = /^\.claude\/(?:skills|agents)\//;

/** Cited-path existence counts (issue #2532). */
export interface MissingCitedPaths {
  missing: number;
  cited: number;
}

interface CitedText {
  skill?: string;
  reviewer?: string;
  scaffoldRegion: string;
}

/**
 * Post-generation heuristic (issue #1145). Flags content that cites
 * plausible repo paths of which fewer than half exist in the directory the
 * agent actually read (issue #2532, #2932) — the scratch worktree, not a
 * checkout that may be behind origin. `.claude/(skills|agents)/` paths are
 * excluded. `existence`, when passed, replaces `existsSync` under `cwd`
 * (the remote host snapshots the worktree before tearing it down). A
 * signal, not a hard failure.
 */
export function validateGenerationOutput(
  content: CitedText,
  cwd: string,
  existence?: ReadonlyMap<string, boolean>,
): {
  possiblyGeneric: boolean;
  referencedPaths: string[];
  missingCitedPaths?: MissingCitedPaths;
} {
  const collected = collectCitedPaths(content);
  if (collected.kind === "none") return { possiblyGeneric: false, referencedPaths: [] };
  if (collected.kind === "implausible") return { possiblyGeneric: true, referencedPaths: [] };
  const { plausible, checkable } = collected;
  const missing = checkable.filter((p) => !citedPathExists(p, cwd, existence)).length;
  const existing = checkable.length - missing;
  return {
    possiblyGeneric: checkable.length > 0 && existing * 2 < checkable.length,
    referencedPaths: plausible,
    ...(missing > 0 ? { missingCitedPaths: { missing, cited: checkable.length } } : {}),
  };
}

function citedPathExists(
  cited: string,
  cwd: string,
  existence: ReadonlyMap<string, boolean> | undefined,
): boolean {
  if (existence) return existence.get(cited) === true;
  return fs.existsSync(path.join(cwd, cited));
}

type CollectedCitedPaths =
  | { kind: "none" }
  | { kind: "implausible" }
  | { kind: "paths"; plausible: string[]; checkable: string[] };

function collectCitedPaths(content: CitedText): CollectedCitedPaths {
  const allText = `${content.skill ?? ""}\n${content.reviewer ?? ""}\n${content.scaffoldRegion}`;
  const referencedPaths = new Set<string>();
  const pathPattern =
    /(?:^|\s|`|\()([A-Za-z0-9_/.-]+\.(?:ts|js|mjs|tsx|jsx|json|md|yaml|yml|toml|sh))\b/g;
  let match;
  while ((match = pathPattern.exec(allText)) !== null) referencedPaths.add(match[1]);
  if (referencedPaths.size === 0) return { kind: "none" };

  const plausible = [...referencedPaths].filter((p) => {
    if (p.includes("..") || path.isAbsolute(p)) return false;
    const segments = p.split("/");
    if (segments.length === 1) return false;
    if (segments.some((s) => /^(example|sample|placeholder|foo|bar|baz)$/i.test(s))) return false;
    if (/^src\/example\//i.test(p)) return false;
    if (segments.length >= 3) return true;
    if (segments.length === 2 && /^(src|lib|test|tests|docs|config)$/i.test(segments[0])) {
      return true;
    }
    return false;
  });
  if (plausible.length === 0) return { kind: "implausible" };
  return {
    kind: "paths",
    plausible,
    checkable: plausible.filter((p) => !SCAFFOLD_OUTPUT_PATH.test(p)),
  };
}

function lenientSection(raw: string, start: string, end: string): string | undefined {
  const startIdx = raw.indexOf(start);
  if (startIdx === -1) return undefined;
  const contentStart = startIdx + start.length;
  const endIdx = raw.indexOf(end, contentStart);
  if (endIdx === -1) return undefined;
  const content = raw.slice(contentStart, endIdx).trim();
  return content.length > 0 ? content + "\n" : undefined;
}

/** Cited paths in `root`, from the agent's raw stdout, before the worktree
 * is torn down (issue #2932). Does not throw on a malformed turn. */
export function snapshotCitedPathExistence(
  root: string,
  raw: string,
): Array<{ path: string; exists: boolean }> {
  const collected = collectCitedPaths({
    skill: lenientSection(raw, SKILL_START, SKILL_END),
    reviewer: lenientSection(raw, REVIEWER_START, REVIEWER_END),
    scaffoldRegion: lenientSection(raw, REGION_START, REGION_END) ?? "",
  });
  if (collected.kind !== "paths") return [];
  return collected.checkable.map((p) => ({
    path: p,
    exists: fs.existsSync(path.join(root, p)),
  }));
}
