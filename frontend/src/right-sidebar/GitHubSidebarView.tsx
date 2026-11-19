import { useCallback, useEffect, useState } from "react";
import { GitHubPanel } from "../GitHubPanel.js";
import { SidebarHeader } from "./SidebarHeader.js";
import { VIEW_TITLES } from "./viewTitles.js";
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
// whatever is showing sits behind the ⋯ menu.
export function GitHubSidebarView({ projectId }: RightSidebarViewProps) {
  const [link, setLink] = useState<{ url: string; label: string } | null>(null);
  // What the panel's PR section shows, which leaves the release PR out.
  // Keyed by project: this view is not remounted on a project switch, and the
  // new project's panel reports only after its first paint.
  const [reported, setReported] = useState<{ projectId: number; count: number } | null>(null);
  const onPrCount = useCallback((count: number) => setReported({ projectId, count }), [projectId]);
  const prCount = reported?.projectId === projectId ? reported.count : 0;
  const [refreshing, setRefreshing] = useState(false);
  // Busy from the click until this project's GitHub requests have settled (the
  // mounted views refetch after refreshGithubProject), for at least
  // REFRESH_MIN_MS and at most REFRESH_MAX_MS. Waits on requests actually in
  // flight, not on stale cache keys: a key nothing mounted consumes (a
  // hover-prefetched PR, an older issues page) never revalidates.
  useEffect(() => {
    if (!refreshing) return;
    let cancelled = false;
    const finish = () => {
      if (!cancelled) setRefreshing(false);
    };
    const settle = async () => {
      for (;;) {
        const pending = useDashboardStore.getState().githubInFlight(projectId);
        if (pending.length === 0) return;
        await Promise.allSettled(pending);
      }
    };
    let minHandle: ReturnType<typeof setTimeout> | undefined;
    const minTimer = new Promise<void>((resolve) => {
      minHandle = setTimeout(resolve, REFRESH_MIN_MS);
    });
    const cap = setTimeout(finish, REFRESH_MAX_MS);
    // finish on an unexpected failure too: a busy button must never stick.
    void Promise.all([minTimer, settle()]).then(finish, finish);
    return () => {
      cancelled = true;
      clearTimeout(cap);
      clearTimeout(minHandle);
    };
  }, [refreshing, projectId]);
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
        ]}
      />
      <ExternalLinkOwnedContext.Provider value={true}>
        {/* Keyed on the project: the panel's own state (the release row, the open
            PR) belongs to one repo and must not carry over to the next. */}
        <GitHubPanel
          key={projectId}
          params={{ projectId }}
          embedded
          onExternalLink={setLink}
          onPrCount={onPrCount}
        />
      </ExternalLinkOwnedContext.Provider>
    </div>
  );
}
