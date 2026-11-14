# Starting a session

Two surfaces start a session, and they send exactly the same request for the
same choices (`frontend/src/launchers/useSessionLaunch.ts`):

- **The New session launcher** — it only launches. It opens from a sidebar
  project's "+" (with that project preselected, still changeable), the
  sidebar's "Launch a session" when a workspace is empty, and on the phone the
  top bar's "+" and the session switcher's "New session".
- **The command palette** (⌘K / Ctrl+K, and the left rail's command box) —
  commands, sessions and workspaces, plus every launcher by typing its name. A
  pane's split action still opens the palette scoped to that pane's project.

## The launcher

The choices come in one order, on desktop and on touch:

1. **Where** — the project, the host (only for a project that reaches more
   than one host; see [`multi-host.md`](multi-host.md)), and **Isolate in a new
   worktree** with its base branch.
2. **Agent** — the project's detected agents as tiles, minus the ones hidden
   in Settings → Launchers & agents; the default agent starts selected. A small
   ⚠ on a tile marks an agent that skips permission prompts by configuration
   (Settings → Launchers & agents, or the launcher's own `skipPermissions` in
   `.crs/actions.json`).
3. **The selected agent's options**, in place under the tiles:
   - **Model** — this session's model; "Default (…)" leaves it to Settings →
     Models. Not shown for a command that already passes its own `--model`.
   - **Skip permission prompts** — starts at the agent's configured value and
     overrides it for this launch only; the line under it says which applies.
4. **Shells and scripts** — shells, `package.json` scripts, `tasks.json` tasks
   and `.crs/actions.json` actions. They have no options and launch on click.
5. **Launch** — starts the selected agent.

Selecting an agent and launching are two steps, so its model and permission
override can be changed first. A double click on a tile launches it directly.

A failed launch (an unreachable host, a bad base branch) is shown inline and
leaves the launcher open, so the choice can be fixed and launched again.

### Desktop

A dialog, fully keyboard-operable. Focus starts in the filter: typing filters
the tiles and the list, and Enter launches the selected agent (or, with no
agent left, the first shell or script). ↓ moves into the tiles, where the
arrow keys move the selection, and on into the list. Escape closes the dialog
and returns focus to the button that opened it.

### Touch

Under a coarse pointer the launcher is a sheet, full width on a phone, with
targets of at least 48px and no filter field (so opening it never raises the
on-screen keyboard). It has a second tab, **Open existing**: the sessions by
project, the project named under each title — the project groups of the
phone's session switcher (without its "Needs you" and "Open panes" groups),
because a touch layout has no sidebar to pick a session from. The desktop dialog has no such tab: there the sidebar lists sessions.
