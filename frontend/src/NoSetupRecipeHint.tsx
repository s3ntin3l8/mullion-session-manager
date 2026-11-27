import { useDashboardStore } from "./store/index.js";
import { NO_SETUP_RECIPE_HINT } from "./lib/setupHint.js";

/**
 * #3588 — shown while the project has no setup recipe and one of its dock
 * sessions started in a fresh worktree (or another host's checkout) that has a
 * lockfile, so nothing installed its dependencies. Gone once a recipe is set.
 */
export function NoSetupRecipeHint({ projectId }: { projectId: number }) {
  const show = useDashboardStore(
    (s) =>
      !s.projects.find((p) => p.id === projectId)?.setupRecipe?.trim() &&
      s.sessions.some((x) => x.projectId === projectId && x.setupHint === "no-recipe"),
  );
  if (!show) return null;
  return (
    <p className="agent-rules-panel-notice no-setup-recipe-hint" role="note">
      {NO_SETUP_RECIPE_HINT}
    </p>
  );
}
