# UI/UX audit — frontend, phone and tablet

**Scope.** Mullion's React frontend on its two compact layout tiers: phone (under 700 CSS px)
and tablet (700–1279 CSS px). The trigger was a report from a Pixel 10 Pro Fold, unfolded
(about 840×900), in Chrome as an installed PWA, which lands in the tablet tier with a coarse
pointer. Desktop was only used as a comparison. The backend and the CLI were not audited.
This is a re-audit of the surface covered by [2026-10-frontend-ui-ux.md](2026-10-frontend-ui-ux.md),
with a new axis: **usability**, meaning whether the compact tiers serve the real jobs well,
not only whether they render and pass accessibility checks.

**Status.** Findings only: nothing was fixed in this round, by decision. Every finding is
tracked as an issue; see [Deferred backlog](#deferred-backlog). The one code change in this
branch is the tablet scenes in `visual/scenes.json`, which is the evidence and the first
guardrail.

---

## How the audit was run

| Layer                  | Method                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static review          | The tier logic (`lib/layoutTier.ts`), the app shell (`App.tsx`), the left navigator (`PhoneNavigator*.tsx`), the right sidebar (`right-sidebar/*`), task detail (`TaskDetail.tsx`, `TaskDetailView.tsx`, `hooks/useOpenTask.ts`), the gesture code and the tier stylesheets, read against what a touch user can do. |
| Captures               | `make screenshots-audit` against the isolated demo: six new tablet scenes at two viewports (tablet 820×1180 and a fold-like 840×900), both themes, plus the existing phone and desktop scenes. `metrics.json` was read for axe, overflow, cut-off and unnamed controls.                                             |
| Reproduction           | The stuck task detail was reproduced in the isolated demo with the app in a 840px-wide frame, which puts it in the tablet tier: open Tasks, open a task, close the drawer with its X, reopen Tasks.                                                                                                                 |
| Usability walkthroughs | Counted from the captured flows and the code, not timed on a person. Only the jobs the demo scenes can reach were walked; the rest are marked as not walked and tracked in #2980.                                                                                                                                   |
| What was not possible  | The demo browser pane has no touch or viewport emulation, so swipe-versus-scroll conflicts, thumb reach and real `(pointer: coarse)` target sizes were read from code and CSS, not tried on hardware. Those rows say so.                                                                                            |

### What the code already does well

Checked and left alone. A fix here would be a regression.

- `layoutTier.ts` is the single home of the tier logic, with `.98px` upper bounds so no
  fractional width falls between tiers, and touch affordances keyed on `(pointer: coarse)`
  rather than width.
- A closed drawer is `inert`, so it is out of the tab order.
- The keyboard inset (`useVisualViewportInset`) keeps the app shell above the soft keyboard.
- The left navigator's tab row and its 44px rows are comfortable to hit; its close X sits
  well away from other actions.
- The task detail's content is well structured for a narrow column: status first, then a
  "Next:" line, then boxed Review / Details / Timeline sections.
- No tablet scene has horizontal overflow, controls cut off at the edge, unnamed controls or
  console errors, in either theme and at either viewport.
- The phone session picker names the workspace of each row (finding 23 of the previous audit).

---

## Severity model

- **P0**: a supported tier renders a surface unusable.
- **P1**: a serious defect with no workaround for the affected user, or one that traps them.
- **P2**: makes a frequent job much harder or slower than it should be, or forces the user
  to remember where something lives. A frequent job that costs about twice the steps of
  desktop, or forces a mode switch, is at least P2.
- **P3**: polish, robustness or discoverability; the product still works.

---

## Findings

Nine findings, all deferred as issues: 1 P1, 6 P2, 2 P3. Nothing was P0: every tablet
scene renders without overflow or cut-off controls.

| #   | Severity | Finding                                                                                                                                                                                                                                              | Evidence                                                                                                                                                                                                | Where                                                                                                                                         | What changed                                                              |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | P1       | A task detail cannot be dismissed by closing the drawer: closing and reopening Tasks shows the same detail again                                                                                                                                     | Reproduced in the demo at tablet width. The `tablet-tasks-reopen` scene captures the state after close and reopen: the detail, not the list                                                             | `store/slices/ui.ts` `closeRightSidebar` and `toggleRightSidebarView` clear the GitHub drill-in and `sidebarHistory` but not `selectedTaskId` | Deferred, #2973                                                           |
| 2   | P2       | The floating right sidebar closes on accidental touch: a swipe anywhere on the panel commits at 60px, and the scrim closes on any tap                                                                                                                | Read from code, not tried on hardware. `attachSidebarSwipeGesture` is attached with no edge zone and no ignore selector, so a horizontal scroll inside a task body can close it                         | `right-sidebar/RightSidebar.tsx` ~L121-127, `lib/sidebarSwipeGesture.ts`                                                                      | Deferred, #2974                                                           |
| 3   | P2       | The right sidebar's header controls are below the touch-target floor: `.sb-ibtn` is 26×26, the close X 24×24, and the X sits 2px from the pop-out and GitHub buttons                                                                                 | Read from CSS: `styles/sidebar-kit.css`, `styles/right-sidebar.css`; `styles/tablet.css`'s 44px block does not list either class                                                                        | `.sb-ibtn`, `.right-sidebar-icon-btn`                                                                                                         | Deferred, #2974                                                           |
| 4   | P2       | One task opens in two different places, and Tasks has two entry points on tablet. Chips and notifications open the full-screen docked panel; rows open the sidebar detail; the navigator also has a Tasks tab                                        | Code: `hooks/useOpenTask.ts` sends compact-tier chips to `requestOpenTask`; `TasksSidebarView.tsx` selects in place; `PhoneNavigator.tsx` has a Tasks tab; the `tablet-navigator` capture shows the tab | `hooks/useOpenTask.ts`, `right-sidebar/TasksSidebarView.tsx`, `PhoneNavigator.tsx`                                                            | Deferred, #2976                                                           |
| 5   | P2       | Both side panels float over the workspace. On the fold the navigator covers about half the screen and the right drawer about 40%, so reading a task always hides the terminal                                                                        | `tablet-navigator` and `tablet-tasks-detail` captures at the `fold` viewport                                                                                                                            | `App.tsx` (navigator), `RightSidebar.tsx` (`overlay = open && !docked`, pin ignored below desktop)                                            | Deferred, #2977                                                           |
| 6   | P2       | The empty workspace tells a touch user to press ⌘K and has no tap target                                                                                                                                                                             | `tablet-workspace` capture: "⌘K to launch · pick a session from the sidebar"                                                                                                                            | `App.tsx` ~L1442                                                                                                                              | Deferred, #2978                                                           |
| 7   | P2       | Axe reports serious violations on every tablet scene: `label-content-name-mismatch` on the right-rail buttons (two nodes; four in the notifications scene) and `nested-interactive` on the navigator's workspace rows and in the notifications panel | `metrics.json` for the tablet scenes, both themes and both viewports. The same rules, on the same controls, are already pinned for the desktop scenes                                                   | `right-sidebar/RightRail.tsx`, `Sidebar.tsx` workspace section                                                                                | Already tracked, #2886 (this audit confirms it is also present on tablet) |
| 8   | P3       | The task detail's Back button depends on CSS `:has()`; in a WebView without it the detail has no way back to the list                                                                                                                                | Code: `.right-sidebar-header:has(.right-sidebar-detail-slot > *)` in `styles/right-sidebar.css` ~L207-221. Not a failure on current Chrome, the reporter's browser                                      | `styles/right-sidebar.css`                                                                                                                    | Deferred, #2979                                                           |
| 9   | P3       | At 840px the detail header cuts the title ("#9 Dark mode: low contras…") to fit Back, Pop out, GitHub and Close                                                                                                                                      | `tablet-tasks-detail` fold capture                                                                                                                                                                      | `ui/sidebar/DetailHeader.tsx`, `TaskDetailView.tsx`                                                                                           | Deferred, #2979                                                           |

The phone tier was checked less deeply this round. Its captures (`tasks-phone`,
`session-list`, `terminal`) show no overflow and no unnamed controls in `metrics.json`; the
screenshots were not reviewed in depth. Axe reports the same `nested-interactive` and
`label-content-name-mismatch` on the phone session list, again the #2886 rules.

---

## Usability

Beyond "it renders and passes": how well the compact tiers serve the real jobs. The counts
come from the flows the captures drive (tap counts, not seconds), compared with the desktop
flow for the same job.

| Job                                        | Tablet (current)                                                                                                                                                                          | Desktop                                            | Verdict                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| See what needs me                          | 1 tap: the bell, or the Tasks rail icon, which shows "3 need you"                                                                                                                         | The same                                           | Fine                                                                                                                 |
| Open a task, read it, get back to the work | Tasks rail (1), row (2), read, then X (3). Back to the list is another tap. Reopening Tasks lands on the stale detail (finding 1) and the workspace is covered the whole time (finding 5) | Same two taps, but the sidebar is docked: no close | One extra tap, a stale-state trap, and the working surface hidden while reading. The detail's content itself is good |
| Open the same task from a PR chip or alert | A different surface: the full-screen docked panel, with a different close model (finding 4)                                                                                               | The sidebar detail                                 | A mode switch for the same object                                                                                    |
| Start from an empty workspace              | Read a keyboard hint, then find the toolbar's navigator button (finding 6)                                                                                                                | ⌘K                                                 | The hint is wrong for the device                                                                                     |
| Jump to a session and reply                | Not walked this round                                                                                                                                                                     |                                                    | #2980                                                                                                                |
| Switch workspace and come back             | Not walked this round                                                                                                                                                                     |                                                    | #2980                                                                                                                |
| Glance at the PR linked to a task          | Not walked this round                                                                                                                                                                     |                                                    | #2980                                                                                                                |

### Heuristic notes

- **User control and freedom.** The weakest area. A drawer can be closed five ways (scrim,
  swipe, back gesture, rail icon, X) and none of them returns the user to a known state;
  the one explicit escape for a detail is a 26px Back chevron. Closing is easy to do by
  accident and easy to get wrong on purpose.
- **Consistency.** One object, several places: a task can be a sidebar detail or a docked
  panel, and Tasks is both a navigator tab and a rail view.
- **Recognition over recall.** The right rail is a column of icon-only glyphs (Git,
  History, GitHub, Tasks, Files, Project, Settings) with counts on two of them. The names
  exist for assistive tech but nothing on screen says which is which. The left navigator,
  by contrast, uses text tabs and reads at a glance.
- **Visibility of status.** The fold toolbar spends its width well ("Default · Sessions"
  with an unread count); the empty workspace says nothing useful to a touch user.
- **Ergonomics (read from the captures, not measured with a hand).** On a near-square
  two-handed screen the toolbar's actions and the drawer's close controls are at the top
  corners, the hardest reach, and the controls there are the smallest.

---

## Direction for phone and tablet

**Product principle (from the owner, after the audit): Tasks is one of the two primary ways
to use Mullion, and the other is the terminal and workspace.** Today it is not. Tasks is a
board that is deliberately "not a peer of the workspace" (`App.tsx`, the comment above
`KanbanBoardOverlay`), reached from a sidebar entry or the palette. On phone it lives inside
the navigator's Tasks tab, and on tablet the task detail is a drawer over the workspace,
since #2874 moved it out of the board. Findings 1 to 5 are largely symptoms of that
mismatch: a primary mode is being served by a secondary surface.

The direction this implies, to be decided and specified in #2976 and #2977:

1. **Two top-level modes, Tasks and Workspace, switchable from every tier.** One control in
   the toolbar, always visible, and the same on phone, tablet and desktop. Each mode owns
   the whole screen and its own navigation; neither is an overlay on the other.
2. **Task detail is part of the Tasks mode, not a drawer.**
   - Tablet and desktop: a master-detail layout, the task list beside the detail, so there
     is nothing to dismiss and nothing that can be closed by accident. Selecting a task is
     navigation.
   - Phone: the list, then the detail as a pushed screen, with the system back gesture as
     the way back.
3. **The right sidebar is the same in both modes: ambient context, not a mode of its own.**
   It keeps a Tasks glance (the list, status, "needs you"), so task status stays visible
   from Workspace, as it is in PRs. Opening a task from the glance goes to Tasks mode with
   that task selected; the sidebar never renders a second task detail. This keeps one
   task-detail surface and one Tasks entry per tier (finding 4). Its project follow ("Following
   the active panel") follows the active pane in Workspace and the selected task's project in
   Tasks, so Git, GitHub and Files show that task's branch, PR and files beside it.
4. **Cross-links carry the user between modes and back.** A task opens its session or PR in
   Workspace; a session shows its task; "Back to Tasks" returns to the same task. This is the
   one part of the design that needs care, because the two modes share objects.

What this does to the findings: 1, 2, 3 and 5 disappear once Tasks is not a drawer; 4 is
resolved by construction; 6 and 7 are unaffected. The point fixes #2973 and #2974 stay worth
doing only as a cheap interim (#2973 is a few lines in the store), and should be dropped if the
redesign lands soon.

Decisions from the owner, after the audit:

- The mode switch applies on desktop too; how it works there is a design question.
- The bell stays universal. It should be sectioned (manual and tasks) and needs its own rework:
  the owner does not use it much because it does not give them what they need. What it should
  give is an open question for the design phase.
- The Workspace/Tasks switch highlights only for **needs you**, never for in-flight or other
  non-action statuses.
- The layout is to be designed before anything is changed: flows, information architecture
  and wireframes first, then implementation issues written from the design.
