# Starting a session

Every session starts in the New session launcher
(`frontend/src/launchers/SessionLauncher.tsx`, launching through
`frontend/src/launchers/useSessionLaunch.ts`); the command palette leads into
it:

- **The New session launcher** — the one place a session starts. It opens
  from a sidebar project's "+" (with that project preselected, still
  changeable), the sidebar's "Launch a session" when a workspace is empty, the
  left rail's "+" under the open panes (on the two halves, the "+" of each
  half), the empty workspace's "Launch a session" under a touch pointer, on the
  phone the session switcher's "New session", and a pane's **Split right** /
  **Split down** (with the pane's project preselected; the session, or an
  existing one opened from the touch sheet, lands beside that pane).
- **The command palette** (⌘K / Ctrl+K, and the left rail's command box) —
  commands, sessions and workspaces. It starts no session itself. Its first
  entry, **New session…**, opens the launcher on the palette's project, so
  ⌘K then Enter gets there. Agents, shells and scripts are not listed until
  you type a name; choosing a match opens the launcher with that project and
  entry preselected and **Launch** focused,
  so Enter launches it. The one exception is the search-only "Open session on
  branch …", which starts the default agent on that branch directly.

## The launcher

The choices come in one order, on desktop and on touch. Where and the agent's
options are a form: a fixed label column and a control column, every dropdown
filling its column (a long name ends in an ellipsis). On the sheet (phone,
fold, tablet) each label sits above its control. Nothing appears, disappears
or moves when a switch is flipped or a menu opened, so the rows below stay put.

1. **Where**
   - **Project** — the dropdown's last entry is **Add project…**, for the
     pointer: the arrow keys, End, PageDown and typeahead in the dropdown stop
     at the projects, so a key never opens the Add view by surprise. From the
     keyboard, Add project… is in the ⋯ menu. The **⋯**
     beside it opens the chosen project's menu: **Edit**, **Git pull**,
     **Delete project** (a second click confirms) and **Add project…**. It is
     an anchored menu under a mouse and a bottom sheet under a coarse pointer;
     Escape or a press outside closes it and returns focus to the ⋯. A pull's
     result is a toast.
   - **Host** — only for a project that reaches more than one host (see
     [`multi-host.md`](multi-host.md)).
   - **Worktree** — a switch, **Isolate in a new worktree**, with the base
     branch beside it. The branch dropdown is always there, disabled while the
     switch is off; a launch placed on another host shows "the host's default
     branch" instead (the server picks it). A project with no branches (not a
     git repository, or none committed yet) says "No branches"; a failed
     branch list says so and offers Retry. Either way the switch stays off. Switching project picks the new project's default
     branch.
2. **Agent** — the project's detected agents as tiles, minus the ones hidden
   in Settings → Launchers & agents; the default agent starts selected. A small
   ⚠ on a tile marks an agent that skips permission prompts by configuration
   (Settings → Launchers & agents, or the launcher's own `skipPermissions` in
   `.crs/actions.json`).
3. **Options** — the selected agent's:
   - **Model** — this session's model; "Default (…)" leaves it to Settings →
     Models. Not shown for a command that already passes its own `--model`.
   - **Permissions** — the **Skip prompts** switch (skip permission prompts)
     starts at the agent's configured value and overrides it for this launch
     only; the text beside it says which applies.
4. **Shells and scripts** — shells, `package.json` scripts, `tasks.json` tasks
   and `.crs/actions.json` actions. They have no options and launch on click.
5. **Launch** — starts the selected agent.

**Add project** and **Edit project** replace the launcher's body with the
project form and a **Back** control, rather than opening a dialog over it. The
Add view also lists the discovered repositories. Back, Escape, Cancel or a
successful save return to the launcher, with the choices made there kept, a
new project selected, and focus on the control that opened the form.

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
