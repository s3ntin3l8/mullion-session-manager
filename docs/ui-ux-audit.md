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

| #   | Finding                                                                                                                         | Evidence                                                                                                   | Fix / disposition                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | `--dim` failed WCAG AA in **both** themes — 182 text uses, 2.31:1–3.49:1                                                        | `styles/tokens.css`                                                                                        | **Fixed** — re-tuned to `#8a8a94` / `#666666` (4.53:1 / 4.72:1 worst case). The figures are against _flat_ surfaces; the runtime verification below found two more places where a translucent background put it under AA, and fixed those too |
| 5   | White text on the accent/ring fills was 2.54:1–3.39:1                                                                           | `styles/sidebar.css:735`, `styles/terminal.css:359`, `styles/right-sidebar.css:64`, `styles/login.css:117` | **Fixed** — split the palette into a **text role** and a **fill role**: new `--accent-fill` and `--badge-dim` tokens carry the white-on-fill backgrounds                                                                                      |
| 6   | 15 infinite animations ran with no `prefers-reduced-motion` guard                                                               | only `styles/login.css:218` had one                                                                        | **Fixed** — one global guard in `styles/tokens.css`                                                                                                                                                                                           |
| 7   | `KebabMenu` was entirely mouse-driven — no `role`, no keys, no accessible name                                                  | `ui/KebabMenu.tsx`                                                                                         | **Fixed** — the full APG menu pattern, ported from `PaneActionsMenu`                                                                                                                                                                          |
| 8   | Six inputs had their focus ring removed with no replacement                                                                     | `styles/command-palette.css:41`, `styles/modals.css:135,149,357`, `styles/sidebar.css:260,1957`            | **Fixed** — `:focus-visible` outlines added (nine sites in the end — see below)                                                                                                                                                               |
| 9   | Session rename was optimistic with no rollback, and all three call sites dropped the rejection                                  | `store/slices/sessions.ts:205-215`; `PaneTab.tsx:271`, `Sidebar.tsx:1941`, `MobileSessionBar.tsx:201`      | **Fixed** — the store rolls the optimistic rename back and rethrows; the three call sites report it                                                                                                                                           |
| 10  | The Dock's kill path swallowed its error — while its two siblings in the same file both reported theirs                         | `dock/DockProjectGroup.tsx:776-788`                                                                        | **Fixed** — the failure is reported on the row, like its two siblings already were                                                                                                                                                            |
| 11  | The pane-overflow kill closed the pane first, then logged the failure to the console only                                       | `PaneActionsMenu.tsx:242-247`                                                                              | **Fixed** — the pane is already closed, so the failure goes to the app-wide toast                                                                                                                                                             |
| 12  | Workspace and group delete failures were unhandled rejections                                                                   | `WorkspaceSwitcher.tsx:321,333`                                                                            | **Fixed** — both the grouped and the ungrouped list's delete and rename paths report it                                                                                                                                                       |
| 13  | `ServerInfoSection` showed "Loading…" forever — `null` meant both loading and failed                                            | `settings/sections/ServerInfoSection.tsx:23-38`                                                            | **Fixed** — the two probes have their own failure state and their own retry                                                                                                                                                                   |
| 14  | The sidebar showed "Welcome to Mullion" while projects were loading, and forever if the fetch failed — no `projectsLoaded` flag | `Sidebar.tsx:498-521`; `store/slices/projects.ts:9,13`                                                     | **Fixed** — `projectsLoaded` and `projectsError` separate loading, empty and failed                                                                                                                                                           |
| 15  | A failed task fetch rendered as "No tasks yet." and invited the user to create one                                              | `store/slices/tasks.ts:93-105`; `UnifiedBoard.tsx:743-751`                                                 | **Fixed** — `tasksError` separates a failed fetch from an empty task list                                                                                                                                                                     |
| 16  | The GitHub App "Clear" destroyed the App ID and private key in one click, with no confirmation                                  | `settings/sections/IntegrationsSection.tsx:297-312,359`                                                    | **Fixed** — the Clear is a `ConfirmButton`, and the button is disabled while the clear is in flight                                                                                                                                           |
| 17  | The GitHub "Disconnect" revoked the credential in one click, with no confirmation and no pending state                          | `settings/sections/IntegrationsSection.tsx:60-68,91`                                                       | **Fixed** — the Disconnect is a `ConfirmButton`, and the button is disabled while it is in flight                                                                                                                                             |
| 18  | "Add host" could be submitted twice with Enter — no re-entry guard                                                              | `CreateHostModal.tsx:41-61`                                                                                | **Fixed** — the submit is guarded against re-entry, the same shape `CreateProjectModal` already had                                                                                                                                           |
| 19  | `Segmented` conveyed its selection by CSS class alone — no `aria-pressed`/`aria-checked`, no group name                         | `ui/primitives.tsx:99-112`                                                                                 | **Fixed** — `role="radiogroup"` + `role="radio"` + `aria-checked`, with arrow-key/Home/End selection and a roving tab stop                                                                                                                    |
| 20  | `TerminalToasts` had no live region — copy and upload feedback was silent to assistive technology                               | `terminal-pane/TerminalToasts.tsx`                                                                         | **Fixed** — a permanent `role="status"` region, with the failure variants raised to `role="alert"`                                                                                                                                            |
| 21  | The command palette was hidden on the phone tier, and the navigator had no Commands tab                                         | `styles/mobile.css:31-33`; `PhoneNavigator.tsx:17`                                                         | _Filed — [#1880](https://github.com/s3ntin3l8/mullion-session-manager/issues/1880)_                                                                                                                                                           |
| 22  | The Dock is hidden on every coarse-pointer tier, but the command palette still offers the Dock's configuration commands         | `styles/tablet.css:113-120`                                                                                | _Filed — [#1881](https://github.com/s3ntin3l8/mullion-session-manager/issues/1881)_                                                                                                                                                           |
| 23  | The phone tier's cross-workspace session swap has no visible signal and no way back                                             | `hooks/usePanelOpener.ts:246-253`                                                                          | _Filed — [#1882](https://github.com/s3ntin3l8/mullion-session-manager/issues/1882)_                                                                                                                                                           |
| 24  | `findSessionWorkspace` returns the first match, so "which workspace is this session in?" has an arbitrary answer                | `panelUtils.ts:90-95`                                                                                      | _Filed — [#1883](https://github.com/s3ntin3l8/mullion-session-manager/issues/1883)_                                                                                                                                                           |

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

The guard's other limit is structural: it compares a token against a token,
so it cannot see a **translucent** layer painted under the text. The runtime
verification below found two places where that mattered — a keycap chip and
the active workspace row — both of which sat under 4.5:1 once their real
painted background was composited. `scripts/verify-ui-runtime.mjs`
(`make verify-ui`) is the guard for that layer: it measures the composited,
hovered result in a real browser. Neither guard subsumes the other, and
the token guard stays the one that runs on every push.

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

## Runtime verification

The audit was static — no dev server was running — so five things it could
not settle by reading code were left open in what used to be this
document's "Runtime verification still owed" section. They have now been
checked against a real browser by **`scripts/verify-ui-runtime.mjs`**
(`make verify-ui`), which boots a throwaway Mullion
(`scripts/demo/instance.mjs`: scratch DB, scratch `SESSIONS_DIR`/`HOME`, clean
env, its own loopback ports), drives it with real Chromium, and tears
everything down again — including the demo's session scopes.

The script is committed and re-runnable, and it exits non-zero when a check
fails, so it works as a manual gate. It is deliberately **not** wired into
CI: it needs a browser binary and a demo instance, exactly like the opt-in
`make test-e2e` suite, which is likewise not a required status check.

### 1. Focus after a palette-initiated workspace switch — the defect is real

> The audit's original wording was "the fix has to be confirmed against a
> real browser". There is no fix to confirm: finding 43 was filed as
> [#1884](https://github.com/s3ntin3l8/mullion-session-manager/issues/1884)
> and deliberately deferred, and `CommandPalette.tsx` was never touched by
> this series. What the browser can settle is the _mechanism_, and it
> settles it: **the focus is lost.**

Opening the palette, typing a workspace's name and activating its row does
switch the workspace — the sidebar's active row follows — but focus lands on
`<body>`. `CommandPalette.tsx`'s `closeAfterAction()` calls `suppressRestore()`
before the palette unmounts, and `useFocusTrap.ts`'s cleanup skips the
restore when that flag is set, so nothing claims focus on the way out. A
keyboard user who switches workspace this way is left with no focus target at
all. The check measures and reports the landing element rather than asserting
a particular outcome, so it keeps working as a regression test once #1884
lands.

### 2. The `inert` drawer — confirmed unreachable

At 375×812 the closed drawer carries `inert` (the property _and_ the
attribute), 30 Tab presses land on **zero** elements inside it, and the walk
does move — three distinct controls outside the drawer were reached, so this
is not a pass by accident. The sharper half of the property also holds: while
closed, the drawer **refuses** programmatic focus as well as the tab order;
once opened, `inert` is gone and the drawer takes focus normally. The check
asserts both halves, because "unreachable" is only meaningful if the drawer
is reachable when it should be.

### 3. Rendered contrast over tinted and hovered backgrounds — two defects, both fixed

This is the item the shipped guard structurally could not answer.
`scripts/check-token-contrast.mjs` compares a token against a token, so it
sees `--dim` on `--pane-hd` (4.53:1) and never sees the **semi-transparent**
layers the stylesheets actually paint text on — `color-mix(in srgb, var(--fg)
6–9%, transparent)` and `color-mix(in srgb, var(--accent-solid) 6–18%,
transparent)`.

Measuring the painted result instead — compositing every translucent layer
over its ancestors, then re-measuring each hoverable ancestor while it is
genuinely hovered — found **two** defects the token-level figures missed:

| Where                                  | Was                         | Now    | Why                                                                                                                                                                                                     |
| -------------------------------------- | --------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.kbd` / `.kbd-btn` keycap chips       | **3.92:1** (3.13:1 hovered) | 13.4:1 | The chip's own fill is a tint of `--fg`, so it moves the background _toward_ whatever text colour sits on it. `--dim` on it cannot clear 4.5:1; the chip's text is now `--fg`.                          |
| The active workspace row's drag handle | **1.15:1**                  | 5.36:1 | The active row is a _fill_ surface (`--accent-fill` under white text), not a flat one. `--dim` on it was invisible; it is now white, like the row's own text and its kebab/danger actions already were. |

Both are CSS-only fixes (`styles/toolbar.css`, `styles/sidebar.css`); no token
value changed, because the tokens themselves were never the problem. The
check now measures all three text-role tokens (`--dim`, `--muted`, `--fg`)
across the app chrome _and_ the command palette, in both themes: **474
samples, every one clear of its WCAG threshold** (4.5:1 for text, 3:1 for a
graphical object).

The browser check is what guards these two fixes. A stylesheet-content
lint rule cannot: `jsdom` does not resolve `var()`, and no static rule can
know that `.ws-drag-handle` is painted on top of `--accent-fill` without
matching selectors against a real DOM.

### 4. The Settings modal at 200 % zoom — does not clip

Chromium's real browser zoom is not settable from Playwright
(`Emulation.setPageScaleFactor` is pinch-zoom and does not change layout;
`--force-device-scale-factor` changes the device pixel ratio, not the CSS
layout), so 200 % zoom is emulated the standard way: by halving the CSS
viewport. Both regimes were checked.

| 200 % of  | CSS viewport | Tier    | Modal                                           | Scroll containers                                               |
| --------- | ------------ | ------- | ----------------------------------------------- | --------------------------------------------------------------- |
| 2560×1440 | 1280×720     | desktop | **1040×664** — the audit's named 1040×720 modal | `.settings-nav-items` 794/544, `.settings-content-body` 526/526 |
| 1440×900  | 720×450      | tablet  | 672×394 (shrinks via `max-width`/`max-height`)  | `.settings-nav-items` 794/274, `.settings-content-body` 674/256 |

In both, the modal fits inside the viewport, every scroll container reaches
its own end, and **nothing inside the modal hides content it cannot get back
to** — the check walks the whole subtree for `overflow: hidden` elements
whose content overflows with no scroll container in reach. The modal's own
`overflow: hidden` is deliberate (it rounds the corners) and is checked
rather than exempted. There is no defect here.

### 5. A failed Dock kill — confirmed reported on the row

The audit's original wording described the _pre-fix_ symptom ("the silent
kill leaves a visibly stale row before the 4 s poll corrects it"). What
PR 2 shipped is the opposite: the failure is **reported**. The check
asserts the shipped behaviour — with the kill made to fail at the network
boundary, the row shows **"Failed to kill — try again"** within a second,
the status is **still there at 2 s** (so the 4 s window is real and not a
flash a fast assertion would race past), and it is **gone by 5.5 s** (so the
transient auto-clears and does not become a permanent badge).

The kill is stubbed to fail on purpose: the React component, the store, the
click handler and the status widget are all real, and only the one HTTP
response is faked. That keeps the check runnable without a Docker daemon,
which is what makes it committable at all.

### What the check does not cover

The demo dataset bounds the coverage, and the report says so rather than
implying more:

- The dock-control check writes a `.crs/dock.json` into the demo project, so
  it exercises a **config**-sourced control. Docker-sourced controls (which
  need a Docker daemon) are not exercised.
- The contrast check measures the app chrome and the command palette. A
  surface that only exists behind a specific user action — a long settings
  section, a populated task board — is not opened and measured.
- The 200 %-zoom check covers the two viewport regimes above, not every
  window size at every zoom level.
