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

/** The live session already working this issue: one whose worktree branch is
 *  the `issue-<n>-<slug>` branch "Start session" creates. */
export function findIssueSession<S extends { projectId: number; liveBranch: string | null }>(
  sessions: readonly S[],
  projectId: number,
  issue: { number: number; title: string },
): S | undefined {
  const branch = issueBranchName(issue);
  return sessions.find((s) => s.projectId === projectId && s.liveBranch === branch);
}
