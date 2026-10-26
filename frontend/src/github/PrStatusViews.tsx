import { useCallback, useState, type ReactNode } from "react";
import { api } from "../api/index.js";
import type {
  GitHubActionsRun,
  GitHubJob,
  GitHubLogResponse,
  GitHubOtherCheck,
} from "../api/types.js";
import { runStatusText, statusTone, type Tone } from "../lib/statusTone.js";
import { ChevronDownIcon } from "../ui/icons.js";
import { checkDotClass } from "./checkDot.js";
import { isSkippedJob, runIdFromUrl, type ReviewStatus, type RunJobs } from "./prPhase.js";

// The drilldowns behind the CI / Review / Merge chips (epic #1965, B4). The
// PR list row and the PR detail render the same components, so a chip opens
// the same thing in both places.

const GLYPH: Record<string, string> = { good: "✓", bad: "✗", pending: "⋯", none: "–" };
const checkGlyph = (status: string, conclusion: string | null) =>
  GLYPH[checkDotClass(status, conclusion)];

// Failures first, then in-progress, then everything that passed.
function jobRank(job: GitHubJob): number {
  const dot = checkDotClass(job.status, job.conclusion);
  return dot === "bad" ? 0 : dot === "pending" ? 1 : 2;
}

function Dot({ tone }: { tone: Tone }) {
  return <span className={`sb-dot sb-dot--${tone}`} aria-hidden="true" />;
}

function JobRow({ projectId, runId, job }: { projectId: number; runId: number; job: GitHubJob }) {
  const [log, setLog] = useState<GitHubLogResponse | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const fetchLog = useCallback(() => {
    if (log !== undefined) {
      setLog(log ? null : undefined);
      return;
    }
    setLoading(true);
    api
      .getGitHubLogs(projectId, runId, job.id)
      .then((r) => setLog(r))
      .catch(() => setLog(null))
      .finally(() => setLoading(false));
  }, [projectId, runId, job.id, log]);

  return (
    <div>
      <button type="button" className="pr-dr-row pr-dr-row--btn" onClick={fetchLog}>
        <Dot tone={statusTone({ status: job.status, conclusion: job.conclusion })} />
        <span className="pr-dr-name">{job.name}</span>
        <span className="pr-dr-end" title={runStatusText(job.status, job.conclusion)}>
          {checkGlyph(job.status, job.conclusion)}
        </span>
      </button>
      {loading && <div className="pr-dr-note">Loading logs…</div>}
      {log && log.log && (
        <pre className="github-panel-log">
          {log.log}
          {log.truncated && (
            <span className="github-panel-log-truncated">… ({log.lineCount} lines shown)</span>
          )}
        </pre>
      )}
      {log && !log.log && <div className="pr-dr-note">No log output</div>}
    </div>
  );
}

// One workflow run: a plain label, then its jobs on a single level —
// failures first, skipped/cancelled folded into one expandable row.
function RunGroup({
  projectId,
  run,
  jobs,
}: {
  projectId: number;
  run: GitHubActionsRun;
  jobs: RunJobs;
}) {
  const [showSkipped, setShowSkipped] = useState(false);
  const runId = runIdFromUrl(run.htmlUrl);
  const label = (
    <a href={run.htmlUrl} target="_blank" rel="noreferrer" className="pr-dr-group">
      <Dot tone={statusTone({ status: run.status, conclusion: run.conclusion })} />
      {run.name}
    </a>
  );
  if (runId == null) return <div>{label}</div>;

  const active = (jobs ?? []).filter((j) => jobRank(j) < 2 || !isSkippedJob(j));
  const skipped = (jobs ?? []).filter((j) => jobRank(j) === 2 && isSkippedJob(j));
  active.sort((x, y) => jobRank(x) - jobRank(y));
  return (
    <div>
      {label}
      {jobs === undefined && <div className="pr-dr-note">Loading jobs…</div>}
      {jobs === null && <div className="pr-dr-note">Failed to load jobs</div>}
      {active.map((job) => (
        <JobRow key={job.id} projectId={projectId} runId={runId} job={job} />
      ))}
      {skipped.length > 0 && (
        <>
          <button
            type="button"
            className="pr-dr-row pr-dr-row--btn"
            aria-expanded={showSkipped}
            onClick={() => setShowSkipped(!showSkipped)}
          >
            <Dot tone="neutral" />
            <span className="pr-dr-name">{skipped.length} skipped</span>
            <ChevronDownIcon
              size={10}
              style={{ transform: showSkipped ? "rotate(180deg)" : undefined, flexShrink: 0 }}
            />
          </button>
          {showSkipped &&
            skipped.map((job) => (
              <JobRow key={job.id} projectId={projectId} runId={runId} job={job} />
            ))}
        </>
      )}
    </div>
  );
}

const OTHER_TONE: Record<GitHubOtherCheck["state"], Tone> = {
  success: "success",
  failure: "danger",
  pending: "warn",
  neutral: "neutral",
};

/** Failing first, grouped by workflow, skipped folded, then "Other checks". */
export function ChecksDrill({
  projectId,
  runs,
  otherChecks,
  truncated,
  jobsByRun,
  title,
}: {
  projectId: number;
  runs: readonly GitHubActionsRun[];
  otherChecks?: readonly GitHubOtherCheck[];
  truncated?: boolean;
  jobsByRun: Record<number, RunJobs>;
  title: string;
}) {
  const rank = (r: GitHubActionsRun) => {
    const dot = checkDotClass(r.status, r.conclusion);
    return dot === "bad" ? 0 : dot === "pending" ? 1 : 2;
  };
  const sorted = [...runs].sort((a, b) => rank(a) - rank(b));
  const others = [...(otherChecks ?? [])].sort(
    (a, b) => Number(b.state === "failure") - Number(a.state === "failure"),
  );
  return (
    <div className="sb-drill" role="region" aria-label="Checks">
      <div className="pr-dr-head">{title}</div>
      {sorted.length === 0 && others.length === 0 && (
        <div className="pr-dr-note">No workflow runs for this PR</div>
      )}
      {sorted.map((run) => {
        const id = runIdFromUrl(run.htmlUrl);
        return (
          <RunGroup
            key={run.htmlUrl}
            projectId={projectId}
            run={run}
            jobs={id == null ? undefined : jobsByRun[id]}
          />
        );
      })}
      {others.length > 0 && (
        <>
          <div className="pr-dr-group-h">Other checks</div>
          {others.map((c) => {
            const body = (
              <>
                <Dot tone={OTHER_TONE[c.state]} />
                <span className="pr-dr-name">{c.name}</span>
                <span className="pr-dr-end">{c.state}</span>
              </>
            );
            return c.url ? (
              <a
                key={`${c.source}-${c.name}`}
                className="pr-dr-row"
                href={c.url}
                target="_blank"
                rel="noreferrer"
              >
                {body}
              </a>
            ) : (
              <div key={`${c.source}-${c.name}`} className="pr-dr-row">
                {body}
              </div>
            );
          })}
          {truncated && <div className="pr-dr-note">More checks exist than are shown</div>}
        </>
      )}
    </div>
  );
}

const REVIEW_TONE: Record<string, Tone> = {
  APPROVED: "success",
  CHANGES_REQUESTED: "danger",
  COMMENTED: "info",
};
const REVIEW_GLYPH: Record<string, string> = {
  APPROVED: "✓",
  CHANGES_REQUESTED: "✎",
  COMMENTED: "💬",
};

/** Per-reviewer latest state (bots included), the pending requests and the relay. */
export function ReviewsDrill({
  reviewers,
  requested,
  status,
  title,
  children,
}: {
  reviewers: readonly { login: string; state: string }[];
  requested: readonly string[];
  status: ReviewStatus;
  title: string;
  children?: ReactNode;
}) {
  const relay = status.relay;
  return (
    <div className="sb-drill" role="region" aria-label="Reviews">
      <div className="pr-dr-head">{title}</div>
      {reviewers.map((r) => (
        <div key={r.login} className="pr-dr-row">
          <span className={`pr-dr-glyph pr-tone-${REVIEW_TONE[r.state] ?? "neutral"}`}>
            {REVIEW_GLYPH[r.state] ?? "○"}
          </span>
          <span className="pr-dr-name">{r.login}</span>
          <span className="pr-dr-end">{r.state.toLowerCase().replace(/_/g, " ")}</span>
        </div>
      ))}
      {requested.map((r) => (
        <div key={`req-${r}`} className="pr-dr-row">
          <span className="pr-dr-glyph">○</span>
          <span className="pr-dr-name">{r}</span>
          <span className="pr-dr-end">requested</span>
        </div>
      ))}
      {relay && (
        <div className="pr-dr-row">
          <span className="pr-dr-glyph">{relay.state === "landed" ? "✓" : "⋯"}</span>
          <span className="pr-dr-name">
            Review relay
            {relay.reviewer ? ` · ${relay.reviewer}` : ""}
          </span>
          {relay.url ? (
            <a href={relay.url} target="_blank" rel="noreferrer" className="pr-dr-link">
              open on GitHub
            </a>
          ) : (
            <span className="pr-dr-end">{relay.state}</span>
          )}
        </div>
      )}
      {reviewers.length === 0 && requested.length === 0 && !relay && (
        <div className="pr-dr-note">No reviewers</div>
      )}
      {children}
    </div>
  );
}

/** The blocking reason, with whatever actions the caller can offer for it. */
export function MergeDrill({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="sb-drill" role="region" aria-label="Merge">
      <div className="pr-dr-head">{text}</div>
      {children && <div className="pr-dr-actions">{children}</div>}
    </div>
  );
}
