import type { GitHubPRsStatus, GitHubStatus } from "../api.js";
import { GitHubIcon } from "../icons.js";
import { ciDotClass } from "./dockHelpers.js";

// The dock column's GitHub status glance row — extracted from DockColumn
// alongside dock/useDockGithubStatus.ts (Wave 5 / PR 28 of
// .claude/plans/can-we-do-a-warm-cocke.md). Renders nothing when
// `githubStatus` is null (no remote/no token configured, or still loading)
// — the caller's own conditional render already guards this, this
// component just owns the markup.
export function DockGithubRow({
  githubStatus,
  prsStatus,
  onOpen,
}: {
  githubStatus: GitHubStatus;
  prsStatus: GitHubPRsStatus | null;
  onOpen: () => void;
}) {
  return (
    <button
      className="dock-github-row"
      onClick={onOpen}
      title={`Open GitHub panel for ${githubStatus.repo.owner}/${githubStatus.repo.repo}`}
    >
      <GitHubIcon size={13} />
      <span className="dock-github-repo">
        {githubStatus.repo.owner}/{githubStatus.repo.repo}
      </span>
      <span className="dock-github-stat">
        {githubStatus.openIssues} issue{githubStatus.openIssues === 1 ? "" : "s"}
      </span>
      <span className="dock-github-stat">
        {prsStatus
          ? `${prsStatus.prSummary.pass}✅ ${prsStatus.prSummary.fail}❌ ${prsStatus.prSummary.pending}⏳${prsStatus.prSummary.unknown > 0 ? ` ${prsStatus.prSummary.unknown}❓` : ""}`
          : `${githubStatus.openPRs} PR${githubStatus.openPRs === 1 ? "" : "s"}`}
      </span>
      {githubStatus.ciStatus && (
        <span
          className={`github-panel-ci-dot ${ciDotClass(githubStatus.ciStatus)}`}
          title={`CI: ${githubStatus.ciStatus}`}
        />
      )}
    </button>
  );
}
