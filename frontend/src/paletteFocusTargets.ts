// Landing spots for the command palette's focus fallback after a workspace
// switch (issue #1884). One module owns the strings so the palette query,
// the component that renders the target, and the tests cannot drift: a
// rename of either export fails the build at every call site.

/** Active workspace row. `WorkspaceSwitcher` sets this; the palette queries it. */
export const WORKSPACE_FOCUS_FALLBACK = "workspace";

export const WORKSPACE_FOCUS_FALLBACK_SELECTOR = `[data-focus-fallback="${WORKSPACE_FOCUS_FALLBACK}"]`;

// Dockview owns `.dv-active-group` and xterm owns `.xterm-helper-textarea`.
// Don't fork either package — share the selector the palette queries and the
// test DOM is built from, so changing one without the other cannot happen.
export const ACTIVE_TERMINAL_FOCUS_SELECTOR =
  ".dockview-container .dv-active-group .xterm-helper-textarea";
