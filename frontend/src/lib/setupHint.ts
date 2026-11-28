// #3588 — the one-time hint for a project with no setup recipe whose fresh
// worktree (or checkout on another host) has a lockfile: nothing installed its
// dependencies. Mullion never guesses a recipe; the operator sets one.
/** #3588 — a dock start waiting for the project's setup recipe. */
export const INSTALLING_LABEL = "Installing dependencies…";

export const NO_SETUP_RECIPE_HINT =
  "This project has no setup recipe; new worktrees and other hosts get no dependencies. Set one under the project's Agent context & skills (Setup recipe).";
