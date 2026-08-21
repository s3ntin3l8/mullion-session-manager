import { useState } from "react";
import { ApiError } from "../api/index.js";
import type { ClearDoneResult } from "../api/index.js";
import { PlusIcon } from "../ui/icons.js";

// Split out of UnifiedBoard.tsx (Wave 5 / PR 28 of
// .claude/plans/can-we-do-a-warm-cocke.md) — the board's own "New task"
// affordance: a toggleable inline form over the task columns. Self-contained
// aside from `createTask`, threaded in from the board so this component
// doesn't need its own store access.
export function TasksToolbar({
  creating,
  onToggleCreate,
  projects,
  createTask,
  onCreated,
  hideDone,
  onToggleHideDone,
  activeProjectIds,
  clearDoneTasks,
}: {
  creating: boolean;
  onToggleCreate: () => void;
  projects: { id: number; name: string }[];
  createTask: (projectId: number, title: string) => Promise<unknown>;
  onCreated: () => void;
  // #746 — placed here (not one of UnifiedBoard.tsx's own filter-bar chips)
  // so it sits next to the board's other done-management affordance
  // ("Clear done").
  hideDone: boolean;
  onToggleHideDone: () => void;
  // Empty array means "no project filter active" — mirrors
  // UnifiedBoard.tsx's own activeProjectIds semantics (visibleTasks treats
  // [] as "show every project" too), passed through as `undefined` to the
  // API call for the same reason.
  activeProjectIds: number[];
  clearDoneTasks: (opts?: {
    projectIds?: number[];
    deleteBranches?: boolean;
  }) => Promise<ClearDoneResult>;
}) {
  const [manualProjectId, setManualProjectId] = useState<number | null>(null);
  const projectId =
    manualProjectId !== null && projects.some((p) => p.id === manualProjectId)
      ? manualProjectId
      : (projects[0]?.id ?? null);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!title.trim() || projectId === null || submitting) return;
    setSubmitting(true);
    setError(null);
    createTask(projectId, title.trim())
      .then(() => {
        setTitle("");
        onCreated();
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Failed to create task");
      })
      .finally(() => setSubmitting(false));
  };

  // #746 — same two-step confirm shape TaskDetail.tsx's own
  // DeleteTaskAction uses. `deleteBranches` defaults off (records preserved
  // unless explicitly asked to also clean up branches). Loops on the
  // server's own batch cap (20/call, `result.remaining`) here rather than
  // surfacing "call again" as a user-visible step — the caller sees one
  // "Clearing…" state regardless of how many rows are behind it.
  const [clearConfirming, setClearConfirming] = useState(false);
  const [clearDeleteBranches, setClearDeleteBranches] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [clearResult, setClearResult] = useState<{
    deleted: number;
    failed: { id: number; error: string }[];
    branches: ClearDoneResult["branches"];
  } | null>(null);

  const runClearDone = async () => {
    setClearing(true);
    setClearError(null);
    setClearResult(null);
    const projectIds = activeProjectIds.length > 0 ? activeProjectIds : undefined;
    const deleted: number[] = [];
    const failed: { id: number; error: string }[] = [];
    const branches: ClearDoneResult["branches"] = [];
    try {
      let remaining = 1;
      while (remaining > 0) {
        const result = await clearDoneTasks({ projectIds, deleteBranches: clearDeleteBranches });
        deleted.push(...result.deleted);
        failed.push(...result.failed);
        branches.push(...result.branches);
        remaining = result.remaining;
        // A pass that made zero progress (every candidate in this batch
        // failed, none deleted) but still reports a remainder would
        // otherwise spin forever re-attempting the same un-deletable rows —
        // e.g. every row rate-limited, or a relabeled GitHub issue that
        // conflicts on every pass.
        if (result.deleted.length === 0) break;
      }
      // No explicit refresh call here — the store's clearDoneTasks action
      // (useDashboardStore's tasks slice) already calls refreshTasks()
      // itself, same as every other task mutation in that slice.
      setClearResult({ deleted: deleted.length, failed, branches });
    } catch (err) {
      setClearError(err instanceof ApiError ? err.message : "Failed to clear done tasks");
    } finally {
      setClearing(false);
      setClearConfirming(false);
    }
  };

  return (
    <div className="tasks-panel-toolbar">
      <button className="tasks-panel-new-btn" onClick={onToggleCreate}>
        <PlusIcon size={12} strokeLinecap="round" strokeWidth={2.2} />
        New task
      </button>
      <button
        type="button"
        className={`sidebar-filter-chip tasks-panel-hide-done-toggle${hideDone ? " active" : ""}`}
        aria-pressed={hideDone}
        onClick={onToggleHideDone}
      >
        Hide done
      </button>
      {!clearConfirming ? (
        <button
          type="button"
          className="tasks-panel-clear-done-btn"
          onClick={() => {
            setClearConfirming(true);
            setClearResult(null);
            setClearError(null);
          }}
        >
          Clear done
        </button>
      ) : (
        <div className="tasks-panel-clear-done-confirm">
          <span className="task-detail-hint">
            Delete every done task{activeProjectIds.length > 0 ? " in the current filter" : ""}?
            This can't be undone.
          </span>
          <label className="tasks-panel-clear-done-branches">
            <input
              type="checkbox"
              checked={clearDeleteBranches}
              disabled={clearing}
              onChange={(e) => setClearDeleteBranches(e.target.checked)}
            />
            Also delete local branches for merged PRs
          </label>
          <button
            className="notif-gate-btn notif-gate-deny-confirm"
            disabled={clearing}
            onClick={() => void runClearDone()}
          >
            {clearing ? "Clearing…" : "Confirm clear"}
          </button>
          <button
            className="notif-gate-btn"
            disabled={clearing}
            onClick={() => setClearConfirming(false)}
          >
            Cancel
          </button>
        </div>
      )}
      {clearError && <span className="task-detail-error">{clearError}</span>}
      {clearResult && (
        <div className="tasks-panel-clear-done-result">
          <span className="task-detail-hint">Cleared {clearResult.deleted} done task(s).</span>
          {clearResult.failed.length > 0 && (
            <ul className="tasks-panel-clear-done-failures">
              {clearResult.failed.map((f) => (
                <li key={f.id}>
                  Task #{f.id}: {f.error}
                </li>
              ))}
            </ul>
          )}
          {clearResult.branches.some((b) => !b.deleted) && (
            <ul className="tasks-panel-clear-done-failures">
              {clearResult.branches
                .filter((b) => !b.deleted)
                .map((b) => (
                  <li key={b.id}>
                    Branch {b.branch} not deleted: {b.reason}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
      {creating && (
        <div className="tasks-panel-new-form">
          <select
            className="tasks-panel-new-project"
            value={projectId ?? ""}
            onChange={(e) => setManualProjectId(Number(e.target.value))}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            className="tasks-panel-new-title"
            placeholder="Task title"
            value={title}
            autoFocus
            disabled={submitting}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          <button
            className="tasks-panel-new-submit"
            disabled={!title.trim() || projectId === null || submitting}
            onClick={submit}
          >
            {submitting ? "Creating…" : "Create"}
          </button>
          {error && <span className="task-detail-error">{error}</span>}
        </div>
      )}
    </div>
  );
}
