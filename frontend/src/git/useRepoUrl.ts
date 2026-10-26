import { useDashboardStore } from "../store/index.js";

/**
 * The project's GitHub repo URL. No repo URL is stored on the project, so any
 * PR's link carries it; null until one is known.
 */
export function useRepoUrl(projectId: number): string | null {
  return useDashboardStore((s) => {
    const m = s.prsByProject[projectId]?.prs[0]?.htmlUrl.match(
      /^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\//,
    );
    return m ? (m[1] ?? null) : null;
  });
}
