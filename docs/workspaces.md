# Workspaces and groups

A **workspace** is a named, saved layout of panes: which sessions, previews
and panels are open and how they are arranged. Switching workspace swaps the
whole layout. A **group** is a coloured folder of workspaces; a workspace is
in at most one group, or in none ("No group").

Order is yours: workspaces keep the order you give them within their group,
and groups are listed by name.

## Where you manage them

- **The rail's workspace chip.** The chip at the top of the left rail shows
  the current workspace's initial in its group's colour, its name, and one
  colour square per group (grey for "No group"). It opens the workspace
  picker: a popover beside the chip under a mouse, a bottom sheet under touch.
- **The docked sidebar's Workspaces section** (desktop) lists the same tree,
  with collapsible groups.

## The workspace picker

Each group is a section: a header with the group's colour, its name, the
number of workspaces in it and a "⋯" menu (Rename, Delete group), then its
workspaces indented under it. Workspaces in no group follow in their own
"No group" section once any group exists. A search box at the top filters by
workspace or group name. A tap or click on a row switches to that workspace;
its "⋯" menu has Rename, Move to _group_, Move to No group and Delete
workspace. "New workspace" and "New group" sit at the bottom.

### Reordering

Every row has a drag handle (⠿) on its left.

- **Drag the handle** with a mouse or a finger to move the row. A line shows
  where it will land. Drop it between two rows of the same group to reorder,
  in another group (an empty group shows a "drag one here" box) to move it
  there, or in "No group" to take it out of all groups; "No group" appears as
  a target while you drag even when nothing is in it yet. Near the top or
  bottom edge the list scrolls. **Escape**, or letting go away from the
  list, puts the row back.
- Only the handle drags: under touch, swiping on a row still scrolls the
  list.
- **From the keyboard**, focus a row's handle and press **Arrow Up** or
  **Arrow Down** to move it within its group; a screen reader announces the
  new position. Use the row's "⋯" → **Move to** _group_ or **Move to No
  group** to move it between groups.
- Reordering is off while a search filters the list, since the rows shown
  are then not the group's full order: clear the search first.

The docked desktop sidebar's Workspaces section drags the same way: drag a
row's handle between rows, into a group, onto a group's header (it lands
first in that group, a collapsed group included) or into the ungrouped list
("Drop here to ungroup" when it is empty). Escape, or letting go away from
the section, puts the row back. Its handle has no keyboard reordering: use
the picker for that.

The order is saved on the server, so every device sees it.
