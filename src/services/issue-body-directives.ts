// Issue-body directives (`Host:`, `Platform:`, `Agent:`, `Model:`, `Manual:`,
// ...) are matched with line-anchored regexes. A code snippet quoted in a spec
// (`host: app.config.HOST,` inside a TypeScript block, a YAML sample) must not
// be read as one, so every directive parser matches against
// `stripFencedCode(body)` instead of the raw body (#3104).

const OPEN_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The body with every fenced code block (``` or ~~~, fences included) blanked
 * out. Line count is preserved. A fence closes on a line of the same character,
 * at least as long as the opener and with nothing after it; an unterminated
 * fence blanks to the end of the body.
 */
export function stripFencedCode(body: string): string {
  if (!body.includes("```") && !body.includes("~~~")) return body;
  let fence: string | null = null;
  return body
    .split("\n")
    .map((line) => {
      if (fence === null) {
        const open = OPEN_FENCE_RE.exec(line);
        if (open === null) return line;
        // A backtick fence's info string may not contain a backtick (inline code).
        if (open[1][0] === "`" && line.slice(open[0].length).includes("`")) return line;
        fence = open[1];
        return "";
      }
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close !== null && close[1][0] === fence[0] && close[1].length >= fence.length) {
        fence = null;
      }
      return "";
    })
    .join("\n");
}
