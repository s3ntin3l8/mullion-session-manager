import type { GitDecoration } from "../lib/treeGitDecorations.js";

// The marker a file-tree row wears for its git status: a coloured letter (the
// letter, not just the colour, carries the meaning) with the status as tooltip.
export function GitBadge({ decoration }: { decoration: GitDecoration | null }) {
  if (decoration === null) return null;
  return (
    <span
      className={`file-git-badge git-s-${decoration.kind}`}
      title={decoration.label}
      role="img"
      aria-label={decoration.label}
    >
      {decoration.letter}
    </span>
  );
}
