// Per-file diff line (issue #262, follow-up to #177) — one line of a unified
// diff patch, classified for styling.
export interface DiffLine {
  type: "add" | "del" | "hunk" | "file" | "context";
  text: string;
}

export function parseUnifiedDiff(patch: string): DiffLine[] {
  if (!patch) return [];
  const lines: DiffLine[] = [];
  const cleanPatch = patch.replace(/\r?\n$/, "");
  for (const raw of cleanPatch.split(/\r?\n/)) {
    if (raw.startsWith("+")) {
      lines.push({ type: raw.startsWith("+++ ") ? "file" : "add", text: raw });
    } else if (raw.startsWith("-")) {
      lines.push({ type: raw.startsWith("--- ") ? "file" : "del", text: raw });
    } else if (raw.startsWith("@@")) {
      lines.push({ type: "hunk", text: raw });
    } else if (raw.startsWith("diff --git")) {
      lines.push({ type: "file", text: raw });
    } else {
      lines.push({ type: "context", text: raw });
    }
  }
  return lines;
}
