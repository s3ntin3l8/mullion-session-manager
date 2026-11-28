import type { DockBranchPreview } from "./useDockProject.js";
import type { Session } from "../api/index.js";
import { NO_SETUP_RECIPE_HINT } from "../lib/setupHint.js";

/**
 * #3588 — the branch-preview runs of a project's preview control, under its
 * Dock row: a branch preview runs that control as a dock session of its own
 * (in a `dock-preview-*` worktree), so without this a running or failed
 * preview was invisible from the Dock. A running one opens its session; an
 * exited one shows its exit code and last output (kept on the session row
 * after its worktree was cleaned up).
 */
export function DockBranchPreviews({
  items,
  onOpenSession,
}: {
  items: DockBranchPreview[];
  onOpenSession?: (session: Session) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="dock-branch-previews" aria-label="Branch previews">
      {items.map((item) => {
        const label = item.branch ?? `session ${item.session.id}`;
        const state = item.running
          ? "running"
          : `exited${item.exitCode !== null ? ` (code ${item.exitCode})` : ""}`;
        return (
          <li key={item.session.id} className="dock-branch-preview">
            <span className="dock-branch-preview-label">
              Preview {label} · {state}
            </span>
            {item.running && onOpenSession && (
              <button
                type="button"
                className="dock-monitor-port-action"
                onClick={() => onOpenSession(item.session)}
              >
                Open
              </button>
            )}
            {!item.running && (item.lastOutput || item.noRecipe) && (
              <details className="dock-branch-preview-output">
                <summary>Why it exited</summary>
                {item.noRecipe && <p>{NO_SETUP_RECIPE_HINT}</p>}
                {item.lastOutput && <pre>{item.lastOutput}</pre>}
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}
