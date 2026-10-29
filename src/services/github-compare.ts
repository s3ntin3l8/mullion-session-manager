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
  if (value !== null) {
    // Every push mints a new key, so drop what has expired as we go.
    const now = Date.now();
    for (const [k, v] of behindByCache) if (now - v.at >= BEHIND_BY_TTL_MS) behindByCache.delete(k);
    behindByCache.set(key, { value, at: now });
  }
  return value;
}

/**
 * The memoised answer for exactly this head, without asking GitHub. Used when a
 * failed list query restores an older snapshot: the answer is only good for the
 * head it was read for, so it is looked up by head, never carried on the PR.
 */
export function peekBehindBy(
  owner: string,
  repo: string,
  base: string,
  headSha: string,
): number | undefined {
  const hit = behindByCache.get(`${owner}/${repo}|${base}|${headSha}`);
  return hit && Date.now() - hit.at < BEHIND_BY_TTL_MS ? hit.value : undefined;
}

/** Test seam: forget memoised compares. */
export function resetBehindByCache(): void {
  behindByCache.clear();
}
