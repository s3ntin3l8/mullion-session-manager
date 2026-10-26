import { useMemo } from "react";
import type {
  GitHubIssueListItem,
  GitHubPROrWithChecks,
  Preview,
  Project,
  ReviewRun,
  Session,
  Task,
} from "../api/types.js";
import type { SessionSeverity } from "../api/index.js";
import { matchSessionPr } from "../github/matchSessionPr.js";
import { useDashboardStore } from "../store/index.js";

/*
 * The Mullion links index (epic #1965, B7).
 *
 * Git/GitHub rows know almost nothing Mullion knows — which sessions work on a
 * branch, which task owns it, whether a review is running. Every one of those
 * links is already in the store, joinable by branch name, worktree path or PR
 * number, so ONE index feeds every view instead of each view re-deriving.
 *
 * PUBLIC SHAPE (stable — B2/B4/B5 consume it):
 *
 *   useMullionLinks(projectId, inputs?) -> MullionLinks
 *
 *   MullionLinks = {
 *     byBranch:   Map<branch name, MullionLinkEntry>
 *     byWorktree: Map<worktree path, MullionLinkEntry>
 *     byPr:       Map<PR number, MullionLinkEntry>
 *     byIssue:    Map<issue number, MullionLinkEntry>
 *   }
 *   MullionLinkEntry = {
 *     sessions:       SessionLink[]   roots only; children nested in `.children`
 *     task:           Task | null
 *     taskOwned:      boolean         branch belongs to a task (lock variant)
 *     reviewRun:      ReviewLink | null
 *     preview:        Preview | null
 *     promoteRequest: Session | null  a session blocked on a promote decision
 *     devServer:      string | null   the project's configured dev-server URL
 *   }
 *
 * Previews, relay review runs and issue triage are not store slices, so a
 * caller that has them passes them in `inputs`; an absent input only means the
 * matching field stays null. `buildMullionLinks` is the same join as a pure
 * function, for tests and non-React callers.
 *
 * Joins: sessions by `liveBranch`/`previewBranch` and `liveCwd`/`cwd`; a PR's
 * sessions via `matchSessionPr` (a task's recorded PR number beats the branch);
 * child sessions (`parentSessionId`) nest under their parent.
 */

/** Branches Task Master creates; the guard in the backend refuses to delete them. */
export const TASK_BRANCH_PREFIX = "mullion/task-";

export interface SessionLink {
  session: Session;
  severity: SessionSeverity;
  attention: boolean;
  children: SessionLink[];
}

export interface ReviewLink {
  runId: string;
  /** `requested` while in flight, `landed` once the review posted. */
  state: "requested" | "landed";
  /** The relay run's own status (queued, running, completed, …) when known. */
  status?: string;
  /** What the run acts on. */
  kind: "pull_request" | "issue";
}

export interface MullionLinkEntry {
  sessions: SessionLink[];
  task: Task | null;
  taskOwned: boolean;
  reviewRun: ReviewLink | null;
  preview: Preview | null;
  promoteRequest: Session | null;
  devServer: string | null;
}

export interface MullionLinks {
  byBranch: Map<string, MullionLinkEntry>;
  byWorktree: Map<string, MullionLinkEntry>;
  byPr: Map<number, MullionLinkEntry>;
  byIssue: Map<number, MullionLinkEntry>;
}

export interface MullionLinksInputs {
  prs?: readonly GitHubPROrWithChecks[];
  issues?: readonly GitHubIssueListItem[];
  previews?: readonly Preview[];
  /** Extra relay runs (GET /api/reviews); `pr.relayReview` already covers PRs. */
  reviewRuns?: readonly ReviewRun[];
}

export interface BuildMullionLinksArgs extends MullionLinksInputs {
  project: Pick<Project, "id" | "devServerUrl"> | undefined;
  sessions: readonly Session[];
  tasks: readonly Task[];
}

const isLive = (s: Session) => s.status !== "killed";

export const sessionBranch = (s: Session): string | null => s.liveBranch ?? s.previewBranch ?? null;
export const sessionWorktree = (s: Session): string | null => s.liveCwd ?? s.cwd ?? null;

export function isTaskBranch(branch: string | null | undefined): boolean {
  return !!branch && branch.startsWith(TASK_BRANCH_PREFIX);
}

function emptyEntry(devServer: string | null): MullionLinkEntry {
  return {
    sessions: [],
    task: null,
    taskOwned: false,
    reviewRun: null,
    preview: null,
    promoteRequest: null,
    devServer,
  };
}

export function buildMullionLinks(args: BuildMullionLinksArgs): MullionLinks {
  const { project, tasks } = args;
  const devServer = project?.devServerUrl ?? null;
  const projectId = project?.id;
  const sessions = args.sessions.filter(
    (s) => s.projectId === projectId && s.kind === "terminal" && isLive(s),
  );
  const projectTasks = tasks.filter((t) => t.projectId === projectId);
  const prs = args.prs ?? [];
  const previews = (args.previews ?? []).filter((p) => p.projectId === projectId);

  const byId = new Map(sessions.map((s) => [s.id, s]));
  const childrenOf = new Map<number, Session[]>();
  for (const s of sessions) {
    if (s.parentSessionId != null && byId.has(s.parentSessionId)) {
      const list = childrenOf.get(s.parentSessionId) ?? [];
      list.push(s);
      childrenOf.set(s.parentSessionId, list);
    }
  }
  const taskOfSession = (s: Session) =>
    projectTasks.find((t) => t.sessionId === s.id || t.reviewSessionId === s.id) ?? null;

  const toLink = (s: Session, seen: Set<number>): SessionLink => {
    seen.add(s.id);
    return {
      session: s,
      severity: s.sessionStatusSeverity,
      attention: s.sessionStatusAttentionRequired,
      children: (childrenOf.get(s.id) ?? [])
        .filter((c) => !seen.has(c.id))
        .map((c) => toLink(c, seen)),
    };
  };
  /** Roots among `list` (a session whose parent is also in the list nests there). */
  const nest = (list: readonly Session[]): SessionLink[] => {
    const ids = new Set(list.map((s) => s.id));
    const seen = new Set<number>();
    return list
      .filter((s) => s.parentSessionId == null || !ids.has(s.parentSessionId))
      .map((s) => toLink(s, seen));
  };

  const fill = (entry: MullionLinkEntry, list: readonly Session[]) => {
    entry.sessions = nest(list);
    entry.promoteRequest = list.find((s) => s.promoteState === "pending") ?? null;
  };

  const out: MullionLinks = {
    byBranch: new Map(),
    byWorktree: new Map(),
    byPr: new Map(),
    byIssue: new Map(),
  };

  // Branch + worktree: group the sessions, then lay tasks/previews over them.
  const branchSessions = new Map<string, Session[]>();
  const worktreeSessions = new Map<string, Session[]>();
  const push = <K>(m: Map<K, Session[]>, k: K, s: Session) => m.set(k, [...(m.get(k) ?? []), s]);
  for (const s of sessions) {
    const b = sessionBranch(s);
    if (b) push(branchSessions, b, s);
    const w = sessionWorktree(s);
    if (w) push(worktreeSessions, w, s);
  }
  const branchKeys = new Set<string>(branchSessions.keys());
  for (const t of projectTasks) if (t.branchName) branchKeys.add(t.branchName);
  for (const p of previews) if (p.branch) branchKeys.add(p.branch);
  for (const pr of prs) branchKeys.add(pr.headBranch);

  for (const branch of branchKeys) {
    const entry = emptyEntry(devServer);
    const list = branchSessions.get(branch) ?? [];
    fill(entry, list);
    entry.task =
      projectTasks.find((t) => t.branchName === branch) ??
      (list.map(taskOfSession).find(Boolean) as Task | undefined) ??
      null;
    entry.taskOwned = isTaskBranch(branch) || !!entry.task?.branchName;
    entry.preview = previews.find((p) => p.branch === branch) ?? null;
    const pr = prs.find((p) => p.headBranch === branch);
    entry.reviewRun = pr ? prReviewLink(pr, args.reviewRuns) : null;
    out.byBranch.set(branch, entry);
  }

  for (const [path, list] of worktreeSessions) {
    const entry = emptyEntry(devServer);
    fill(entry, list);
    const task =
      projectTasks.find((t) => t.worktreePath === path) ??
      (list.map(taskOfSession).find(Boolean) as Task | undefined) ??
      null;
    entry.task = task;
    entry.taskOwned = !!task || list.some((s) => isTaskBranch(sessionBranch(s)));
    out.byWorktree.set(path, entry);
  }
  for (const t of projectTasks) {
    if (t.worktreePath && !out.byWorktree.has(t.worktreePath)) {
      const entry = emptyEntry(devServer);
      entry.task = t;
      entry.taskOwned = true;
      out.byWorktree.set(t.worktreePath, entry);
    }
  }

  // PR: matchSessionPr decides which PR a session belongs to (the task's
  // recorded PR number wins over the branch), same as the session row.
  for (const pr of prs) {
    const entry = emptyEntry(devServer);
    const task =
      (pr.taskId != null ? projectTasks.find((t) => t.id === pr.taskId) : undefined) ??
      projectTasks.find((t) => t.prNumber === pr.number) ??
      projectTasks.find((t) => t.branchName === pr.headBranch) ??
      null;
    const list = sessions.filter((s) => {
      const t = taskOfSession(s);
      return (
        matchSessionPr(prs, { branch: sessionBranch(s), taskPrNumber: t?.prNumber })?.number ===
        pr.number
      );
    });
    fill(entry, list);
    entry.task = task;
    entry.taskOwned = !!task || isTaskBranch(pr.headBranch);
    entry.preview = previews.find((p) => p.branch === pr.headBranch) ?? null;
    entry.reviewRun = prReviewLink(pr, args.reviewRuns);
    out.byPr.set(pr.number, entry);
  }

  // Issue: the task that tracks it, its sessions, and the triage run.
  const issueNumbers = new Set<number>();
  for (const t of projectTasks) if (t.issueNumber != null) issueNumbers.add(t.issueNumber);
  for (const i of args.issues ?? []) issueNumbers.add(i.number);
  for (const number of issueNumbers) {
    const entry = emptyEntry(devServer);
    const task = projectTasks.find((t) => t.issueNumber === number) ?? null;
    entry.task = task;
    entry.taskOwned = !!task;
    if (task) {
      fill(
        entry,
        sessions.filter((s) => s.id === task.sessionId || s.id === task.reviewSessionId),
      );
    }
    const triage = args.issues?.find((i) => i.number === number)?.triage;
    if (triage) {
      entry.reviewRun = {
        runId: triage.runId,
        state: "requested",
        status: args.reviewRuns?.find((r) => r.runId === triage.runId)?.status,
        kind: "issue",
      };
    }
    out.byIssue.set(number, entry);
  }

  return out;
}

function prReviewLink(
  pr: GitHubPROrWithChecks,
  runs: readonly ReviewRun[] | undefined,
): ReviewLink | null {
  const relay = pr.relayReview;
  if (relay && relay.state !== "none" && relay.runId) {
    return { runId: relay.runId, state: relay.state, status: relay.status, kind: "pull_request" };
  }
  const run = runs?.find(
    (r) => (r.kind ?? "pull_request") === "pull_request" && r.prNumber === pr.number,
  );
  return run
    ? { runId: run.runId, state: "requested", status: run.status, kind: "pull_request" }
    : null;
}

/** The project's Mullion links, rebuilt when the store slices (or inputs) change. */
export function useMullionLinks(projectId: number, inputs: MullionLinksInputs = {}): MullionLinks {
  const project = useDashboardStore((s) => s.projects.find((p) => p.id === projectId));
  const sessions = useDashboardStore((s) => s.sessions);
  const tasks = useDashboardStore((s) => s.tasks);
  const storePrs = useDashboardStore((s) => s.prsByProject[projectId]?.prs);
  const { prs = storePrs, issues, previews, reviewRuns } = inputs;
  return useMemo(
    () => buildMullionLinks({ project, sessions, tasks, prs, issues, previews, reviewRuns }),
    [project, sessions, tasks, prs, issues, previews, reviewRuns],
  );
}
