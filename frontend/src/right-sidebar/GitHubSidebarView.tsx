import { useEffect, useState } from "react";
import { GitHubPanel } from "../GitHubPanel.js";
import { SidebarHeader } from "./SidebarHeader.js";
import { VIEW_TITLES } from "./viewTitles.js";
import { usePrList } from "../hooks/useGitHubData.js";
import { useDashboardStore } from "../store/index.js";
import { RefreshIcon } from "../ui/icons.js";
import { ExternalLinkOwnedContext } from "../ui/sidebar/index.js";
import type { RightSidebarViewProps } from "./views.js";

// How long Refresh stays visibly busy at least (the server answers from its cache
// in a few ms), and the most it can ever stay busy if nothing revalidates.
const REFRESH_MIN_MS = 600;
const REFRESH_MAX_MS = 5000;

// The real GitHub panel, embedded — one source of truth for PRs, checks,
// issues and releases. Refresh is the one primary action; the GitHub link for
// whatever is showing and pop-out to a full dock panel sit behind the ⋯ menu.
export function GitHubSidebarView({ projectId, actions }: RightSidebarViewProps) {
  const [link, setLink] = useState<{ url: string; label: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Busy from the click until this project's cached entries have revalidated
  // (refreshGithubProject marks them fetchedAt 0; the mounted views refetch).
  // An entry that failed to refetch also sits at fetchedAt 0 but carries an
  // error: that is settled, not pending.
  useEffect(() => {
    if (!refreshing) return;
    const startedAt = Date.now();
    const prefix = `${projectId}:`;
    let settled = false;
    let minTimer: ReturnType<typeof setTimeout> | null = null;
    const done = () => {
      if (settled) return;
      settled = true;
      setRefreshing(false);
    };
    const pending = () =>
      Object.entries(useDashboardStore.getState().githubCache).some(
        ([key, entry]) => key.startsWith(prefix) && entry.fetchedAt === 0 && entry.error === null,
      );
    const check = () => {
      if (settled || pending()) return;
      const wait = REFRESH_MIN_MS - (Date.now() - startedAt);
      if (wait <= 0) done();
      else if (minTimer === null) minTimer = setTimeout(done, wait);
    };
    const unsubscribe = useDashboardStore.subscribe(check);
    const cap = setTimeout(done, REFRESH_MAX_MS);
    check();
    return () => {
      settled = true;
      unsubscribe();
      clearTimeout(cap);
      if (minTimer !== null) clearTimeout(minTimer);
    };
  }, [refreshing, projectId]);
  // The same list the panel renders (the live store wins over the cached fetch).
  const prCount = usePrList(projectId)?.prs.length ?? 0;
  return (
    <div className="github-sidebar-view">
      <SidebarHeader
        label={VIEW_TITLES.github}
        context={prCount > 0 ? `${prCount} open PR${prCount === 1 ? "" : "s"}` : undefined}
        actions={[
          {
            key: "refresh",
            label: "Refresh",
            icon: RefreshIcon,
            busy: refreshing,
            onClick: () => {
              setRefreshing(true);
              useDashboardStore.getState().refreshGithubProject(projectId);
            },
          },
        ]}
        overflow={[
          {
            key: "open-on-github",
            label: link?.label ?? "Open on GitHub",
            disabled: link === null,
            onClick: () => {
              if (link) window.open(link.url, "_blank", "noopener,noreferrer");
            },
          },
          {
            key: "open-panel",
            label: "Open GitHub panel",
            onClick: () => actions.onOpenGitHub(projectId),
          },
        ]}
      />
      <ExternalLinkOwnedContext.Provider value={true}>
        {/* Keyed on the project: the panel's own state (the release row, the open
            PR) belongs to one repo and must not carry over to the next. */}
        <GitHubPanel key={projectId} params={{ projectId }} embedded onExternalLink={setLink} />
      </ExternalLinkOwnedContext.Provider>
    </div>
  );
}
