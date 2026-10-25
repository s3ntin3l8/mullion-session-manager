# UI/UX audit — frontend

**Scope.** Mullion's React frontend (`frontend/`, ~563 source files), audited for
accessibility, interaction-feedback and information-architecture defects. The backend
(`src/`) and the CLI were not audited.

**Status.** Every blocker is fixed, and so are 18 of the 21 major and 7 of the 24 minor
findings, in four pull requests: #1895 (accessibility and contrast), #1897 (surfacing
failures instead of swallowing them), #1898 (guards on destructive actions) and #1923
(the first of a series that closes the deferred backlog one finding per pull
request). The other 20 findings are deferred and tracked as issues; see
[Deferred backlog](#deferred-backlog).

---

## How the audit was run

| Layer                    | Method                                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accessibility            | Static review of the source against WCAG 2.x: dialog and control semantics, focus order and focus management, contrast computed from the real token values, reduced motion |
| Interaction feedback     | Static review of every async path for loading, empty, failed and in-flight states, and of every destructive action for confirmation and re-entry guards                    |
| Information architecture | Static review of navigation, naming, and what is reachable on each layout tier (desktop, tablet, phone)                                                                    |
| Verification             | A hand-verification pass over every finding before it was written down                                                                                                     |

The audit was run statically against the source by three independent deep-dives, one per
axis, followed by a hand-verification pass over every finding. Each audit was
instructed to verify its own citations before reporting and to flag false positives
rather than pad the list. Forty-eight findings survived verification; two claims did
not and are not listed.

The audit itself had no dev server, so five things were left to a real browser. They were
checked afterwards; see [Runtime verification](#runtime-verification) under Evidence.

### What the code already does well

Checked and left alone. The fixes below deliberately follow these patterns rather than
inventing new ones.

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

## Severity model

- **Blocker**: a core surface is unusable for a keyboard or screen-reader user (it
  cannot be reached, operated or understood at all).
- **Major**: a serious defect that hides or loses information, or makes a task much
  harder, but has a workaround.
- **Minor**: an inconsistency, a discoverability gap or polish; the product still works.

---

## Findings

Forty-eight findings: 28 fixed and 20 deferred.

| Severity  | Findings | Fixed  | Deferred |
| --------- | -------- | ------ | -------- |
| Blocker   | 3        | 3      | 0        |
| Major     | 21       | 18     | 3        |
| Minor     | 24       | 7      | 17       |
| **Total** | **48**   | **28** | **20**   |

The defects are ordered by severity, not by screen. The recurring theme is
that most of them are **divergences from patterns the codebase had already
established**: the shared `Modal` existed and seven dialogs did not use it;
`PaneActionsMenu` implemented the menu pattern correctly and `KebabMenu` did
not; `useFocusTrap` existed and was used correctly in four of its six call
sites. The fixes are therefore mostly consolidation rather than invention.

The table lists the findings that were fixed, with the pull request that fixed each:
#1895 fixed 12 (the accessibility and contrast pass), #1897 fixed 11 (failures surfaced
instead of swallowed), #1898 fixed 4 (guards on destructive actions) and #1923 fixed 1
(the first of the series that closes the deferred backlog, one finding per pull
request). The deferred ones are in the [Deferred backlog](#deferred-backlog), under the
same numbers.

| #   | Severity | PR    | Finding                                                                                                                         | Where                                                                                                                                       | What changed                                                                                                                                                                                                                                                                                                    |
| --- | -------- | ----- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Blocker  | #1895 | Seven dialogs had no dialog semantics: no `role`, no focus trap, no Escape, an unnamed close button                             | `CreateProjectModal`, `CreateHostModal`, `CreateGroupModal`, `HostConfigModal`, `PairBridgeModal`, `GitHubDeviceFlowModal`, `SavedUrlModal` | All seven compose the shared `Modal`; its close button gained `aria-label="Close dialog"`                                                                                                                                                                                                                       |
| 2   | Blocker  | #1895 | Every Settings control had no accessible name (88 controls)                                                                     | `ui/primitives.tsx:29`                                                                                                                      | `Row` publishes its label id through context; controls use `aria-labelledby`                                                                                                                                                                                                                                    |
| 3   | Blocker  | #1895 | The closed phone/tablet drawer stayed in the tab order                                                                          | `styles/sidebar.css:58-77`                                                                                                                  | The closed drawer is `inert`, with `visibility: hidden` as the fallback                                                                                                                                                                                                                                         |
| 4   | Major    | #1895 | `--dim` failed WCAG AA in **both** themes — 182 text uses, 2.31:1–3.49:1                                                        | `styles/tokens.css`                                                                                                                         | Re-tuned to `#8a8a94` / `#666666` (4.53:1 / 4.72:1 worst case)                                                                                                                                                                                                                                                  |
| 5   | Major    | #1895 | White text on the accent/ring fills was 2.54:1–3.39:1                                                                           | `styles/sidebar.css:735`, `styles/terminal.css:359`, `styles/right-sidebar.css:64`, `styles/login.css:117`                                  | Split the palette into a **text role** and a **fill role**: new `--accent-fill` and `--badge-dim` tokens carry the white-on-fill backgrounds                                                                                                                                                                    |
| 6   | Major    | #1895 | 15 infinite animations ran with no `prefers-reduced-motion` guard                                                               | only `styles/login.css:218` had one                                                                                                         | One global guard in `styles/tokens.css`                                                                                                                                                                                                                                                                         |
| 7   | Major    | #1895 | `KebabMenu` was entirely mouse-driven — no `role`, no keys, no accessible name                                                  | `ui/KebabMenu.tsx`                                                                                                                          | The full APG menu pattern, ported from `PaneActionsMenu`                                                                                                                                                                                                                                                        |
| 8   | Major    | #1895 | Six inputs had their focus ring removed with no replacement                                                                     | `styles/command-palette.css:41`, `styles/modals.css:135,149,357`, `styles/sidebar.css:260,1957`                                             | `:focus-visible` outlines added (nine sites in the end — see below)                                                                                                                                                                                                                                             |
| 9   | Major    | #1897 | Session rename was optimistic with no rollback, and all three call sites dropped the rejection                                  | `store/slices/sessions.ts:205-215`; `PaneTab.tsx:271`, `Sidebar.tsx:1941`, `MobileSessionBar.tsx:201`                                       | The store rolls the optimistic rename back and rethrows; the three call sites report it                                                                                                                                                                                                                         |
| 10  | Major    | #1897 | The Dock's kill path swallowed its error — while its two siblings in the same file both reported theirs                         | `dock/DockProjectGroup.tsx:776-788`                                                                                                         | The failure is reported on the row, like its two siblings already were                                                                                                                                                                                                                                          |
| 11  | Major    | #1897 | The pane-overflow kill closed the pane first, then logged the failure to the console only                                       | `PaneActionsMenu.tsx:242-247`                                                                                                               | The pane is already closed, so the failure goes to the app-wide toast                                                                                                                                                                                                                                           |
| 12  | Major    | #1897 | Workspace and group delete failures were unhandled rejections                                                                   | `WorkspaceSwitcher.tsx:321,333`                                                                                                             | Both the grouped and the ungrouped list's delete and rename paths report it                                                                                                                                                                                                                                     |
| 13  | Major    | #1897 | `ServerInfoSection` showed "Loading…" forever — `null` meant both loading and failed                                            | `settings/sections/ServerInfoSection.tsx:23-38`                                                                                             | The two probes have their own failure state and their own retry                                                                                                                                                                                                                                                 |
| 14  | Major    | #1897 | The sidebar showed "Welcome to Mullion" while projects were loading, and forever if the fetch failed — no `projectsLoaded` flag | `Sidebar.tsx:498-521`; `store/slices/projects.ts:9,13`                                                                                      | `projectsLoaded` and `projectsError` separate loading, empty and failed                                                                                                                                                                                                                                         |
| 15  | Major    | #1897 | A failed task fetch rendered as "No tasks yet." and invited the user to create one                                              | `store/slices/tasks.ts:93-105`; `UnifiedBoard.tsx:743-751`                                                                                  | `tasksError` separates a failed fetch from an empty task list                                                                                                                                                                                                                                                   |
| 16  | Major    | #1898 | The GitHub App "Clear" destroyed the App ID and private key in one click, with no confirmation                                  | `settings/sections/IntegrationsSection.tsx:297-312,359`                                                                                     | The Clear is a `ConfirmButton`, and the button is disabled while the clear is in flight                                                                                                                                                                                                                         |
| 17  | Major    | #1898 | The GitHub "Disconnect" revoked the credential in one click, with no confirmation and no pending state                          | `settings/sections/IntegrationsSection.tsx:60-68,91`                                                                                        | The Disconnect is a `ConfirmButton`, and the button is disabled while it is in flight                                                                                                                                                                                                                           |
| 18  | Major    | #1898 | "Add host" could be submitted twice with Enter — no re-entry guard                                                              | `CreateHostModal.tsx:41-61`                                                                                                                 | The submit is guarded against re-entry, the same shape `CreateProjectModal` already had                                                                                                                                                                                                                         |
| 19  | Major    | #1895 | `Segmented` conveyed its selection by CSS class alone — no `aria-pressed`/`aria-checked`, no group name                         | `ui/primitives.tsx:99-112`                                                                                                                  | `role="radiogroup"` + `role="radio"` + `aria-checked`, with arrow-key/Home/End selection and a roving tab stop                                                                                                                                                                                                  |
| 20  | Major    | #1895 | `TerminalToasts` had no live region — copy and upload feedback was silent to assistive technology                               | `terminal-pane/TerminalToasts.tsx`                                                                                                          | A permanent `role="status"` region, with the failure variants raised to `role="alert"`                                                                                                                                                                                                                          |
| 24  | Major    | #1923 | `findSessionWorkspace` returns the first match, so "which workspace is this session in?" has an arbitrary answer                | `panelUtils.ts:90-95`                                                                                                                       | `findSessionWorkspaces` returns **every** workspace that claims the session, and the one caller switches workspace only when the answer is unique and is not the workspace the user is already in — otherwise it opens the session where the user is, rather than picking a workspace by the server's row order |
| 25  | Minor    | #1895 | `aria-current` existed in exactly one place app-wide                                                                            | `MobileSessionBar.tsx:320` only                                                                                                             | Added to the active workspace item, the active Settings nav item, and the active sidebar session row — which also gained the `.session-item.active` visual state it never had                                                                                                                                   |
| 27  | Minor    | #1895 | No `<h1>`/heading structure in the app shell                                                                                    | `App.tsx:1522-1528`, `Sidebar.tsx:441-453`                                                                                                  | A visually-hidden `<h1>`, `.settings-modal-title` promoted to `<h2>`, `.sidebar-section-title` to `<h3>` (both with explicit margin resets — nothing in this codebase resets the UA's heading margins)                                                                                                          |
| 28  | Minor    | #1897 | `GitPanel` shows "Loading…" forever when git-status fails; stale data has no staleness marker                                   | `git-panel`/`GitPanel` status fetch                                                                                                         | A failed first fetch shows the error and a retry; a failed later refresh marks the data stale                                                                                                                                                                                                                   |
| 29  | Minor    | #1897 | `SourceControlSection`'s fetch failure is console-only — its sibling pull is not                                                | `SourceControlSection.tsx` fetch handler                                                                                                    | The fetch now has its own visible error, like its sibling pull                                                                                                                                                                                                                                                  |
| 30  | Minor    | #1897 | `BrowserPanel`'s favorites failure is console-only, and renders as "no favorites"                                               | `BrowserPanel.tsx` favourites fetch                                                                                                         | The failure is reported through the app-wide toast                                                                                                                                                                                                                                                              |
| 31  | Minor    | #1897 | `SidebarDevices` shows device errors only in a `title` tooltip                                                                  | `SidebarDevices` error path                                                                                                                 | The error is inline in the failing row, not only in a `title` tooltip                                                                                                                                                                                                                                           |
| 32  | Minor    | #1898 | `ConfirmButton` disarms silently after 6 s, with no countdown — while the pane-kill path _does_ show one                        | `ui/ConfirmButton.tsx`                                                                                                                      | The arm window counts down in the button and in its title                                                                                                                                                                                                                                                       |

### Blocker detail

#### 1. Seven dialogs had no dialog semantics

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

#### 2. Every Settings control had no accessible name

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

#### 3. The closed drawer stayed in the tab order

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

### Notes on the fixes

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

---

## Guardrails

A fix that can silently regress is not fixed. These checks keep the findings fixed.

### Settings control names (blocker 2)

`frontend/src/ui/primitives.a11y.test.tsx` parses the Settings tree with the TypeScript compiler API and fails if any control is
left without a name. It resolves the component boundary too, so a control rendered by
a helper component that is itself inside a `Row` is correctly recognised as named.

### Contrast (findings 4 and 5)

`scripts/check-token-contrast.mjs` parses the token blocks
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

The audit recorded no structural guard for the remaining fixes beyond these.

### Rendered contrast (the translucent-layer limit)

The guard's other limit is structural: it compares a token against a token, so it cannot
see a **translucent** layer painted under the text. The runtime verification below found
two places where that mattered — a keycap chip and the active workspace row — both of
which sat under 4.5:1 once their real painted background was composited.
`scripts/verify-ui-runtime.mjs` (`make verify-ui`) is the guard for that layer: it
measures the composited, hovered result in a real browser, and asserts the two fixed
targets **by name**, so a partial revert of either fix fails it. Neither guard subsumes
the other, and the token guard stays the one that runs on every push.

### The session's workspace lookup (finding 24)

`frontend/src/panelUtils.test.ts` and `frontend/src/hooks/usePanelOpener.test.ts` are
the guard for finding 24: the first pins that `findSessionWorkspaces` returns _every_
workspace claiming the session, the second pins that the caller switches workspace only
on a unique, non-active claimant and otherwise opens the session where the user is.

This one is a **unit-test** guard, not a lint-time script, because the defect was a
_decision_ — which workspace wins — and not a value that a script could read out of the
source. A script could only check that the old first-match lookup is gone; the
behaviour that replaces it is what actually needs pinning.

---

## Evidence

The audit was static, so its evidence is the file and line citations in the findings,
which were taken against the tree as audited and will drift as the code moves. The five
things a static pass could not settle were then checked in a real browser (below).

Visual captures of the running app can be regenerated from an isolated demo instance;
they are local only and gitignored:

```bash
node <path to ai-agent-skills>/plugins/audit/skills/audit/scripts/capture.mjs 2026-10-frontend-ui-ux
```

This reads `docs/audit/capture.2026-10-frontend-ui-ux.json` if it exists, else
[`capture.json`](capture.json) (see the [index](README.md)), and writes into
`docs/audit/assets/2026-10-frontend-ui-ux/`. Nothing outside that folder is touched. The
script is from the `audit` plugin in `s3ntin3l8/ai-agent-skills`; the commit used for a
capture should be noted here when one is taken.

### Runtime verification

The audit was static — no dev server was running — so five things it could
not settle by reading code were left open in what used to be this
document's "Runtime verification still owed" section. They have now been
checked against a real browser by **`scripts/verify-ui-runtime.mjs`**
(`make verify-ui`), which boots a throwaway Mullion
(`scripts/demo/instance.mjs`: scratch DB, scratch `SESSIONS_DIR`/`HOME`, clean
env, its own loopback ports), drives it with real Chromium, and tears
everything down again — including the demo's session scopes.

The script is committed and re-runnable, and it exits non-zero when a check
fails, so it works as a manual gate. Its contrast arithmetic lives in
`scripts/lib/color-math.mjs` and is pinned by
`test/scripts/color-math.test.ts`, so a change to the maths fails the
ordinary test suite rather than silently changing what the browser check
measures. It is deliberately **not** wired into CI: it needs a browser binary
and a demo instance, exactly like the opt-in `make test-e2e` suite, which is
likewise not a required status check.

#### 1. Focus after a palette-initiated workspace switch — the defect is real

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

#### 2. The `inert` drawer — confirmed unreachable

At 375×812 the closed drawer carries `inert` (the property _and_ the
attribute), 30 Tab presses land on **zero** elements inside it, and the walk
does move — three distinct controls outside the drawer were reached, so this
is not a pass by accident. The sharper half of the property also holds: while
closed, the drawer **refuses** programmatic focus as well as the tab order;
once opened, `inert` is gone and the drawer takes focus normally. The check
asserts both halves, because "unreachable" is only meaningful if the drawer
is reachable when it should be.

#### 3. Rendered contrast over tinted and hovered backgrounds — two defects, both fixed

This is the item the shipped guard structurally could not answer.
`scripts/check-token-contrast.mjs` compares a token against a token, so it
sees `--dim` on `--pane-hd` (4.53:1) and never sees the **semi-transparent**
layers the stylesheets actually paint text on — `color-mix(in srgb, var(--fg)
6–9%, transparent)` and `color-mix(in srgb, var(--accent-solid) 6–18%,
transparent)`.

Measuring the painted result instead — compositing every translucent layer
over its ancestors, then re-measuring each hoverable ancestor while it is
genuinely hovered — found **two** defects the token-level figures missed.
Both rows below quote the **dark theme**, which is the worse of the two for
the chips; the drag handle's "was" is worse still in the light theme —
**1.00:1** at the handle's 0.4 opacity (1.09:1 at full opacity), against
1.15:1 in the dark:

| Where                                  | Was                         | Now                          | Why                                                                                                                                                                                                     |
| -------------------------------------- | --------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.kbd` / `.kbd-btn` keycap chips       | **3.92:1** (3.12:1 hovered) | **11.45:1** (9.11:1 hovered) | The chip's own fill is a tint of `--fg`, so it moves the background _toward_ whatever text colour sits on it. `--dim` on it cannot clear 4.5:1; the chip's text is now `--fg`.                          |
| The active workspace row's drag handle | **1.15:1**                  | **5.35:1**                   | The active row is a _fill_ surface (`--accent-fill` under white text), not a flat one. `--dim` on it was invisible; it is now white, like the row's own text and its kebab/danger actions already were. |

Both are CSS-only fixes (`styles/toolbar.css`, `styles/sidebar.css`); no token
value changed, because the tokens themselves were never the problem. The
check now measures all three text-role tokens (`--dim`, `--muted`, `--fg`)
across the app chrome _and_ the command palette, in both themes: **293
samples across the four scope/theme combinations, every one clear of its WCAG
threshold** (4.5:1 for text, 3:1 for a graphical object).

##### What actually guards the two fixes

A stylesheet-content lint rule cannot guard them: `jsdom` does not resolve
`var()`, and no static rule can know that `.ws-drag-handle` is painted on top
of `--accent-fill` without matching selectors against a real DOM. The browser
check can — but only if it is told what to look at, and the token sweep alone
is not enough.

The token sweep sees elements painted in `--dim`, `--muted` or `--fg`. Both
fixes deliberately moved their targets **off** `--dim`: the chips to `--fg`,
the active row's handle to plain white. So once fixed, they leave the token
sample set entirely. A full revert is still caught (the colour goes back to
`--dim`), but a **partial** revert is not: dropping only the `opacity: 1`
from the active row's drag handle leaves a white icon at 40 % over the
emerald fill — 2.10:1 in the dark theme, 2.29:1 in the light one, both under
the 3:1 WCAG 1.4.11 asks of a graphical object — and nothing in the token
sweep would ever look at it.

So three targets are asserted **by name**, against a stated minimum, in every
theme, and judged on the state they are **actually painted in** with no
allowance for a de-emphasis that lifts on hover:

| Target                                   | What it paints              | Minimum |
| ---------------------------------------- | --------------------------- | ------- |
| `.workspace-item.active .ws-drag-handle` | a graphical object (an SVG) | 3:1     |
| `.kbd`                                   | text                        | 4.5:1   |
| `.kbd-btn`                               | text                        | 4.5:1   |

Both reverts are verified to fail the check: dropping `opacity: 1` reports
the handle at 2.10:1 (dark) / 2.29:1 (light), and putting `--dim` back on the
chips reports them at 3.92:1 — caught by the guards _and_ by the token sweep.

##### How a faded element is judged

An element's `opacity` is part of what it paints, so it reaches the ratio: an
element at `opacity: 0.4` is measured at 40 % strength, not as if it were
opaque. But a deliberate de-emphasis — this app drops an inactive workspace
row's drag handle to `opacity: 0.4` until the row is hovered — is a
reversible presentation state, so it is judged in the state it is meant to be
read in. The rule is therefore: **judge on the worst state at the element's
highest observed opacity**. A de-emphasis that lifts on hover is judged
engaged; a fade that never lifts is judged exactly as painted, because that
is the state it lives in.

Before this rule the opacity never reached the ratio at all, and a fade that
never lifted was reported as a pass.

##### The arithmetic is pinned by tests

The contrast maths is the deliverable of this check, so it lives in its own
module — `scripts/lib/color-math.mjs` — and `test/scripts/color-math.test.ts`
pins it against known WCAG pairs and against the real token values: the
`color(srgb …)` form Chromium reports `color-mix()` as (which is the form the
whole tinted-surface argument depends on), the compositing of translucent
layers, the ratios for `--dim` on `--accent-fill` (1.57:1), white on it
(5.35:1) and white at 40 % opacity on it (2.10:1), and the judgement rule
itself. A parse regression there would otherwise fail silently as "all clear".

##### The check asserts its own preconditions

A check that silently measures the wrong thing is worse than no check, so:

- The theme toggle must actually switch to the light theme, and the two
  themes must resolve different `--dim` values — otherwise the "light" pass
  would re-measure the dark theme and the run would look like it covered both
  themes while covering one twice.
- Every scope must contribute at least 25 samples, and all four scope/theme
  combinations must have been measured — a sweep that stopped finding
  elements would otherwise still report "all clear".
- Each scope measures ONE surface. With the command palette open, the app
  chrome behind it is covered by the palette's backdrop: it cannot be hovered
  and the user cannot see it, so it is measured in the app scope instead.
  Without that, the same element would be judged differently in the two
  scopes — its de-emphasis lifts on hover in the app scope and cannot lift
  behind an overlay.

#### 4. The Settings modal at 200 % zoom — does not clip

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

#### 5. A failed Dock kill — confirmed reported on the row

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

#### What the check does not cover

The demo dataset bounds the coverage, and the report says so rather than
implying more:

- The dock-control check writes a `.crs/dock.json` into the demo project, so
  it exercises a **config**-sourced control. Docker-sourced controls (which
  need a Docker daemon) are not exercised.
- The contrast check measures the app chrome and the command palette, each as
  its own scope. A surface that only exists behind a specific user action — a
  long settings section, a populated task board — is not opened and measured.
- The **inactive** workspace row's drag handle is deliberately de-emphasised
  to `opacity: 0.4` until the row is hovered, so at rest it paints at
  **1.88:1** (dark) / **1.74:1** (light) over `--sidebar` — under the 3:1
  WCAG 1.4.11 asks of a graphical object. The check judges it in its engaged
  state (4.60:1 / 4.63:1), which is the state it carries meaning in, and
  reports the resting ratio rather than hiding it. Filed as
  [#1908](https://github.com/s3ntin3l8/mullion-session-manager/issues/1908).
- The 200 %-zoom check covers the two viewport regimes above, not every
  window size at every zoom level.

---

## Deferred backlog

| #   | Severity | Finding                                                                                                                                               | Issue                                                                     |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 21  | Major    | The command palette was hidden on the phone tier, and the navigator had no Commands tab (`styles/mobile.css:31-33`; `PhoneNavigator.tsx:17`)          | [#1880](https://github.com/s3ntin3l8/mullion-session-manager/issues/1880) |
| 22  | Major    | The Dock is hidden on every coarse-pointer tier, but the command palette still offers the Dock's configuration commands (`styles/tablet.css:113-120`) | [#1881](https://github.com/s3ntin3l8/mullion-session-manager/issues/1881) |
| 23  | Major    | The phone tier's cross-workspace session swap has no visible signal and no way back (`hooks/usePanelOpener.ts:246-253`)                               | [#1882](https://github.com/s3ntin3l8/mullion-session-manager/issues/1882) |
| 26  | Minor    | Two collapsible headers are `<div onClick>` with no keyboard path (`SourceControlSection.tsx:277`, `Sidebar.tsx:2139`)                                | [#1893](https://github.com/s3ntin3l8/mullion-session-manager/issues/1893) |
| 33  | Minor    | "host" names two things: a remote agent, and a local Android device (`HostsSection.tsx:280` vs `DevicesSection.tsx`)                                  | [#1878](https://github.com/s3ntin3l8/mullion-session-manager/issues/1878) |
| 34  | Minor    | "Workspace" names two things: a saved layout, and a Settings section group (`WorkspaceSwitcher.tsx:266` vs `settingsSections.tsx:141-167`)            | [#1878](https://github.com/s3ntin3l8/mullion-session-manager/issues/1878) |
| 35  | Minor    | The sidebar's project tree is not workspace-scoped, while the Dock's is (`Sidebar.tsx`, project tree)                                                 | [#1877](https://github.com/s3ntin3l8/mullion-session-manager/issues/1877) |
| 36  | Minor    | The palette's group labels do not describe their contents; "Navigate" holds one row (`CommandPalette.tsx`, group definitions)                         | [#1879](https://github.com/s3ntin3l8/mullion-session-manager/issues/1879) |
| 37  | Minor    | Palette coverage is not uniform — no Devices, Hosts, Settings, Timeline or new-workspace command (`CommandPalette.tsx`, command list)                 | [#1879](https://github.com/s3ntin3l8/mullion-session-manager/issues/1879) |
| 38  | Minor    | The phone Settings list has no search, while the desktop rail does (`styles/mobile.css`, `Settings.tsx` nav)                                          | [#1880](https://github.com/s3ntin3l8/mullion-session-manager/issues/1880) |
| 39  | Minor    | An ended session's status label composites to 1.54:1–1.70:1 (ended-session status styling)                                                            | [#1886](https://github.com/s3ntin3l8/mullion-session-manager/issues/1886) |
| 40  | Minor    | One timestamp format breaks from the app's shared relative-time formatter (review-relay section timestamp)                                            | [#1890](https://github.com/s3ntin3l8/mullion-session-manager/issues/1890) |
| 41  | Minor    | `NotificationBell` uses `aria-haspopup="true"` where `"dialog"` is correct (`NotificationBell.tsx:593`)                                               | [#1894](https://github.com/s3ntin3l8/mullion-session-manager/issues/1894) |
| 42  | Minor    | The sidebar's "Projects" header shows the literal word "sessions" where a count belongs (`Sidebar.tsx:444`)                                           | [#1889](https://github.com/s3ntin3l8/mullion-session-manager/issues/1889) |
| 43  | Minor    | A palette action that does not move focus deliberately leaves focus on `<body>` (`CommandPalette.tsx:292`)                                            | [#1884](https://github.com/s3ntin3l8/mullion-session-manager/issues/1884) |
| 44  | Minor    | There is no skeleton primitive — twenty-plus panels render the bare word "Loading…" (no `skeleton` anywhere in `frontend/src/styles`)                 | [#1885](https://github.com/s3ntin3l8/mullion-session-manager/issues/1885) |
| 45  | Minor    | The global keyboard shortcuts are discoverable nowhere in the UI (`hooks/useGlobalShortcuts.ts`, not user-facing)                                     | [#1887](https://github.com/s3ntin3l8/mullion-session-manager/issues/1887) |
| 46  | Minor    | The type scale is px-only, so the OS text-size preference has no effect at all (no `rem` in the type scale in `frontend/src/styles`)                  | [#1888](https://github.com/s3ntin3l8/mullion-session-manager/issues/1888) |
| 47  | Minor    | A blocked task is visible only through the board's own "Blocked only" toggle (`UnifiedBoard.tsx:172-186`)                                             | [#1891](https://github.com/s3ntin3l8/mullion-session-manager/issues/1891) |
| 48  | Minor    | A host's derived status has exactly one consumer: Settings → Hosts (`hostStatus.ts`)                                                                  | [#1892](https://github.com/s3ntin3l8/mullion-session-manager/issues/1892) |

One more finding came out of the runtime verification: the inactive workspace row's drag
handle paints at 1.88:1 (dark) / 1.74:1 (light) at rest, under the 3:1 WCAG 1.4.11 asks of a
graphical object. It is not graded, and not counted in the 48 above.

| Finding                                               | Severity   | Issue                                                                     |
| ----------------------------------------------------- | ---------- | ------------------------------------------------------------------------- |
| Inactive workspace row's drag handle contrast at rest | Not graded | [#1908](https://github.com/s3ntin3l8/mullion-session-manager/issues/1908) |
