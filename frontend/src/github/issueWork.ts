/** `issue-<n>-<slug>`: a readable, ref-safe branch name for a worktree. */
export function issueBranchName(issue: { number: number; title: string }): string {
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `issue-${issue.number}${slug ? `-${slug}` : ""}`;
}

export function issueSeedPrompt(issue: { number: number; title: string; htmlUrl: string }): string {
  return (
    `Work on GitHub issue #${issue.number}: ${issue.title}\n${issue.htmlUrl}\n\n` +
    `Read the full issue and its comments first (\`gh issue view ${issue.number} --comments\`), ` +
    `then implement it on this branch.`
  );
}

/**
 * Live sessions by the issue they work, keyed on the immutable `issue-<n>`
 * prefix of the worktree branch (the slug drifts when the title is edited).
 * Like the sidebar rows, a worktree session's branch is the poll-derived git
 * status first — opencode's hook-reported `liveBranch` is the main checkout's.
 */
export function indexIssueSessions<
  S extends { id: number; projectId: number; liveBranch: string | null },
>(
  sessions: readonly S[],
  gitStatuses: Readonly<Record<number, { branch?: string | null } | null | undefined>>,
  projectId: number,
): Map<number, S> {
  const byIssue = new Map<number, S>();
  for (const s of sessions) {
    if (s.projectId !== projectId) continue;
    for (const branch of [gitStatuses[s.id]?.branch, s.liveBranch]) {
      const m = branch ? /^issue-(\d+)(?:-|$)/.exec(branch) : null;
      if (m && !byIssue.has(Number(m[1]))) byIssue.set(Number(m[1]), s);
    }
  }
  return byIssue;
}
