import type { LinkBufferSource } from "./terminalLinks.js";

// Terminal links for file PATHS (`src/foo.ts`, `./.env`, `src/foo.ts:42:7`) —
// a sibling of terminalLinks.ts's URL provider, deliberately simpler: single
// buffer row only (an agent's path output is short and rarely hard-wrapped),
// and conservative — a token only links when it plainly names a FILE, because
// an underline on every `a/b` in build output would be noise, and activating
// one opens an editor pane. Existence is not checked here (the buffer can't
// know); the editor panel reports a missing file itself.

export interface PathLink {
  /** 0-indexed inclusive start column. */
  startCol: number;
  /** 0-indexed exclusive end column. */
  endCol: number;
  /** The text as printed, including any `:line[:col]` suffix. */
  text: string;
  /** The path part only (suffix and trailing punctuation removed). */
  path: string;
  line?: number;
  col?: number;
}

// Characters that end a token. Quotes/brackets are separators so
// `"src/a.ts"` and `(src/a.ts:3)` link just the path.
const TOKEN_RE = /[^\s"'`()<>[\]{},;|*?$=\\]+/g;
const SUFFIX_RE = /:(\d+)(?::(\d+))?$/;
const TRAILING_PUNCT_RE = /[.:!]+$/;

const KNOWN_EXTENSIONS = new Set(
  (
    "ts tsx js jsx mjs cjs json jsonc md mdx yml yaml toml env py go rs rb java kt kts swift c h cpp hpp cc cs " +
    "sh bash zsh css scss sass less html htm vue svelte sql txt lock xml ini cfg conf gradle properties " +
    "dockerfile tf php lua ex exs erl hs ml scala dart r pl"
  ).split(" "),
);
const KNOWN_BARE_NAMES = new Set([
  "makefile",
  "dockerfile",
  "license",
  "procfile",
  "gemfile",
  "rakefile",
  "readme",
  "changelog",
]);

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : null;
}

/** Whether `candidate` (suffix/punctuation already stripped) looks like a
 * file path worth linking. */
export function looksLikeFilePath(candidate: string): boolean {
  if (candidate.length < 2 || candidate.length > 300) return false;
  if (candidate.includes("://") || candidate.startsWith("~") || candidate.startsWith("-")) {
    return false;
  }
  if (candidate.startsWith("//") || candidate.endsWith("/")) return false;
  if (!/^[\w@+./-]+$/.test(candidate)) return false;
  if (/^\.+$/.test(candidate) || /^\d+(\.\d+)+$/.test(candidate)) return false;

  const segments = candidate.split("/");
  const name = segments[segments.length - 1];
  if (name === "" || name === "." || name === "..") return false;
  const ext = extensionOf(name);
  const isDotfile = name.startsWith(".") && name.length > 1 && !name.startsWith("..");
  const isKnownBare = KNOWN_BARE_NAMES.has(name.toLowerCase());

  if (segments.length === 1) {
    // Bare name: only a recognised extension, a dotfile, or a well-known
    // extensionless file — otherwise `e.g.`, `v1.2`, `foo.bar` all link.
    return (ext !== null && KNOWN_EXTENSIONS.has(ext)) || isDotfile || isKnownBare;
  }
  // `github.com/org/repo.git`-style host prefixes are not local paths.
  const first = segments[0];
  if (/^[a-z0-9-]+\.[a-z]{2,}$/i.test(first) && first !== "." && first !== "..") return false;
  return ext !== null || isDotfile || isKnownBare;
}

/** Path links on buffer row `y` (0-indexed). */
export function computePathLinksForRow(buf: LinkBufferSource, y: number): PathLink[] {
  const line = buf.getLine(y);
  if (!line) return [];
  const text = line.translateToString(true);
  if (!text) return [];

  const links: PathLink[] = [];
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(text))) {
    const startCol = match.index;
    // Sentence punctuation after the token ("see src/a.ts." / "src/a.ts:")
    // is not part of it; a `:line` suffix ends in digits so it survives.
    const printed = match[0].replace(TRAILING_PUNCT_RE, "");
    let candidate = printed;
    let lineNo: number | undefined;
    let colNo: number | undefined;
    const suffix = SUFFIX_RE.exec(candidate);
    if (suffix) {
      lineNo = Number(suffix[1]);
      colNo = suffix[2] ? Number(suffix[2]) : undefined;
      candidate = candidate.slice(0, suffix.index);
    }
    if (!looksLikeFilePath(candidate)) continue;
    links.push({
      startCol,
      endCol: startCol + printed.length,
      text: printed,
      path: candidate,
      line: lineNo,
      col: colNo,
    });
  }
  return links;
}
