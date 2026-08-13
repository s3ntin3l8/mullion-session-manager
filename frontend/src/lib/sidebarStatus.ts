// Sidebar.tsx's "dot-class" family plus the file-change summarizer,
// extracted as PR 27 phase 1 (Wave 5, .claude/plans/can-we-do-a-warm-cocke.md)
// — all genuinely pure (no hooks, no component state, no side effects).
// Grouped together (rather than split further) because they're the same
// small-status-vocabulary character the plan's own PR 27 entry calls "dot-
// class" helpers: git dirty/clean/conflict, PR CI success/failure/pending,
// subagent live/finished, and the file-change action → dot/letter mapping
// that summarizeFileChanges' output feeds. `subagentDotClass`/
// `isSubagentLive`/`backgroundTaskLetter`/`fileChangeLetter` sit outside the
// plan's own (stale) line-range citation for this cluster, but are the same
// character of helper and were included here rather than splitting the
// dot-class family across two homes.
import type { GitHubCiStatus, GitStatus, NotificationEvent, SubagentInfo } from "../api/index.js";

// Same clean/dirty/conflict/none taxonomy as ProjectHeader's own inline
// gitStatus handling in Sidebar.tsx — that call site stays inline rather
// than routed through this function (matches git-refs.ts's own "small
// guards get duplicated, not shared" precedent elsewhere in this codebase).
// This is SessionRow's own use, for row 3's dirty dot (`.project-git-dot`).
export function sessionGitDotClass(status: GitStatus): "clean" | "dirty" | "conflict" {
  if (status.hasConflicts) return "conflict";
  return status.isClean ? "clean" : "dirty";
}

// Same "success/failure/in_progress/null -> good/bad/pending/none" mapping
// as GitHubPanel.tsx's own ciDotClass — duplicated rather than imported for
// the same "small guard, not worth a cross-module dependency" reasoning.
export function sessionPrDotClass(status: GitHubCiStatus): "good" | "bad" | "pending" | "none" {
  if (status === "success") return "good";
  if (status === "failure") return "bad";
  if (status === "in_progress") return "pending";
  return "none";
}

// Live (still running) vs finished — the only two states a SubagentInfo can
// be in (see pty-manager.ts's recordSubagentStart/Stop); reused for both the
// chip's dot color and its age label ("running Xm ago" vs "finished Xm ago").
export function isSubagentLive(subagent: SubagentInfo): boolean {
  return subagent.endedAt === null;
}

export function subagentDotClass(subagent: SubagentInfo): "good" | "pending" {
  return isSubagentLive(subagent) ? "pending" : "good";
}

// Issue #428 — the first letter of a background task's `type` (e.g.
// "shell"/"subagent"/"mcp"), same one-glyph-badge convention as
// fileChangeLetter below. Falls back to "?" for an empty/malformed type —
// hook-protocol.ts's validateBackgroundTasksField only requires each element
// to be a non-null object, not that `type` itself is a non-empty string.
export function backgroundTaskLetter(type: string): string {
  return typeof type === "string" && type.length > 0 ? type[0].toUpperCase() : "?";
}

export interface FileChangeSummary {
  path: string;
  action: "modify" | "create" | "delete";
  count: number;
  lastSeq: number;
}

// Row 4 (issue #177) — collapses this session's raw `file_change` hook
// events (see eventDescriptions.ts's own file_change case for the payload
// shape) into one summary per path: the most recent action wins, `count`
// is how many times that path was touched recently. `events` is
// oldest-first (store.ts's addEvent), so a single forward scan naturally
// leaves the latest action/seq in place with no extra sort-then-scan step.
export function summarizeFileChanges(events: NotificationEvent[] | undefined): FileChangeSummary[] {
  if (!events) return [];
  const byPath = new Map<string, FileChangeSummary>();
  for (const event of events) {
    if (event.kind !== "file_change") continue;
    const path = typeof event.payload.path === "string" ? event.payload.path : null;
    const action = event.payload.action;
    if (!path || (action !== "modify" && action !== "create" && action !== "delete")) continue;
    const existing = byPath.get(path);
    if (existing) {
      existing.action = action;
      existing.count += 1;
      existing.lastSeq = event.seq;
    } else {
      byPath.set(path, { path, action, count: 1, lastSeq: event.seq });
    }
  }
  return Array.from(byPath.values()).sort((a, b) => b.lastSeq - a.lastSeq);
}

// Reuses the same letter+dot language as GitPanel.tsx's own per-file status
// badges (create/A -> good, delete/D -> bad, modify/M -> pending) rather
// than inventing a fourth dot vocabulary for this one strip.
export function fileChangeDotClass(
  action: FileChangeSummary["action"],
): "good" | "bad" | "pending" {
  if (action === "create") return "good";
  if (action === "delete") return "bad";
  return "pending";
}

export function fileChangeLetter(action: FileChangeSummary["action"]): "A" | "D" | "M" {
  if (action === "create") return "A";
  if (action === "delete") return "D";
  return "M";
}
