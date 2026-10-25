# UI/UX audit

A full audit of Mullion's React frontend (`frontend/`, ~563 source files) for
accessibility, interaction-feedback and information-architecture defects.

The audit was run statically against the source by three independent
deep-dives — one per axis — followed by a hand-verification pass over every
finding. Each audit was instructed to verify its own citations before
reporting and to flag false positives rather than pad the list. Forty-eight
findings survived verification and are listed here; two claims did not and
are not listed.

**How to read this document.** Every finding carries a severity, the evidence
that proves it, and its disposition:

- **Fixed** — landed in one of the three pull requests in this series; the
  Summary table above says which one.
- **Filed as an issue** — tracked as a GitHub issue, with the issue linked.

The defects are ordered by severity, not by screen. The recurring theme is
that most of them are **divergences from patterns the codebase had already
established**: the shared `Modal` existed and seven dialogs did not use it;
`PaneActionsMenu` implemented the menu pattern correctly and `KebabMenu` did
not; `useFocusTrap` existed and was used correctly in four of its six call
sites. The fixes are therefore mostly consolidation rather than invention.

---

## Summary

| Severity  | Findings | Fixed in PR 1 | Fixed in PR 2 | Fixed in PR 3 | Filed as an issue |
| --------- | -------- | ------------- | ------------- | ------------- | ----------------- |
| Blocker   | 3        | 3             | 0             | 0             | 0                 |
| Major     | 21       | 7             | 7             | 3             | 4                 |
| Minor     | 24       | 2             | 4             | 1             | 17                |
| **Total** | **48**   | **12**        | **11**        | **4**         | **21**            |

Every row of the tables below is counted in exactly one of the four
disposition columns, so the columns add up to the totals. PR 1 is the
accessibility and contrast pass, PR 2 the failure-surfacing pass, and PR 3
the destructive-action guards.

The three blockers were:

1. **Seven dialogs had no dialog semantics at all** — no `role="dialog"`, no
   `aria-modal`, no focus trap, no Escape-to-close, and a close button with
   no accessible name. A screen reader announced them as a plain `div`; a
   keyboard user's focus never entered them and Escape did nothing.
2. **Every control in the Settings modal was visually labelled but
   programmatically anonymous.** `Row` rendered its label as a plain `<div>`,
   so 32 `Toggle`s, 28 `Dropdown`s, 8 `Segmented`s, 3 `Slider`s and 17
   `NumberField`s exposed no accessible name — a screen-reader user heard 88
   indistinguishable controls in one list.
3. **The phone/tablet drawer stayed in the tab order while closed.** It was
   slid off-screen with `transform: translateX(-101%)` and nothing else, so
   its session rows, filter input and per-row menus were all still focusable
   and still in the accessibility tree while invisible.

---

## Blockers

### 1. Seven dialogs had no dialog semantics

**Evidence.** `CreateProjectModal.tsx:396`, `CreateHostModal.tsx:64`,
`CreateGroupModal.tsx:52`, `HostConfigModal.tsx:63`, `PairBridgeModal.tsx:74`,
`GitHubDeviceFlowModal.tsx:83` and `SavedUrlModal.tsx:102` each hand-rolled
the same backdrop + header + close button. None had `role="dialog"`,
`aria-modal`, a focus trap, or an Escape handler, and each close button was
an icon with no accessible name.

The shared `frontend/src/ui/Modal.tsx` had all of it — `role="dialog"`,
`aria-modal="true"`, Escape, `useFocusTrap`, focus-in and focus-restore.
`ui/Modal.tsx`'s own header comment described the seven as "PR 24 pilot"
follow-ups that had not been done.

**Fix.** All seven now compose the shared `Modal`. `SavedUrlModal` has its own
inset-panel design, so `Modal` grew optional `headerClassName` /
`bodyClassName` / `footerClassName` / `headerContent` props for it to keep its
look while inheriting the dialog contract. The shared close button gained
`aria-label="Close dialog"`, matching the repo's existing convention
("Close settings", "Close pane", "Close task detail").

One behavioural detail worth recording: `CreateGroupModal`'s input carried
`autoFocus`, and React applies that during the commit phase — _before_
`useFocusTrap`'s effect captures `document.activeElement`. The hook would
therefore capture the input as "what was focused before the dialog opened"
and restore focus to a detached node on close. `autoFocus` was removed in
favour of the shared `Modal`'s `initialFocusRef`.

### 2. Every Settings control had no accessible name

**Evidence.** `ui/primitives.tsx:29` — `Row` rendered its label as
`<div className="settings-row-label">{label}</div>`, not a `<label>`. The
controls it wraps took an _optional_ `ariaLabel`, which almost no call site
passed.

Recomputed over the call sites: **32** `Toggle`, **28** `Dropdown`, **8**
`Segmented`, **3** `Slider` and **17** `NumberField` usages had no
accessible name.

**Fix.** `Row` now generates a stable id, renders its label with that id, and
publishes it through a React context. The controls point `aria-labelledby` at
that id, so the browser computes the accessible name from the label as it is
actually rendered. An explicit `ariaLabel` prop still wins at every level.

`aria-labelledby` rather than a copied-in `aria-label` on purpose. The
browser computes the accessible name from the label as it is actually
rendered; deriving the text in JS would have to re-implement that render,
so it can only ever be an approximation of it.

The first cut of this fix did derive the label's text and hand it down as
an `aria-label` — and fell back to `aria-labelledby` when the derivation
came out empty, so a label whose text comes from a child component's own
render was named correctly then too. The change is a simplification rather
than a bug fix: there is one way of naming a control now instead of two,
and no JS re-implementation of the render to keep in step with it.

A `<label for>` was rejected, but for a different reason than
`aria-labelledby`: the control lives in a sibling subtree
(`.settings-row-control`) rather than inside the label element, so `for`
could only work by way of a generated id, and not every control is labelable
— `Segmented` renders a `<div role="radiogroup">`, for which `<label for>`
would be invalid HTML. `aria-labelledby` references the same visible text and
is valid for every control type.

The five key-conflict rows in `InputSection.tsx` whose visible label is a
keyboard chip rather than the setting's name now pass an explicit
`ariaLabel` naming both.

**Enforcement.** `frontend/src/ui/primitives.a11y.test.tsx` parses the
Settings tree with the TypeScript compiler API and fails if any control is
left without a name. It resolves the component boundary too, so a control
rendered by a helper component that is itself inside a `Row` is correctly
recognised as named.

### 3. The closed drawer stayed in the tab order

**Evidence.** `styles/sidebar.css:58-77` closed the compact-tier drawer with
`transform: translateX(-101%)` and nothing else — no `display: none`, no
`visibility: hidden`, no `inert` (the string `inert` appeared in the codebase
only inside comments), no `aria-hidden`.

**Fix.** The drawer subtree carries `inert` whenever the compact tier has it
closed, which removes it from the tab order _and_ from the accessibility
tree. The closed-state CSS pairs it with `visibility: hidden` as the fallback
for browsers without `inert` support (an element that is not visible is not
focusable either) — `visibility` rather than `display: none` because the
drawer's scroll container is what the session list's virtualizer measures.

---

## Major findings

### Findings

| #   | Finding                                                                                                                         | Evidence                                                                                                   | Fix / disposition                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | `--dim` failed WCAG AA in **both** themes — 182 text uses, 2.31:1–3.49:1                                                        | `styles/tokens.css`                                                                                        | **Fixed** — re-tuned to `#8a8a94` / `#666666` (4.53:1 / 4.72:1 worst case)                                                                               |
| 5   | White text on the accent/ring fills was 2.54:1–3.39:1                                                                           | `styles/sidebar.css:735`, `styles/terminal.css:359`, `styles/right-sidebar.css:64`, `styles/login.css:117` | **Fixed** — split the palette into a **text role** and a **fill role**: new `--accent-fill` and `--badge-dim` tokens carry the white-on-fill backgrounds |
| 6   | 15 infinite animations ran with no `prefers-reduced-motion` guard                                                               | only `styles/login.css:218` had one                                                                        | **Fixed** — one global guard in `styles/tokens.css`                                                                                                      |
| 7   | `KebabMenu` was entirely mouse-driven — no `role`, no keys, no accessible name                                                  | `ui/KebabMenu.tsx`                                                                                         | **Fixed** — the full APG menu pattern, ported from `PaneActionsMenu`                                                                                     |
| 8   | Six inputs had their focus ring removed with no replacement                                                                     | `styles/command-palette.css:41`, `styles/modals.css:135,149,357`, `styles/sidebar.css:260,1957`            | **Fixed** — `:focus-visible` outlines added (nine sites in the end — see below)                                                                          |
| 9   | Session rename was optimistic with no rollback, and all three call sites dropped the rejection                                  | `store/slices/sessions.ts:205-215`; `PaneTab.tsx:271`, `Sidebar.tsx:1941`, `MobileSessionBar.tsx:201`      | **Fixed** — the store rolls the optimistic rename back and rethrows; the three call sites report it                                                      |
| 10  | The Dock's kill path swallowed its error — while its two siblings in the same file both reported theirs                         | `dock/DockProjectGroup.tsx:776-788`                                                                        | **Fixed** — the failure is reported on the row, like its two siblings already were                                                                       |
| 11  | The pane-overflow kill closed the pane first, then logged the failure to the console only                                       | `PaneActionsMenu.tsx:242-247`                                                                              | **Fixed** — the pane is already closed, so the failure goes to the app-wide toast                                                                        |
| 12  | Workspace and group delete failures were unhandled rejections                                                                   | `WorkspaceSwitcher.tsx:321,333`                                                                            | **Fixed** — both the grouped and the ungrouped list's delete and rename paths report it                                                                  |
| 13  | `ServerInfoSection` showed "Loading…" forever — `null` meant both loading and failed                                            | `settings/sections/ServerInfoSection.tsx:23-38`                                                            | **Fixed** — the two probes have their own failure state and their own retry                                                                              |
| 14  | The sidebar showed "Welcome to Mullion" while projects were loading, and forever if the fetch failed — no `projectsLoaded` flag | `Sidebar.tsx:498-521`; `store/slices/projects.ts:9,13`                                                     | **Fixed** — `projectsLoaded` and `projectsError` separate loading, empty and failed                                                                      |
| 15  | A failed task fetch rendered as "No tasks yet." and invited the user to create one                                              | `store/slices/tasks.ts:93-105`; `UnifiedBoard.tsx:743-751`                                                 | **Fixed** — `tasksError` separates a failed fetch from an empty task list                                                                                |
| 16  | The GitHub App "Clear" destroyed the App ID and private key in one click, with no confirmation                                  | `settings/sections/IntegrationsSection.tsx:297-312,359`                                                    | **Fixed** — the Clear is a `ConfirmButton`, and the button is disabled while the clear is in flight                                                      |
| 17  | The GitHub "Disconnect" revoked the credential in one click, with no confirmation and no pending state                          | `settings/sections/IntegrationsSection.tsx:60-68,91`                                                       | **Fixed** — the Disconnect is a `ConfirmButton`, and the button is disabled while it is in flight                                                        |
| 18  | "Add host" could be submitted twice with Enter — no re-entry guard                                                              | `CreateHostModal.tsx:41-61`                                                                                | **Fixed** — the submit is guarded against re-entry, the same shape `CreateProjectModal` already had                                                      |
| 19  | `Segmented` conveyed its selection by CSS class alone — no `aria-pressed`/`aria-checked`, no group name                         | `ui/primitives.tsx:99-112`                                                                                 | **Fixed** — `role="radiogroup"` + `role="radio"` + `aria-checked`, with arrow-key/Home/End selection and a roving tab stop                               |
| 20  | `TerminalToasts` had no live region — copy and upload feedback was silent to assistive technology                               | `terminal-pane/TerminalToasts.tsx`                                                                         | **Fixed** — a permanent `role="status"` region, with the failure variants raised to `role="alert"`                                                       |
| 21  | The command palette was hidden on the phone tier, and the navigator had no Commands tab                                         | `styles/mobile.css:31-33`; `PhoneNavigator.tsx:17`                                                         | _Filed — [#1880](https://github.com/s3ntin3l8/mullion-session-manager/issues/1880)_                                                                      |
| 22  | The Dock is hidden on every coarse-pointer tier, but the command palette still offers the Dock's configuration commands         | `styles/tablet.css:113-120`                                                                                | _Filed — [#1881](https://github.com/s3ntin3l8/mullion-session-manager/issues/1881)_                                                                      |
| 23  | The phone tier's cross-workspace session swap has no visible signal and no way back                                             | `hooks/usePanelOpener.ts:246-253`                                                                          | _Filed — [#1882](https://github.com/s3ntin3l8/mullion-session-manager/issues/1882)_                                                                      |
| 24  | `findSessionWorkspace` returns the first match, so "which workspace is this session in?" has an arbitrary answer                | `panelUtils.ts:90-95`                                                                                      | _Filed — [#1883](https://github.com/s3ntin3l8/mullion-session-manager/issues/1883)_                                                                      |

### Notes on three of the fixes

**The palette has two roles, and the split was forced.** A value tuned to be
readable _as text_ on a dark surface is the wrong value for a _white-on-fill_
background, and vice versa: `--ring` was 2.54:1 under white text. The
constraint solver shows there is **no single dark `--dim` value** that
satisfies both "text ≥ 4.5:1 on `--pane-hd`" and "white text on it ≥ 4.5:1"
— the feasible interval is empty (L must be ≥ 0.2550 and ≤ 0.1833). So the
palette now carries one token per role rather than one value trying to do
both jobs: `--dim`/`--muted`/`--accent-solid` are text roles, and the new
`--accent-fill`/`--badge-dim` are fill roles.

**The focus-ring fix turned out to cover more sites than the audit listed.**
The audit named six; a systematic sweep of every `outline: none` in the
stylesheets found nine without a replacement — the extra three were the
command-palette search, the two Settings search inputs, and the copy-mode
textarea. Two sites that _looked_ ring-less turned out to be fine
(`.mobile-session-search` has a `:focus` border change;
`.login-input-row input` has a wrapper's `:focus-within`).

**Enforcement.** `scripts/check-token-contrast.mjs` parses the token blocks
and asserts every token against every surface in its theme, and additionally
fails if any stylesheet rule puts white text on a token that is not a
fill-role token — which is what stops the role split from quietly regressing.
It runs in `npm run lint`, and so on every push.

It lives in `scripts/` rather than in a vitest file for one concrete reason:
Vitest stubs CSS imports (`css: false` in `frontend/vitest.config.ts`), so a
test cannot read the stylesheet's text — a `?raw` import resolves to an empty
string. This repo's own precedent for "assert something about a source file's
contents" is a `scripts/check-*.mjs` script wired into `npm run lint`.

The guard's own matcher is pinned by `test/scripts/check-token-contrast.test.ts`,
which drives the real script against fixture trees. That is not ceremony: the
first version of the matcher recognised only `#fff` and `white`, so `#ffffff`
and `#FFF` — the same colour, written differently — slipped past it while the
stylesheets happened to use `#fff`. A guard that only catches the spelling in
use today is not a guard. The suite now pins every spelling of white it must
catch (3-, 4-, 6- and 8-digit hex, the keyword, `rgb()`/`rgba()`) and the
near-misses it must not (`#ffff00`, `#f8f8f8`, `rgb(254, 255, 255)`).

The guard reads the stylesheets only. A colour written inline in a TSX
`style={{ ... }}` object is out of its reach — nothing in this repo writes
one today, and the script says so rather than implying coverage it does not
have.

---

## Minor findings

| #   | Finding                                                                                                  | Evidence                                                      | Fix / disposition                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 25  | `aria-current` existed in exactly one place app-wide                                                     | `MobileSessionBar.tsx:320` only                               | **Fixed** — added to the active workspace item, the active Settings nav item, and the active sidebar session row — which also gained the `.session-item.active` visual state it never had                          |
| 26  | Two collapsible headers are `<div onClick>` with no keyboard path                                        | `SourceControlSection.tsx:277`, `Sidebar.tsx:2139`            | _Filed — [#1893](https://github.com/s3ntin3l8/mullion-session-manager/issues/1893)_                                                                                                                                |
| 27  | No `<h1>`/heading structure in the app shell                                                             | `App.tsx:1522-1528`, `Sidebar.tsx:441-453`                    | **Fixed** — a visually-hidden `<h1>`, `.settings-modal-title` promoted to `<h2>`, `.sidebar-section-title` to `<h3>` (both with explicit margin resets — nothing in this codebase resets the UA's heading margins) |
| 28  | `GitPanel` shows "Loading…" forever when git-status fails; stale data has no staleness marker            | `git-panel`/`GitPanel` status fetch                           | **Fixed** — a failed first fetch shows the error and a retry; a failed later refresh marks the data stale                                                                                                          |
| 29  | `SourceControlSection`'s fetch failure is console-only — its sibling pull is not                         | `SourceControlSection.tsx` fetch handler                      | **Fixed** — the fetch now has its own visible error, like its sibling pull                                                                                                                                         |
| 30  | `BrowserPanel`'s favorites failure is console-only, and renders as "no favorites"                        | `BrowserPanel.tsx` favourites fetch                           | **Fixed** — the failure is reported through the app-wide toast                                                                                                                                                     |
| 31  | `SidebarDevices` shows device errors only in a `title` tooltip                                           | `SidebarDevices` error path                                   | **Fixed** — the error is inline in the failing row, not only in a `title` tooltip                                                                                                                                  |
| 32  | `ConfirmButton` disarms silently after 6 s, with no countdown — while the pane-kill path _does_ show one | `ui/ConfirmButton.tsx`                                        | **Fixed** — the arm window counts down in the button and in its title                                                                                                                                              |
| 33  | "host" names two things: a remote agent, and a local Android device                                      | `HostsSection.tsx:280` vs `DevicesSection.tsx`                | _Filed — [#1878](https://github.com/s3ntin3l8/mullion-session-manager/issues/1878)_                                                                                                                                |
| 34  | "Workspace" names two things: a saved layout, and a Settings section group                               | `WorkspaceSwitcher.tsx:266` vs `settingsSections.tsx:141-167` | _Filed — [#1878](https://github.com/s3ntin3l8/mullion-session-manager/issues/1878)_                                                                                                                                |
| 35  | The sidebar's project tree is not workspace-scoped, while the Dock's is                                  | `Sidebar.tsx` project tree                                    | _Filed — [#1877](https://github.com/s3ntin3l8/mullion-session-manager/issues/1877)_                                                                                                                                |
| 36  | The palette's group labels do not describe their contents; "Navigate" holds one row                      | `CommandPalette.tsx` group definitions                        | _Filed — [#1879](https://github.com/s3ntin3l8/mullion-session-manager/issues/1879)_                                                                                                                                |
| 37  | Palette coverage is not uniform — no Devices, Hosts, Settings, Timeline or new-workspace command         | `CommandPalette.tsx` command list                             | _Filed — [#1879](https://github.com/s3ntin3l8/mullion-session-manager/issues/1879)_                                                                                                                                |
| 38  | The phone Settings list has no search, while the desktop rail does                                       | `styles/mobile.css`, `Settings.tsx` nav                       | _Filed — [#1880](https://github.com/s3ntin3l8/mullion-session-manager/issues/1880)_                                                                                                                                |
| 39  | An ended session's status label composites to 1.54:1–1.70:1                                              | ended-session status styling                                  | _Filed — [#1886](https://github.com/s3ntin3l8/mullion-session-manager/issues/1886)_                                                                                                                                |
| 40  | One timestamp format breaks from the app's shared relative-time formatter                                | review-relay section timestamp                                | _Filed — [#1890](https://github.com/s3ntin3l8/mullion-session-manager/issues/1890)_                                                                                                                                |
| 41  | `NotificationBell` uses `aria-haspopup="true"` where `"dialog"` is correct                               | `NotificationBell.tsx:593`                                    | _Filed — [#1894](https://github.com/s3ntin3l8/mullion-session-manager/issues/1894)_                                                                                                                                |
| 42  | The sidebar's "Projects" header shows the literal word "sessions" where a count belongs                  | `Sidebar.tsx:444`                                             | _Filed — [#1889](https://github.com/s3ntin3l8/mullion-session-manager/issues/1889)_                                                                                                                                |
| 43  | A palette action that does not move focus deliberately leaves focus on `<body>`                          | `CommandPalette.tsx:292`                                      | _Filed — [#1884](https://github.com/s3ntin3l8/mullion-session-manager/issues/1884)_                                                                                                                                |
| 44  | There is no skeleton primitive — twenty-plus panels render the bare word "Loading…"                      | `frontend/src/styles` — no `skeleton` anywhere                | _Filed — [#1885](https://github.com/s3ntin3l8/mullion-session-manager/issues/1885)_                                                                                                                                |
| 45  | The global keyboard shortcuts are discoverable nowhere in the UI                                         | `hooks/useGlobalShortcuts.ts` (not user-facing)               | _Filed — [#1887](https://github.com/s3ntin3l8/mullion-session-manager/issues/1887)_                                                                                                                                |
| 46  | The type scale is px-only, so the OS text-size preference has no effect at all                           | `frontend/src/styles` — no `rem` in the type scale            | _Filed — [#1888](https://github.com/s3ntin3l8/mullion-session-manager/issues/1888)_                                                                                                                                |
| 47  | A blocked task is visible only through the board's own "Blocked only" toggle                             | `UnifiedBoard.tsx:172-186`                                    | _Filed — [#1891](https://github.com/s3ntin3l8/mullion-session-manager/issues/1891)_                                                                                                                                |
| 48  | A host's derived status has exactly one consumer: Settings → Hosts                                       | `hostStatus.ts`                                               | _Filed — [#1892](https://github.com/s3ntin3l8/mullion-session-manager/issues/1892)_                                                                                                                                |

---

## Already handled well

Not everything was broken. These were checked and are correct — the fixes
above deliberately follow their patterns rather than inventing new ones:

- `useFocusTrap` — the shared focus primitive, with focus-in, Tab wrap,
  restore-on-close and a `suppressRestore()` escape hatch for the
  "close by opening something else" race.
- `ui/Modal.tsx` — `role="dialog"`, `aria-modal`, Escape, focus trap, focus
  restore, all in one place.
- `ui/BottomSheet.tsx` — the same contract, plus a portal and an
  `aria-hidden` scrim.
- `ui/CustomSelect.tsx` — a complete `combobox`/`listbox`/`option` model with
  `aria-activedescendant`, arrow keys and Escape.
- `PaneActionsMenu` — the reference menu implementation the `KebabMenu` fix
  was ported from.
- `ConfirmButton`'s `aria-hidden` label swap.
- `Settings.a11y.test.tsx` — an existing focus-management suite.
- `NotificationBell`'s per-row activation.
- `TaskCard`'s `role="img"` + `aria-label` badge pattern.
- `MobileKeyBar`'s `role="toolbar"`.
- The 44 px touch-target layer under `(pointer: coarse)`.
- `env(safe-area-inset-*)` handling throughout.
- `layoutTier.ts`'s `.98px` sub-pixel-safe breakpoints.
- Session status is conveyed by **text**, not colour alone.
- `ErrorBoundary`'s user-facing copy and error disclosure.
- The app-level backend-outage banner, and the workspace-load failure
  banner with its Retry.
- `confirmBeforeKill` defaulting to `true`.
- The session list's virtualization.

---

## Runtime verification still owed

The audit was static — no dev server was running — so a handful of things
need a real browser before the work is called done:

1. Where focus lands after a palette-initiated workspace switch — the audit
   found the mechanism that loses it (finding 43, filed as
   [#1884](https://github.com/s3ntin3l8/mullion-session-manager/issues/1884)),
   but the fix has to be confirmed against a real browser.
2. That the `inert` drawer is genuinely unreachable by Tab on a real
   phone-sized viewport.
3. The rendered contrast of `--dim` over the tinted and hovered backgrounds
   (the computed figures assume the plain surface behind it).
4. Whether the 1040×720 Settings modal clips content at 200 % browser zoom.
5. That the Dock's silent kill leaves a visibly stale row before the 4 s poll
   corrects it.
