// How far a PR head is behind its base, via the REST compare. Its own module
// because both the PR detail read and the list enrichment
// (github-pr-reviews.ts) need it, and detail already imports from reviews.

import { githubApiFetch } from "./github-fetch.js";

/** How far the head is behind the base; null when GitHub cannot say. */
export async function fetchBehindBy(
  token: string,
  owner: string,
  repo: string,
  base: string,
  headSha: string,
): Promise<number | null> {
  try {
    const res = await githubApiFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(headSha)}?per_page=1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    const raw = (await res.json()) as { behind_by?: unknown };
    return typeof raw.behind_by === "number" ? raw.behind_by : null;
  } catch {
    return null;
  }
}

// A head SHA fixes the answer until the base moves, so a poll must not repeat
// the call; the TTL picks up a moved base.
const BEHIND_BY_TTL_MS = 5 * 60_000;
const behindByCache = new Map<string, { value: number; at: number }>();

/** `fetchBehindBy`, memoised per repo/base/head. Only a real answer is kept. */
export async function cachedBehindBy(
  token: string,
  owner: string,
  repo: string,
  base: string,
  headSha: string,
): Promise<number | null> {
  const key = `${owner}/${repo}|${base}|${headSha}`;
  const hit = behindByCache.get(key);
  if (hit && Date.now() - hit.at < BEHIND_BY_TTL_MS) return hit.value;
  const value = await fetchBehindBy(token, owner, repo, base, headSha);
  if (value !== null) behindByCache.set(key, { value, at: Date.now() });
  return value;
}

/** Test seam: forget memoised compares. */
export function resetBehindByCache(): void {
  behindByCache.clear();
}
