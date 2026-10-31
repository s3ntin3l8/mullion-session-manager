import type { Session, SessionSeverity, Task } from "../../api/index.js";
import type { MullionLinkEntry, SessionLink } from "../../hooks/useMullionLinks.js";
import type { Tone } from "../../lib/statusTone.js";

/** Severity → the sidebar kit's one tone vocabulary (dot colour). */
export function severityTone(severity: SessionSeverity): Tone {
  switch (severity) {
    case "failed":
      return "danger";
    case "blocked":
    case "waiting":
      return "warn";
    case "busy":
      return "info";
    case "done":
      return "success";
    case "gone":
    case "dormant":
      return "neutral";
  }
}

export type SessionAction = { kind: "open-existing"; sessionId: number } | { kind: "start" };
/** One decision for "Open session" / "Hand off": reuse a live session, else start. */
export function decideSessionAction(entry: MullionLinkEntry | undefined): SessionAction {
  // A task's own worker wins over any other session on the branch (its
  // reviewer, a hand-started one) — even an exited one, whose pane still shows
  // what it did: "Open session" on a task PR means the agent doing the work,
  // and starting or opening another would compete with it.
  const workerId = entry?.task?.sessionId ?? null;
  if (workerId !== null && entry?.sessions.some((l) => l.session.id === workerId)) {
    return { kind: "open-existing", sessionId: workerId };
  }
  // An entry can hold several sessions (an issue-branch one plus its task's);
  // a live process beats an exited pane that merely sorts first.
  const first = entry?.sessions.find((l) => l.session.alive) ?? entry?.sessions[0];
  return first ? { kind: "open-existing", sessionId: first.session.id } : { kind: "start" };
}

/** Task statuses where Task Master owns the issue but no worker session exists yet. */
const NOT_STARTED_TASK_STATUSES: readonly string[] = ["pending", "ready", "claimed", "backlog"];

export type IssueSessionAction = SessionAction | { kind: "task"; taskId: number; status: string };
/**
 * Like decideSessionAction, for an issue: a queued Task Master task that has
 * no session yet defers to the task, so a plain "Start session" doesn't spin
 * up an ad-hoc worktree the task worker will then also claim.
 */
export function decideIssueSessionAction(entry: MullionLinkEntry | undefined): IssueSessionAction {
  const action = decideSessionAction(entry);
  const task = entry?.task;
  if (action.kind === "start" && task && NOT_STARTED_TASK_STATUSES.includes(task.status)) {
    return { kind: "task", taskId: task.id, status: task.status };
  }
  return action;
}

/**
 * The linked sessions (children included) held at Mullion's review gate — the
 * session status, not a task state (#2019). Shared so a PR row and its detail
 * card agree on whether the gate is holding the PR.
 */
export function gatedSessions(links: readonly SessionLink[] | undefined): Session[] {
  const out: Session[] = [];
  const walk = (ls: readonly SessionLink[]) => {
    for (const l of ls) {
      if (l.session.sessionStatus === "awaiting_review_gate") out.push(l.session);
      walk(l.children);
    }
  };
  walk(links ?? []);
  return out;
}

/** Task status → the kit's tone; shared so every task chip agrees. */
export function taskTone(status: string): Tone {
  switch (status) {
    case "done":
      return "success";
    case "failed":
      return "danger";
    case "reviewing":
      return "warn";
    case "claimed":
    case "in_progress":
      return "info";
    default:
      return "neutral";
  }
}

type TaskSessionIds = Partial<Pick<Task, "sessionId" | "reviewSessionId">>;

/**
 * Splits a session list into what a task owns (its worker and reviewer, and
 * everything nested under them) and what it doesn't, so a row shows the task
 * as one bot chip and keeps session pills for hand-started sessions only.
 */
export function splitTaskSessions(
  links: readonly SessionLink[],
  task: TaskSessionIds | null | undefined,
): { owned: SessionLink[]; rest: SessionLink[] } {
  const ids = new Set(
    [task?.sessionId, task?.reviewSessionId].filter((id): id is number => id != null),
  );
  if (ids.size === 0) return { owned: [], rest: [...links] };
  const owned: SessionLink[] = [];
  const keep = (ls: readonly SessionLink[]): SessionLink[] => {
    const out: SessionLink[] = [];
    for (const l of ls) {
      if (ids.has(l.session.id)) owned.push(l);
      else out.push({ ...l, children: keep(l.children) });
    }
    return out;
  };
  return { owned, rest: keep(links) };
}

/**
 * The session a task chip's live dot tracks: the reviewer while the task is
 * `reviewing` and a review is in flight, otherwise the worker.
 */
export function taskActiveSession(
  task: TaskSessionIds & Pick<Task, "status">,
  owned: readonly SessionLink[],
  reviewInFlight: boolean | undefined,
): SessionLink | null {
  const flat: SessionLink[] = [];
  const walk = (ls: readonly SessionLink[]) =>
    ls.forEach((l) => {
      flat.push(l);
      walk(l.children);
    });
  walk(owned);
  const find = (id: number | null | undefined) =>
    id == null ? undefined : flat.find((l) => l.session.id === id);
  const reviewer =
    task.status === "reviewing" && reviewInFlight ? find(task.reviewSessionId) : undefined;
  return reviewer ?? find(task.sessionId) ?? null;
}
