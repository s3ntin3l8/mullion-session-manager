import { describeCheckout } from "../lib/checkoutContext.js";
import type { CheckoutChoice } from "../hooks/useCheckoutTarget.js";
import { useDashboardStore } from "../store/index.js";

export interface CheckoutChipProps {
  projectId: number;
  /** The session whose checkout the view is bound to; null = project default. */
  sessionId: number | null;
  choice?: CheckoutChoice;
}

// The compact "where am I looking" label shared by Files and Source Control:
// host · checkout · branch, plus the explicit switch between the followed
// session's checkout and the project's default one.
export function CheckoutChip({ projectId, sessionId, choice }: CheckoutChipProps) {
  const project = useDashboardStore((s) => s.projects.find((p) => p.id === projectId));
  const session = useDashboardStore((s) =>
    sessionId === null ? null : (s.sessions.find((x) => x.id === sessionId) ?? null),
  );
  const hosts = useDashboardStore((s) => s.hosts);
  // The branch git itself reports for this checkout (kept fresh by the store's polling).
  const branch = useDashboardStore((s) =>
    sessionId === null ? s.gitStatuses[projectId]?.branch : s.sessionGitStatuses[sessionId]?.branch,
  );
  if (!project) return null;
  const info = describeCheckout(project, session, hosts, branch);
  const followed = choice?.followedSessionId ?? null;
  return (
    <div className="files-root-chip" data-host={info.hostId}>
      <span
        className="files-root-chip-label"
        title={info.cwd ? `${info.cwd} on ${info.hostName}` : info.hostName}
      >
        {info.label}
      </span>
      {followed !== null && choice && (
        <button
          type="button"
          className="git-panel-fetch-btn"
          onClick={() => choice.onChange(!choice.projectDefault)}
        >
          {choice.projectDefault ? "Show session checkout" : "Show project default"}
        </button>
      )}
    </div>
  );
}
