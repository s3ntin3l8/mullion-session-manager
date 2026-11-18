# One Browser pane: Preview and the agent's browser

Design note for [#3218](https://github.com/s3ntin3l8/mullion-session-manager/issues/3218).
It proposes a presentation only. Neither browser engine changes, and no code
changes with this note. It describes `feat-tasks-mode` as of 7090fce9.

## Decisions for the owner

The rest of the note assumes the recommendations.

1. **One pane with a switch, or two linked panes?**
   A: one Browser pane whose switch changes its content in place. B: keep two
   panes, each with a button that opens the other.
   **Recommend A.** The two browsers read as two features today; a switch
   inside one pane shows they are two views of one thing. B only adds a link.

2. **Below 1100px, where does a preview open?**
   A: in the right rail's Browser view, which gets the same switch. B: as a
   pane, as today.
   **Recommend A.** The design's rule for the rails is that anything you look
   at beside a session is a rail view, and the left half is always a session.
   A preview pane breaks that rule today. Cost: below 1100px you see one page
   at a time.

3. **Which entry points to the agent's browser stay on `rails-full` (700 to
   799.98px)?** That is the only band where the palette and the pane menu both
   offer it, and they open different things (the palette the rail view, the
   pane menu a grid pane).
   A: below 1100px only the rail's Browser icon (the phone's "More" → Browser)
   and the palette stay; the pane menu drops its item in `rails-full` too. B:
   keep the pane menu's item in every band and make it open the rail view.
   **Recommend A.** One rule by band ("below 1100px the browser is a rail
   view"), which the palette already follows and #3214 applied to the halves
   and the phone.

4. **Which session does a pane opened as a preview show when switched to the
   agent's browser?**
   A: the session the rail would follow (the project's focused or last-focused
   session), fixed at the moment of the switch. B: always follow focus.
   **Recommend A for a grid pane, B for the rail view.** Focus moves every
   time you click into a terminal; a grid pane should not change page with it.
   The rail view is "the browser of the session on the left" by design.

5. **Names.** **Recommend "Preview" and "Agent's browser"**, as in #3218, and
   "Browser" as the pane's name: "Browser · Preview: <target>", "Browser ·
   Agent's browser: <session>". Keeping "Agent Browser" as a product name reads
   as a second feature, which is the problem.

## What exists today

Two engines, two components, two panel kinds:

|                             | Preview                                                                                | Agent Browser                                                              |
| --------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Component                   | `BrowserPanel.tsx`, an iframe in the user's own tab                                    | `BrowserPane.tsx`, frames streamed from a server-side Chromium to a canvas |
| Panel                       | `browser` (title "Preview: …"), one per project, plus blank, external, branch previews | `browserPane-<sessionId>` (title "Agent Browser: <session>")               |
| Address bar                 | target dropdown (dev server, saved URLs), star to save, reload, dev server dot         | back, forward, address, Go, reload                                         |
| The agent sees it           | no                                                                                     | yes, and drives it                                                         |
| Sites that forbid embedding | do not load                                                                            | load                                                                       |

The agent's browser belongs to an execution target (project, host, checkout and
preview endpoint, `docs/browser-automation.md`), not to one session. Sessions
on the same target share one browser. "This session's browser" is therefore
also the browser of every session on that target.

What each band shows (bands from `lib/layoutTierTypes.ts`):

| Band                                                              | Preview                                                      | Agent Browser                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `desktop` (1280+), `desktop-narrow` (1100 to 1279.98)             | a grid pane                                                  | a grid pane. There is no rail Browser view from 1100px.                          |
| `rails-halves` (800 to 1099.98), the two halves                   | a pane, listed on the rail and shown in a half like any pane | the right rail's Browser view only. The pane menu does not offer it (#3214).     |
| `rails-full` (700 to 799.98), grid; a rail view covers the screen | a grid pane                                                  | the rail's Browser view (rail icon, palette), and a grid pane from the pane menu |
| `phone` (under 700), one pane at a time                           | a pane, full screen                                          | "More" → Browser, full screen. The pane menu does not offer it.                  |

Why `rails-full` has both: the palette checks the band (`COMPANION_BANDS`
includes `rails-full`), the pane menu checks the presentation, and
`rails-full`'s presentation is the grid.

Entry points today:

| Entry point                                     | Opens                                                                  | Where                                                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Palette "Open preview browser"                  | the preview target picker, then a Preview pane                         | every band                                                                                                     |
| Palette "New blank preview browser"             | an empty Preview pane                                                  | every band                                                                                                     |
| Palette "Preview: <label>" (a saved URL)        | a Preview pane on that URL                                             | every band                                                                                                     |
| Bottom Dock, project group "Preview ▾"          | a Preview pane (dev server, a target, a blank one; "Manage previews…") | wherever the bottom Dock shows: not on the phone, not under a touch pointer. The Dock rail view leaves it out. |
| Git branch rows, GitHub PR rows                 | a Preview pane on the branch preview                                   | wherever those views show                                                                                      |
| Inbox: accepting a session's dev server         | the project's Preview pane                                             | every band                                                                                                     |
| Pane menu "Open Agent Browser"                  | a `browserPane` pane                                                   | where the presentation is the grid: the desktop bands and `rails-full`                                         |
| Palette "Open Agent Browser: <session>"         | a `browserPane` pane from 1100px, the rail's Browser view below        | every band, while a terminal session is the active pane                                                        |
| Right rail Browser icon, phone "More" → Browser | the rail's Browser view for the session the rail follows               | below 1100px                                                                                                   |

The rail's Browser view does not launch a browser by itself, because attaching
is what launches it. For a session with no browser yet it shows "<session> has
no browser yet." and an "Open browser" button. A grid pane, by contrast,
attaches (and so launches) as soon as it opens.

## The proposal

### One pane, one address bar, a switch

A Browser pane, and the rail's Browser view (the same component in another
place), has one toolbar:

```
[ Preview | Agent's browser · <session> ]  ‹ ›  [ address ▾ ]  ⟳  ☆  ⇄
```

- **The switch**, a two-way segmented control at the left, is the only new
  control.
- **One address bar**, the same field in both modes. Preview keeps the target
  dropdown and the star. Agent's browser keeps back and forward; they are hidden
  in Preview, since a cross-origin iframe's history cannot be read. The "▾" is
  where #3003's quick pick goes (running services, saved pages), in both modes.
- **⇄ "Open in the other one"** opens the current address in the other mode
  and switches to it (rules below).
- Each mode keeps its last address while the pane is open, so switching back
  does not lose the page.
- **Switching to Agent's browser probes first.** As the rail view does today,
  the pane asks for the session's browser bindings before attaching. A session
  without a browser gets the "has no browser yet" state and its "Open browser"
  button, so flipping the switch never starts a browser by itself.

### "Open this address in the other one"

It is not a copy of the address field. The two engines see addresses
differently.

**Preview → Agent's browser**

- The preview knows the address it loaded, not where the user clicked inside
  it: a cross-origin iframe does not report its location. ⇄ uses the loaded
  address, and its tooltip names it.
- A project preview's iframe address is the preview proxy's
  (`preview-<slug>.<host>`), sometimes with a `__mullion_preview` token. The
  token never travels. Which address the agent's browser loads instead is left
  to the implementation issue, with these constraints: a project's dev server
  address can be a bare port; the session can run on another host, where
  `localhost` is that host; and the agent's browser context is already keyed
  by the session's preview endpoint (`src/services/browser-target.ts`), so the
  answer should come from that target, not from the iframe address.
- A saved or external address is sent as is. The agent's browser refuses
  anything that is not http or https, so ⇄ is disabled for such an address.

**Agent's browser → Preview**

- The address is the page's own; the server reports it.
- If its origin is one of the project's dev servers or preview targets, the
  preview opens that target through the proxy, as the project's preview does
  today.
- Otherwise it opens as an external address. If the site forbids embedding,
  the preview's existing "unavailable" state gets one more line, "This site
  cannot be shown as a preview. The agent's browser can show it.", and a button
  back. That line is the reason to have both modes.
- A `localhost` address that is not a known dev server means a different
  machine to each engine, so ⇄ is disabled for it, with the reason in its
  tooltip.

### What the switch shows when something is missing

| Situation                                                    | Switch                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| The browser feature is off (`BROWSER_ENABLED`)               | no switch; the pane is Preview only                                                                          |
| Preview pane, the project has no session                     | Agent's browser disabled: "No session in this project"                                                       |
| Blank or external preview, no project                        | Agent's browser disabled: "Open a session's browser from the palette or its pane"                            |
| Agent's browser, no browser yet                              | the "has no browser yet" state and its "Open browser" button                                                 |
| Agent's browser, the session is killed                       | switch to Preview if the pane has a project; close it if not (today `useCloseKilledSessionPanels` closes it) |
| Agent's browser, the binding is gone (`binding_unavailable`) | the existing error state and its unbind action; Preview stays available                                      |
| Rail view, no session in focus                               | the existing "No session in focus" note in Agent's browser; Preview works on the rail's project              |

### Which mode each entry point opens

From 1100px (`desktop`, `desktop-narrow`), a Browser pane:

| Entry point                                                               | Opens                            |
| ------------------------------------------------------------------------- | -------------------------------- |
| Palette "Open browser: preview…" (today "Open preview browser")           | target picker, then Preview      |
| Palette "Open browser: blank preview" (today "New blank preview browser") | Preview, empty address           |
| Palette "Open browser: <label>" (today "Preview: <label>")                | Preview on that URL              |
| Bottom Dock "Preview ▾"                                                   | Preview on the chosen target     |
| Git branch row, GitHub PR row                                             | Preview on the branch preview    |
| Inbox, dev server accepted                                                | Preview for the project          |
| Pane menu "Open browser" (today "Open Agent Browser")                     | Agent's browser for that session |
| Palette "Open browser: agent's browser · <session>"                       | Agent's browser for that session |

Opening a target that already has a pane focuses that pane, as today.

Below 1100px (`rails-halves`, `rails-full`, `phone`), the rail's Browser view:

| Entry point                                     | Opens                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| Right rail Browser icon, phone "More" → Browser | the view, in the mode it was last in; Agent's browser the first time         |
| Palette, any preview entry                      | the view in Preview, on that target                                          |
| Palette, blank preview                          | the view in Preview with an empty address, whatever project the rail follows |
| Palette, the agent's browser entry              | the view in Agent's browser                                                  |
| Git branch row, GitHub PR row, Inbox dev server | the view in Preview, on that target                                          |
| Pane menu                                       | no browser entry                                                             |

The Dock rail view keeps leaving out the "Preview ▾" shortcut, since Browser is
a rail view of its own (mockup 2g).

### Crossing 1100px

A Browser pane open in the grid stays a pane when the window narrows below
1100px; that is how the grid works today. The rail's Browser view does not take
it over. For the agent's browser the view is then a second viewer of the same
page, which the server allows: frame capture is per connection
(`src/routes/browser.ts`), so two viewers cost two capture loops, not a
conflict. Closing the pane is up to the user.

### Saved layouts

Workspaces store dockview layouts as opaque blobs, so an old layout can hold
`browser` and `browserPane-<id>` panels, and both must keep loading. The
simplest path keeps both panel ids and registers both components as the Browser
pane, one starting in Preview and the other in Agent's browser. A switch
changes the mode inside the panel and does not rename it. Whether the mode is
written back to the layout, so a reload keeps it, belongs to follow-up 2.

## Not in this note

- Any change to either engine.
- Typing into the agent's browser on a touch screen (#3030).
- The quick pick beside the address (#3003). The note only says where it sits.

## Follow-up issues to file once the owner agrees

1. `fix(browser): the pane menu offers the agent's browser by band, not presentation`.
   Drops "Open Agent Browser" from the pane menu in `rails-full`, so palette and
   pane menu agree (decision 3). Small and independent; can go first.
2. `feat(browser): one Browser pane with a Preview / Agent's browser switch`.
   From 1100px: the shared toolbar, the switch and its probe, the
   missing-session states, the titles, both old panel ids loading as the
   Browser pane (decisions 1, 4, 5).
3. `feat(browser): the right rail's Browser view gets the Preview / Agent's browser switch`.
   Below 1100px; every preview entry point opens the view in Preview instead of
   a pane (decision 2). Blocked by 2.
4. `feat(browser): open the current address in the other browser`. The ⇄
   button and its rules, including which address the agent's browser loads for
   a project preview. Blocked by 2.
5. `feat(browser): one set of browser entry point labels`. Palette, Dock, pane
   menu and Inbox entries renamed to "Open browser …". Can land with 2.

#3003 (quick pick) is already filed; its scope gets one line saying it sits in
the shared address bar, in both modes.
