import type { Tone } from "../lib/statusTone.js";

export interface RefChip {
  /** Unique within a commit. */
  key: string;
  /** Branch / tag name, remote prefix stripped. */
  label: string;
  kind: "head" | "tag" | "remote" | "branch";
  tone: Tone;
  /** The local branch and its remote counterpart sit on this commit. */
  synced: boolean;
  /** Branch name to look a pull request up by (undefined for tags). */
  prBranch?: string;
  /** The raw refs this chip stands for, for the tooltip / expanded row. */
  raw: string[];
}

const KIND_ORDER: Record<RefChip["kind"], number> = { head: 0, branch: 1, tag: 2, remote: 3 };

/** `origin/x` -> `x`; a ref that is not a known remote branch is returned as is. */
export function stripRemote(ref: string, remotes: ReadonlySet<string>): string {
  if (!remotes.has(ref) && !ref.startsWith("origin/")) return ref;
  const slash = ref.indexOf("/");
  return slash === -1 ? ref : ref.slice(slash + 1);
}

/**
 * Turns a commit's decorations into display chips: `origin/x` and `x` on the
 * same commit collapse into one "synced" chip, `HEAD -> x` becomes the head
 * chip, and every chip carries the branch name a PR can be matched on (the
 * remote prefix stripped, so a remote-only ref still finds its PR).
 */
export function buildRefChips(refs: readonly string[], remotes: ReadonlySet<string>): RefChip[] {
  const chips = new Map<string, RefChip>();
  for (const raw of refs) {
    if (raw === "HEAD" || raw.endsWith("/HEAD")) continue;
    if (raw.startsWith("tag: ")) {
      const label = raw.slice("tag: ".length);
      chips.set(`tag:${label}`, {
        key: `tag:${label}`,
        label,
        kind: "tag",
        tone: "warn",
        synced: false,
        raw: [raw],
      });
      continue;
    }
    const isHead = raw.startsWith("HEAD -> ");
    const name = isHead ? raw.slice("HEAD -> ".length) : raw;
    const isRemote = !isHead && (remotes.has(name) || name.startsWith("origin/"));
    const label = isRemote ? stripRemote(name, remotes) : name;
    const existing = chips.get(`b:${label}`);
    if (existing) {
      // Same branch seen twice (local + remote): one chip, marked synced.
      existing.synced = true;
      existing.raw.push(raw);
      if (isHead) {
        existing.kind = "head";
        existing.tone = "info";
      } else if (!isRemote && existing.kind === "remote") {
        existing.kind = "branch";
        existing.tone = "success";
      }
      continue;
    }
    chips.set(`b:${label}`, {
      key: `b:${label}`,
      label,
      kind: isHead ? "head" : isRemote ? "remote" : "branch",
      tone: isHead ? "info" : isRemote ? "neutral" : "success",
      synced: false,
      prBranch: label,
      raw: [raw],
    });
  }
  return [...chips.values()].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}
