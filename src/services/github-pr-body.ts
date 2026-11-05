// A PR's description, read and replaced. Kept out of github-write.ts (a size-ratcheted
// file); it reuses that file's request helper, so the same rate-limit and write-scope
// handling applies.
import { githubRequest } from "./github-write.js";

/**
 * A PR's description, for a caller that edits one section of it
 * (`task-decisions.ts`'s worker-decisions section) and must not clobber the
 * rest. GitHub returns `null` for an empty body.
 */
export async function getPullRequestBody(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<string> {
  const result = await githubRequest<{ body: string | null }>(
    token,
    owner,
    repo,
    "GET",
    `/pulls/${number}`,
  );
  return result.body ?? "";
}

/** Replaces a PR's description; same endpoint as `updatePullRequestTitle`. */
export async function updatePullRequestBody(
  token: string,
  owner: string,
  repo: string,
  number: number,
  body: string,
): Promise<void> {
  await githubRequest(token, owner, repo, "PATCH", `/pulls/${number}`, { body });
}
