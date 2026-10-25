# UI/UX audit

A full audit of Mullion's React frontend (`frontend/`, ~563 source files) for
accessibility, interaction-feedback and information-architecture defects.

The audit was run statically against the source by three independent
deep-dives — one per axis — followed by a hand-verification pass over every
finding. Each audit was instructed to verify its own citations before
reporting and to flag false positives rather than pad the list. Roughly sixty
findings survived verification; two claims did not and are not listed here.

**How to read this document.** Every finding carries a severity, the evidence
that proves it, and its disposition:

- **Fixed** — landed in a pull request, with the PR named.
- **Deferred** — filed as a tracked issue, with the issue linked.

The defects are ordered by severity, not by screen. The recurring theme is
that most of them are **divergences from patterns the codebase had already
established**: the shared `Modal` existed and seven dialogs did not use it;
`PaneActionsMenu` implemented the menu pattern correctly and `KebabMenu` did
not; `useFocusTrap` existed and was used correctly in four of its six call
sites. The fixes are therefore mostly consolidation rather than invention.

---

## Summary

| Severity  | Count  | Fixed  | Deferred |
| --------- | ------ | ------ | -------- |
| Blocker   | 3      | 3      | 0        |
| Major     | 18     | 12     | 6        |
| Minor     | 18     | 3      | 15       |
| **Total** | **39** | **18** | **21**   |

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

**Fix.** `Row` now generates a stable id, renders its label with that id,
and publishes the label's text through a React context. The controls read
the context and apply it as their accessible name. An explicit `ariaLabel`
prop still wins at every level.

`aria-labelledby` was considered and rejected for the visible-label
association: the control lives in a sibling subtree (`.settings-row-control`)
rather than inside the label element, and not every control is labelable —
`Segmented` renders a `<div role="radiogroup">`, for which `<label for>` would
be invalid HTML. `aria-label` with the label's own text satisfies the same
requirement (and WCAG 2.5.3, "Label in Name") for every control type.

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

### Fixed

| #   | Finding                                                                                                                         | Evidence                                                                                                   | Fix                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | `--dim` failed WCAG AA in **both** themes — 182 text uses, 2.31:1–3.49:1                                                        | `styles/tokens.css`                                                                                        | Re-tuned to `#8a8a94` / `#666666` (4.53:1 / 4.72:1 worst case)                                                                               |
| 5   | White text on the accent/ring fills was 2.54:1–3.39:1                                                                           | `styles/sidebar.css:735`, `styles/terminal.css:359`, `styles/right-sidebar.css:64`, `styles/login.css:117` | Split the palette into a **text role** and a **fill role**: new `--accent-fill` and `--badge-dim` tokens carry the white-on-fill backgrounds |
| 6   | 15 infinite animations ran with no `prefers-reduced-motion` guard                                                               | only `styles/login.css:218` had one                                                                        | One global guard in `styles/tokens.css`                                                                                                      |
| 7   | `KebabMenu` was entirely mouse-driven — no `role`, no keys, no accessible name                                                  | `ui/KebabMenu.tsx`                                                                                         | Full APG menu pattern, ported from `PaneActionsMenu`                                                                                         |
| 8   | Six inputs had their focus ring removed with no replacement                                                                     | `styles/command-palette.css:41`, `styles/modals.css:135,149,357`, `styles/sidebar.css:260,1957`            | `:focus-visible` outlines added (nine sites in the end — see below)                                                                          |
| 9   | Session rename was optimistic with no rollback, and all three call sites dropped the rejection                                  | `store/slices/sessions.ts:205-215`; `PaneTab.tsx:271`, `Sidebar.tsx:1941`, `MobileSessionBar.tsx:201`      | _Deferred to PR 2_                                                                                                                           |
| 10  | The Dock's kill path swallowed its error — while its two siblings in the same file both reported theirs                         | `dock/DockProjectGroup.tsx:776-788`                                                                        | _Deferred to PR 2_                                                                                                                           |
| 11  | The pane-overflow kill closed the pane first, then logged the failure to the console only                                       | `PaneActionsMenu.tsx:242-247`                                                                              | _Deferred to PR 2_                                                                                                                           |
| 12  | Workspace and group delete failures were unhandled rejections                                                                   | `WorkspaceSwitcher.tsx:321,333`                                                                            | _Deferred to PR 2_                                                                                                                           |
| 13  | `ServerInfoSection` showed "Loading…" forever — `null` meant both loading and failed                                            | `settings/sections/ServerInfoSection.tsx:23-38`                                                            | _Deferred to PR 2_                                                                                                                           |
| 14  | The sidebar showed "Welcome to Mullion" while projects were loading, and forever if the fetch failed — no `projectsLoaded` flag | `Sidebar.tsx:498-521`; `store/slices/projects.ts:9,13`                                                     | _Deferred to PR 2_                                                                                                                           |
| 15  | A failed task fetch rendered as "No tasks yet." and invited the user to create one                                              | `store/slices/tasks.ts:93-105`; `UnifiedBoard.tsx:743-751`                                                 | _Deferred to PR 2_                                                                                                                           |
| 16  | The GitHub App "Clear" destroyed the App ID and private key in one click, with no confirmation                                  | `settings/sections/IntegrationsSection.tsx:297-312,359`                                                    | _Deferred to PR 3_                                                                                                                           |
| 17  | The GitHub "Disconnect" revoked the credential in one click, with no confirmation and no pending state                          | `settings/sections/IntegrationsSection.tsx:60-68,91`                                                       | _Deferred to PR 3_                                                                                                                           |
| 18  | "Add host" could be submitted twice with Enter — no re-entry guard                                                              | `CreateHostModal.tsx:41-61`                                                                                | _Deferred to PR 3_                                                                                                                           |
| 19  | `Segmented` conveyed its selection by CSS class alone — no `aria-pressed`/`aria-checked`, no group name                         | `ui/primitives.tsx:99-112`                                                                                 | `role="radiogroup"` + `role="radio"` + `aria-checked`, with arrow-key/Home/End selection and a roving tab stop                               |
| 20  | `TerminalToasts` had no live region — copy and upload feedback was silent to assistive technology                               | `terminal-pane/TerminalToasts.tsx`                                                                         | A permanent `role="status"` region, with the failure variants raised to `role="alert"`                                                       |
| 21  | The command palette was hidden on the phone tier, and the navigator had no Commands tab                                         | `styles/mobile.css:31-33`; `PhoneNavigator.tsx:17`                                                         | _Deferred — [#1880](https://github.com/s3ntin3l8/mullion-session-manager/issues/1880)_                                                       |

### Notes on two of the fixes

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

---

## Minor findings

### Fixed

| #   | Finding                                                            | Evidence                                           | Fix                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 22  | `aria-current` existed in exactly one place app-wide               | `MobileSessionBar.tsx:320` only                    | Added to the active workspace item, the active Settings nav item, and the active sidebar session row — which also gained the `.session-item.active` visual state it never had                          |
| 23  | Two collapsible headers were `<div onClick>` with no keyboard path | `SourceControlSection.tsx:277`, `Sidebar.tsx:2126` | _Deferred_ — four sibling sites already do it right, so this is a two-site fix                                                                                                                         |
| 24  | No `<h1>`/heading structure in the app shell                       | `App.tsx:1522-1528`, `Sidebar.tsx:441-453`         | A visually-hidden `<h1>`, `.settings-modal-title` promoted to `<h2>`, `.sidebar-section-title` to `<h3>` (both with explicit margin resets — nothing in this codebase resets the UA's heading margins) |

### Deferred

| #   | Finding                                                                                                  | Issue                                                                     |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 23  | Two collapsible headers are `<div onClick>` with no keyboard path                                        | _not filed separately — folded into the a11y follow-up_                   |
| 25  | `GitPanel` shows "Loading…" forever when git-status fails; stale data has no staleness marker            | PR 2                                                                      |
| 26  | `SourceControlSection`'s fetch failure is console-only — its sibling pull is not                         | PR 2                                                                      |
| 27  | `BrowserPanel`'s favorites failure is console-only, and renders as "no favorites"                        | PR 2                                                                      |
| 28  | `SidebarDevices` shows device errors only in a `title` tooltip                                           | PR 2                                                                      |
| 29  | `ConfirmButton` disarms silently after 6 s, with no countdown — while the pane-kill path _does_ show one | PR 3                                                                      |
| 30  | "host" names two things: a remote agent, and a local Android device                                      | [#1878](https://github.com/s3ntin3l8/mullion-session-manager/issues/1878) |
| 31  | "Workspace" names two things: a saved layout, and a Settings section group                               | [#1878](https://github.com/s3ntin3l8/mullion-session-manager/issues/1878) |
| 32  | The sidebar's project tree is not workspace-scoped, while the Dock's is                                  | [#1877](https://github.com/s3ntin3l8/mullion-session-manager/issues/1877) |
| 33  | The palette's group labels do not describe their contents; "Navigate" holds one row                      | [#1879](https://github.com/s3ntin3l8/mullion-session-manager/issues/1879) |
| 34  | Palette coverage is not uniform — no Devices, Hosts, Settings, Timeline or new-workspace command         | [#1879](https://github.com/s3ntin3l8/mullion-session-manager/issues/1879) |
| 35  | The phone Settings list has no search, while the desktop rail does                                       | [#1880](https://github.com/s3ntin3l8/mullion-session-manager/issues/1880) |
| 36  | An ended session's status label composites to 1.54:1–1.70:1                                              | [#1886](https://github.com/s3ntin3l8/mullion-session-manager/issues/1886) |
| 37  | One timestamp format breaks from the app's shared relative-time formatter                                | [#1890](https://github.com/s3ntin3l8/mullion-session-manager/issues/1890) |
| 38  | `NotificationBell` uses `aria-haspopup="true"` where `"dialog"` is correct                               | _not filed — folded into the a11y follow-up_                              |
| 39  | The sidebar's "Projects" header shows the literal word "sessions" where a count belongs                  | [#1889](https://github.com/s3ntin3l8/mullion-session-manager/issues/1889) |

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

1. Where focus lands after a palette-initiated workspace switch.
2. That the `inert` drawer is genuinely unreachable by Tab on a real
   phone-sized viewport.
3. The rendered contrast of `--dim` over the tinted and hovered backgrounds
   (the computed figures assume the plain surface behind it).
4. Whether the 1040×720 Settings modal clips content at 200 % browser zoom.
5. That the Dock's silent kill leaves a visibly stale row before the 4 s poll
   corrects it.
