# Browser previews

Mullion can show a project's dev server — or any external URL — in a
dockview panel alongside your terminals. It has two distinct modes,
switched automatically by whether `PREVIEW_BASE_HOST` is set — there's no
separate flag:

- **`PREVIEW_BASE_HOST` unset (default): direct embed.** The panel's iframe
  points straight at the target URL — no proxy, no extra infra. This is
  what you get out of the box, including during local development where
  Mullion itself is served over plain http.
- **`PREVIEW_BASE_HOST` set: subdomain proxy.** Mullion fetches the target
  itself and re-serves it same-origin. Needed once Mullion's own dashboard
  is served over https (see "Why the proxy exists" below) and buys framing
  sites that refuse direct embedding.

**Preview or Agent's browser?** The Preview on this page is
an iframe in _your_ browser: open it from the command palette ("Open browser:
preview…" for a project target, "Open browser: blank preview" for any URL,
"Open browser: <label>" for a saved URL) or from a project's Preview menu. It is
not the **Agent's browser** ([browser-automation.md](browser-automation.md)),
the session's server-side Chromium its agent drives, which opens from a
session pane's menu or the palette's "Open browser: agent's browser · <session>" (on the
phone and the rails layouts, the right sidebar's Browser view).

**One Browser pane, two modes.** From 1100px both open in the same pane,
titled "Browser · Preview: <target>" or "Browser · Agent's browser:
<session>". A switch at the left of its toolbar (on its own row above the
address when the pane is narrow) flips the pane between **Preview** and
**Agent's browser** in place; each mode keeps its page while the pane is
open. Preview keeps its target dropdown and the favorites star; back and
forward are in Agent's browser only, since an iframe's history cannot be
read. A pane opened as a preview and switched to Agent's browser takes the
project's focused (or last-focused) session at that moment and stays on it;
the switch names that session. The switch never starts a browser by itself:
it first asks whether the session has one, and a session without one shows
"<session> has no browser yet." and an **Open browser** button. Agent's
browser is unavailable (with the reason on hover) when the project has no
session, or for a blank or external preview with no project. When the
session ends the pane falls back to Preview, or closes if it has no
project. Without `BROWSER_ENABLED` there is no switch and the pane is
Preview only. The mode is saved with the workspace layout, so a reload
keeps it.

**Open in the other one (⇄).** The ⇄ button at the end of the toolbar opens
the current address in the other mode and switches to it (#3373). It is not a
copy of the address field, because the two engines see addresses differently:

- **Preview → Agent's browser** uses the address the preview loaded, not where
  you clicked inside it (a cross-origin iframe does not report that); the
  tooltip names the address. A typed, saved or followed address goes as is.
  For a project preview the server works out the address
  (`GET /api/sessions/:id/browser/address-for-preview?slug=`,
  `src/services/browser-handoff.ts`): the preview's upstream, resolved as the
  proxy resolves it, read from the host the session's browser target names. A
  dev server on a bare port or on `localhost` is that host's own `localhost`,
  so it only travels when the session's browser runs on the same host as the
  dev server. The client names the preview by its slug, never by the iframe's
  address, so the `__mullion_preview` token never reaches the agent's browser.
  ⇄ counts as an explicit open: it attaches, and so launches, the session's
  browser.
- **Agent's browser → Preview** uses the page's own address as the server
  reports it. `POST /api/sessions/:id/browser/preview-for-address` (the
  address in the body, so it stays out of the request log) says whether its origin is one of the project's dev servers, branch previews or
  preview targets (from the session browser's host); if it is, the preview
  opens that target through the proxy, on the same page. Any other http(s)
  page opens as an external address, and the pane keeps its project.
- ⇄ is disabled, with the reason as its tooltip, for anything that is not http
  or https, for a `localhost` address that is not one of the project's dev
  servers (it means a different machine to each engine; `0.0.0.0` and `[::]`
  count as `localhost`), for a dev server on another host than the session's
  browser, and for a preview proxy address pasted as an external one
  (`preview-<slug>.<host>`, or anything carrying `__mullion_preview`). A name
  only one network resolves (a docker-compose service such as
  `http://web:3000`) is sent as is: the agent's browser resolves it on its
  own host.
- An external preview that cannot load says "This site cannot be shown as a
  preview. The agent's browser can show it." and offers **Open in the agent's
  browser**. A page that forbids framing without going through the proxy
  cannot be detected (the iframe just shows the browser's own error), so that
  case has only ⇄.
- Opening a project's preview again (the Dock, a branch row, a preview
  target) puts back the pane's own target if ⇄ had opened something else in
  it.

**Quick pick (▾).** The "▾" right after the address, in both modes, lists
where the pane's project can be opened (#3003). It is a popover with a mouse
and a sheet with 48px rows on a touch screen. Three groups, in this order:

1. **Running now**: the project's Dock commands whose output printed a dev
   server banner (the same detection as below, so it reads the port the
   server printed), and the Docker Compose services that publish a port, one
   row per published TCP port, labelled with their stack. Every published
   port is listed, so a database's port shows too; picking one shows whatever it
   answers. Both are detected on
   this server only: for a project on another host the group says so instead.
   A Dock session serving a branch preview is listed as that branch preview.
   Compose services follow **Settings → Dock → "Docker Compose services"**.
2. **Saved**: the project's dev server (`devServerUrl`), its named targets
   (see "Named project targets" below) and its branch previews.
3. **Recent**: the addresses this browser opened lately in that mode, kept on
   this device only (up to eight per mode). A preview proxy address is never
   kept.

What a pick opens depends on the mode:

- **Preview**, with the preview proxy (`PREVIEW_BASE_HOST`): every entry opens
  through the proxy, so it also works from a phone or tablet. A running
  service's port gets a preview of its own on first pick
  (`POST /api/projects/:id/browser-destinations/preview` with the entry's
  key; the server looks the port up again in its own discovery and never
  takes a port from the request), unless the dev server already names that
  port, which opens the project's own preview. Such a port preview is never
  a branch preview. It goes away with its service (#3467): a Dock-bound one
  when its session is no longer active, a Compose one once discovery no longer
  lists the port (skipped while **Docker Compose services** discovery is off).
  The sweep runs on the reconcile timer. Until it does, a Dock-bound slug whose
  session ended answers `503` rather than dialing the port; a Compose one keeps
  serving the port until the sweep. A pruned slug answers `404`, which the pane
  shows as unavailable. Picking the running service again mints it anew.
  Checkout and branch previews are not pruned. Without the proxy, a running service and the dev server
  open at their own address (direct embed), and named targets and branch
  previews, which need the proxy, are disabled with that reason.
- **Agent's browser** loads the entry's own address, which the server-side
  browser reaches from its own host. It never loads a proxy address (the
  preview token stays out of it, as for ⇄). A `localhost` entry on another
  host than the session's browser is disabled with that reason; where the
  session's browser runs comes from the server
  (`GET …/browser-destinations?sessionId=`), resolved as ⇄ resolves it (its
  browser binding first). Picking is an
  explicit open: it attaches, and so launches, the session's browser.

The list is `GET /api/projects/:id/browser-destinations`
(`src/services/browser-destinations.ts`); listing creates nothing.

There are two kinds of preview, in either mode:

- **Project preview** — one per project (opening it again reuses the same
  slug in proxy mode). Resolves to the project's configured dev-server
  URL/port.
- **External preview** — any URL you paste via "New preview tab" (the
  palette's "Open browser: blank preview"), validated
  against SSRF guards at creation time in proxy mode (see Security below);
  direct-embed mode has no server-side fetch, so there's nothing to
  validate — the guard simply doesn't apply.

Open a preview using **Preview ▾** in a project's Dock header (see [`dock.md`](dock.md)'s UI reference), the command palette
("Open browser: preview…" to choose a preview target for the project,
"Open browser: blank preview" for an empty pane with the address bar focused,
for typing an arbitrary URL directly, or "Open browser: `<label>`" for a saved
URL).

## The Browser view in the right sidebar (below 1100px)

Where the window is between 700 and 1099px wide (the rails layouts, among
them a foldable unfolded), the right rail has a **Browser** view. On a phone
the "⋯" sheet lists it with the rail's other views, and it opens full screen
for the current session's project. It is the Browser pane in the rail
(#3372): the same **Preview** / **Agent's browser** switch, always on its own
row above the address. From 1100px the view is not registered, and both
modes are the grid's Browser pane. The rail's Browser icon stays there (#3403),
in the same place with the same name, as a button rather than a toggle
(tooltip "Open browser"; disabled with no project in the rail): it focuses the
Browser pane if one is open in the workspace, else opens the followed
session's Agent's browser (the pane menu's "Open browser"), else the
project's preview as the palette's "Open browser: preview…" does.

Below 1100px every preview opens in this view, in Preview on its target,
never as a pane: the palette's preview entries (the target picker, the blank
preview, a saved URL), a project's Preview menu, Git branch rows, GitHub PR
rows and the Inbox's accepted dev server. A blank preview keeps whatever
project the rail follows; the others move the rail to their project. Preview
otherwise works on the rail's project: a project target opened for another
project gives way to the rail project's own preview when the rail moves.
The rail's Browser icon and the phone's "⋯" → Browser open the view in the
mode it was last in (Agent's browser the first time), and the palette's
"Open browser: agent's browser · <session>" opens it in Agent's browser.

The view keeps its mode and its preview address while it is closed, while
another view shows, and across the window crossing 1100px and back: widening
past 1100px still closes the view, and the next open below 1100px finds it as
it was. A Browser pane already in the grid stays a pane when the window
narrows. Neither is saved across a reload.

In Agent's browser the view shows the browser of the session the right
sidebar follows, the same CDP-streamed page as the grid pane, under the
pane's own address bar (back, forward, the address, reload). Unlike a grid
pane, which fixes its session at the switch, the view follows focus.

The session it shows is the one whose pane has focus, or the last one that
had focus while a pane that is not a session's (Settings, a Git panel) has
it. Only a session of the project the sidebar follows counts. With none,
Agent's browser says "No session in focus" (the switch gives the same reason
from Preview), and Preview still works.

Opening the agent browser launches it, so the view does not open one by
itself: it asks for the session's browser bindings first
(`GET /api/sessions/:id/browser`). A session with one shows its page; a
session without one shows "… has no browser yet." and an **Open browser**
button, which does what the pane menu's "Open browser" does.

The pane menu's "Open browser" (which adds the browser as a pane of
its own) is offered only from 1100px: below it, `rails-full` included, this
view is the agent browser (#3370).

On a touch screen a one-finger drag on the page scrolls it (in the view and
in the grid pane); a tap clicks.

### Typing on a touch screen

The page is a picture on a `<canvas>`, which never raises the on-screen
keyboard, so on a coarse pointer (`(pointer: coarse)`: a phone, tablet or
foldable) the browser's toolbar has a **keyboard** button, in the view and in
the grid pane (#3030). Tap the page's field first (the tap clicks it, as
always), then tap the button: it focuses a hidden text box, which raises the
keyboard, and what you type goes to the page. Tap the button again, or
anywhere outside the browser, to put the keyboard away. With the keyboard
open, tapping the page still clicks it but keeps the keyboard up, so you can
move from one field to the next. (That rests on cancelling the tap's
`mousedown`, which keeps focus on the hidden box in Chromium; it has not yet
been checked on a real phone, and iOS may not honour it. #3431 tracks the
device checks.)

A tap on the page does not raise the keyboard by itself. Whether the tap
landed on an editable field is only known to the remote page, after a round
trip to the server, and a phone raises its keyboard only for a focus made
inside the tap itself, so an explicit button is the one way that works.

What is typed reaches the page once, as follows:

- **Text** (letters, autocomplete and autocorrect picks, a paste from the
  keyboard) is sent as a `{type:"clipboard",text}` message, which the server
  types with Playwright's `insertText`. The page sees the text arrive in its
  field and its `input` event, not a keydown per letter.
- **IME and composed text** (Chinese, Japanese, and Android keyboards, which
  compose each word) is sent once, when the composition ends. On such a
  keyboard a word reaches the page when you commit it (a space, a suggestion,
  Enter), not letter by letter. A tap on the page or closing the keyboard in
  the middle of a word sends the word so far first, so it lands in the field
  it was typed for.
- **Enter, Backspace, Delete, Tab, Escape and the arrow keys** are sent as a
  `{type:"key",action:"press",key}` message, with any modifier held on a
  hardware keyboard (`Shift+Tab`). A soft keyboard's word and line deletes and
  its undo are sent as the matching key (`Control+Backspace`, ...).
- **A hardware keyboard's Ctrl/Cmd chords** go to the page as on the canvas:
  Ctrl/Cmd+C and +X copy or cut the page's selection, Ctrl/Cmd+V pastes the
  host clipboard, any other chord is pressed in the page.

The hidden text box is kept empty outside a composition, so the keyboard
never sees (and can never rewrite) text it has already sent. The cost is
context: an Android keyboard still suggests and autocorrects the word you are
composing, but a keyboard that does not compose (iOS, most hardware
keyboards) sees an empty box after every letter, so it offers next-word
predictions at most, not corrections. Capitalisation is off, since every
word would otherwise look like the start of a sentence.

## Why the proxy exists (and when you need it)

A plain iframe pointing at `http://localhost:5173` works fine as long as
Mullion's own dashboard is _also_ served over plain http — exactly the
local-dev case above. It stops working the moment Mullion is served over
**https**: browsers block a plain-http iframe inside an https page outright
as mixed content, and there's no CSP or app-level override for that (it's
enforced before the page's own headers are even considered). Most sites
also refuse to be framed cross-origin via their own `X-Frame-Options`/CSP,
regardless of scheme — direct embed can't do anything about that either.

The subdomain proxy solves both: Mullion fetches the target server-side
(server-to-server, so mixed content never applies) and re-serves it
same-origin at `preview-<slug>.<PREVIEW_BASE_HOST>` — a subdomain of the
dashboard's own origin, so the browser treats it as same-site and the
target's own framing headers never come into play. `src/plugins/security.ts`
adds `frame-src 'self' http(s)://*.<PREVIEW_BASE_HOST>` to CSP specifically
to allow this (and, in direct-embed mode, the broader `frame-src 'self' http:
https:` instead — see that file's own comments). Dev-server WebSocket
traffic (Vite/webpack-dev-server HMR, etc.) is proxied transparently through
the same subdomain in proxy mode, so hot reload keeps working inside the
panel.

**Bottom line:** if Mullion is only ever reached over plain http (a local
box, a LAN-only deployment), direct embed is all you need. If it's served
over https — the recommended production setup — previewing an `http://`
dev server (as opposed to an external `https://` site) requires the proxy;
see Setup below.

## How requests are rewritten (proxy mode)

In proxy mode Mullion forwards every request/response between the browser
and the dev server, rewriting a few things along the way so the dev server
sees (and produces) requests it actually understands:

- **`Host`** is rewritten to the dev server's own `host:port` — otherwise a
  dev server with a Host allowlist (e.g. Vite's `server.allowedHosts`) 403s
  every request, since the browser sent `preview-<slug>.<baseHost>`.
- **Forwarded-address headers** (`X-Forwarded-Host`/`-Proto`/`-Port`/`-For`,
  `Forwarded`, `X-Real-IP`) set by whatever reverse proxy sits in front of
  Mullion (Traefik, in the production deployment) are stripped before the
  onward hop, not passed through. A framework that prefers
  `X-Forwarded-Host` over `Host` when building an absolute URL or validating
  the request's own origin (Next.js/Auth.js's `trustHost`, several i18n
  middlewares) would otherwise see the _public_ preview hostname instead of
  its own, defeating the `Host` rewrite above.
- **A same-origin, absolute `Location`** in the dev server's own response
  (e.g. `http://127.0.0.1:5173/en`, the loopback address Mullion actually
  dialed) is rewritten to a relative one (`/en`) before it reaches the
  browser — an absolute loopback URL is both unreachable from inside an
  HTTPS iframe (mixed content) and points at the viewer's own machine, not
  the dev server. A `Location` pointing anywhere else (a genuinely external
  redirect) is left untouched.
- Every HTTP method is proxied, not just GET/HEAD — Server Actions, form
  posts, and API writes made by a previewed app reach the dev server the
  same way they would if it weren't previewed. Framing/length headers
  (`Content-Encoding`/`-Length`, `X-Frame-Options`, CSP) are stripped or
  recomputed per hop, since `fetch()` already decompressed the body and
  Fastify recomputes its own framing once the response is actually sent.

None of this applies to direct-embed mode, which has no server-side fetch at
all — the iframe points straight at the target URL.

## Setup

Leave `PREVIEW_BASE_HOST` unset for direct-embed mode — nothing else to do,
it just works (subject to the mixed-content/framing caveats above). The
steps below are only for turning on the subdomain proxy.

1. Set `PREVIEW_BASE_HOST` in `.env` (e.g. `preview.example.com`).
2. **Wildcard DNS**: `*.<PREVIEW_BASE_HOST>` must resolve to the same place
   as your main hostname. There's no DNS-free convention (no
   `nip.io`/`*.localhost` fallback) — proxy mode always needs real wildcard
   DNS pointed at `PREVIEW_BASE_HOST`. (Direct-embed mode, above, is the
   answer if you don't want to set this up.)
3. **Wildcard TLS**: a single-name cert doesn't cover
   `preview-<slug>.*`. See [`deploy/README.md`](../deploy/README.md) for
   the Traefik dynamic-config template — its preview router needs a
   wildcard `tls.domains` entry, which forces a **DNS-01** challenge
   (not HTTP-01), so your `certResolver` needs DNS-01 support.
4. `PREVIEW_BASE_HOST` in `.env` must exactly match
   `CHANGEME_PREVIEW_BASE_HOST` in `traefik-dynamic.yml` — same value,
   same case.
5. **Put the same forward-auth _provider/session scope_ on the preview
   router as the main app — not merely the same middleware name** — unless
   `PREVIEW_AUTH_REQUIRED=true` is set (issue #383 — see [`auth.md`](auth.md)).
   Gateway forwardAuth is still the default/only option when that flag is
   off: without either one, every preview subdomain is an open,
   unauthenticated proxy into whatever it's pointed at. With
   `PREVIEW_AUTH_REQUIRED=true` and no gateway in front, a bookmarked/direct
   navigation straight to a preview URL 401s with no bootstrap token to
   redeem — set `PREVIEW_AUTH_DASHBOARD_URL` (issue #1310, see
   [`configuration.md`](configuration.md)) so that 401 page can at least
   link back to the dashboard instead of being a dead end. If the visitor
   already has an authenticated dashboard session, clicking that link
   completes the token exchange automatically and lands them straight back
   on the preview (issue #1316, see [`auth.md`](auth.md)'s Preview-host auth
   token section) — with no dashboard session, that same click is now a
   normal top-level navigation to `PREVIEW_AUTH_DASHBOARD_URL` (a redirect,
   not the raw-JSON 401 an unauthenticated `fetch()` to a protected `/api/*`
   route gets), landing the visitor on the dashboard to sign in.

   **"Same middleware" is not the same thing as "same session," and this has
   bitten a real deployment.** Referencing the identical Traefik middleware
   name on both routers is necessary but not sufficient if the IdP behind it
   treats the dashboard and the preview wildcard as two separate
   applications/providers — which is the natural way to set this up, since
   the preview host is a wildcard and typically needs its own provider mode
   (Authentik's `forward_domain`, as opposed to the dashboard's
   `forward_single`). Two separate providers means two separate sessions:
   logging into the dashboard does not authorize the preview host, and every
   preview then starts its own OAuth round trip through the IdP — one more
   place for that round trip to break than the dashboard has.

   In particular, if you're running a **standalone (non-embedded) Authentik
   outpost** serving more than one Provider (which a homelab-style
   `dev-01`-class deployment typically does — one outpost fronting several
   apps), there's a known upstream bug where the outpost silently drops a
   `forward_domain` Provider's `cookie_domain` whenever it shares the outpost
   process with any other Provider — see
   [goauthentik/authentik#26228](https://github.com/goauthentik/authentik/issues/26228)
   for the root cause (a process-wide session-store singleton, not a
   configuration mistake) and the "Verifying the preview router" subsection
   below for how to recognize it. **`PREVIEW_AUTH_REQUIRED=true` is the
   supported way to gate previews behind a self-hosted Authentik outpost** —
   it removes Authentik from the preview path entirely, so this bug (and the
   whole class of "two providers, two sessions" issue above) can't affect
   previews at all.

### Verifying the preview router

However this is set up, confirm it actually works rather than assuming
"same middleware referenced → same result":

```bash
curl -sS -I https://preview-<any-real-slug>.<PREVIEW_BASE_HOST>/
```

- **A `302` to your IdP** on a request that should already be authenticated
  (e.g. from a browser with an active dashboard session) means forwardAuth
  on the preview router isn't sharing a session with the dashboard — the
  "two providers, two sessions" problem above.
- **An empty-bodied `400` on the IdP's own callback host** (not the preview
  slug host) after that redirect means the session cookie set during the
  redirect never reached the callback — check the IdP's own logs for
  something like `"invalid state"` or `"mismatched session ID … should:''"`;
  the empty `should` value means the IdP found no session at all at the
  callback, not merely the wrong one. This is the signature of the Authentik
  singleton bug linked above.
- **A `401` with an HTML body** (no redirect at all) is
  `PREVIEW_AUTH_REQUIRED=true` working as designed — no bootstrap token was
  present on this direct request, which is expected for a `curl` probe (see
  "Preview-host auth token" in [`auth.md`](auth.md)).

**Recognizing the Authentik outpost singleton-store bug specifically.** If a
preview behind a gateway-forwardAuth Authentik outpost fails to load — Chrome
reporting "This content is blocked", or a redirect loop back to Authentik's
login screen — check the outpost's own logs before assuming a Mullion bug.
The confirmed signature is an `invalid state` error alongside a session-ID
mismatch line reading `mismatched session ID … should:""`; the empty
`should:` value is diagnostic — it means the OAuth `state` cookie Authentik
set never reached the callback host at all, not that Mullion sent the wrong
one.

Root cause, confirmed upstream and **not** fixable from this repo: on an
outpost that fronts more than one Provider, `goauthentik/authentik`'s
`filesystemstore.GetPersistentStore` returns a single process-wide store, and
each Provider's own `getStore` call overwrites `globalStore.Options.Domain`
on it — so only the last Provider loaded gets its `cookie_domain` applied,
and every other Provider's login flow sets a state cookie scoped to the
wrong domain. Filed upstream as
[goauthentik/authentik#26228](https://github.com/goauthentik/authentik/issues/26228),
with repro steps and source citations (`session.go:53-72`,
`filesystemstore.go:167-195`).

There is no workaround on Mullion's side — the bug lives in the outpost's
shared session store, before any request reaches Mullion. If you hit this
signature on a deployment that still routes preview auth through an
Authentik outpost fronting multiple Providers, the fix is to stop depending
on gateway forwardAuth for previews and set `PREVIEW_AUTH_REQUIRED=true`
instead (Setup step 5 above), so Mullion's own bootstrap-token flow handles
preview auth in-process and bypasses the outpost's singleton store entirely.

### Worked example: `mullion.s3ntin3l8.de`

A concrete instance of the steps above, for the production deployment
behind `https://mullion.s3ntin3l8.de` — filled in, not placeholders:

- **Preview base host**: `preview.s3ntin3l8.de` (a sibling label, not a
  subdomain of `mullion.s3ntin3l8.de` itself — keeps the main dashboard's
  cert a single name; reusing `mullion.s3ntin3l8.de` as the base also works,
  but then that cert must SAN both the apex and `*`).
- **`.env`**: `PREVIEW_BASE_HOST=preview.s3ntin3l8.de` — must match Traefik's
  value byte-for-byte (`src/services/preview-host.ts` compares the `Host`
  header verbatim).
- **DNS**: one wildcard record, `*.preview.s3ntin3l8.de` → the same target
  `mullion.s3ntin3l8.de` already points at.
- **TLS**: a wildcard cert for `*.preview.s3ntin3l8.de`, issued via DNS-01
  (the `certResolver` needs DNS-provider credentials — HTTP-01 can't prove a
  wildcard).
- **Traefik**: fill in `deploy/traefik-dynamic.yml`'s already-templated
  `claude-remote-session-preview` router —
  `CHANGEME_PREVIEW_BASE_HOST` → `preview.s3ntin3l8.de`,
  `CHANGEME_CERTRESOLVER` → the DNS-01 resolver. Its `service:` already
  points at the Mullion app itself (`http://127.0.0.1:3450`) — **no
  per-dev-app Traefik config, ever**; Mullion resolves each preview slug and
  proxies it internally, so adding a new preview is just opening a project
  in Mullion.
- **`CHANGEME_MIDDLEWARE`**: with a self-hosted Authentik fronting the main
  app, set `PREVIEW_AUTH_REQUIRED=true` (issue #383) and **drop the
  forwardAuth middleware from this router entirely** — see the Setup step 5
  callout above for why reusing "the same middleware reference as the main
  router" is the trap here, not the fix. If your gateway/IdP is something
  other than a standalone Authentik outpost (a managed IdP, or Authentik run
  embedded rather than as a standalone outpost) and you've confirmed via the
  "Verifying the preview router" check above that a shared session actually
  works, referencing the same forwardAuth middleware as the main router
  remains a valid choice.
- **Reachability**: the **Mullion host itself** (or its registered agent —
  see [`multi-host.md`](multi-host.md)) needs to reach the dev server's
  `ip:port`, not the browser — so a LAN or Tailscale address works as long
  as Mullion can dial it. Project previews (`kind: "project"`) use the
  project's configured `devServerUrl` directly and are **not** subject to
  the external-preview SSRF guard (see Security below), so a private
  `ip:port` there is expected and allowed.

## Dev-server port auto-discovery

For local (non-remote-host) projects, Mullion scans that project's dock
session's terminal scrollback for a dev server's own "Local:
http://localhost:`<port>`" startup banner (Vite/Next/CRA/Astro-style) and
offers it as a one-click suggestion — "Detected dev server on port N — use
it?" — when creating/editing a project. It's never applied automatically;
you still confirm it, and it only ever informs the `devServerUrl` field you
could also type in by hand.

`devServerUrl` can also get populated a third way (issue #404): if a dev
server is started by hand in an ordinary "+ Session" terminal — not a dock
control — Mullion separately notices the same startup banner there and
offers a "Dev server detected" notification; accepting it patches
`devServerUrl` to that port (and creates/reuses the project's preview) the
same way the manual PATCH path does, without spawning a second session. See
`docs/dock.md`'s "Dev server auto-detect in plain sessions" section for the
full behavior and the `dock.autoDetectDevServer` setting that gates it.

## Branch previews (issues #2016, #2018)

A project's own preview serves its checkout — whatever branch the project
directory has checked out, through `devServerUrl`. A **branch preview**
serves any other branch: Source Control's **Preview this branch** (every
local branch row and branch detail) and the GitHub view's **Preview this
PR** (PR row and the PR detail's Mullion card) start one. The first click
starts it; afterwards the action reads **Open preview** and reuses it. Both
land in the dock's browser pane, one pane per preview.

Starting one:

1. Picks the project's **preview control**: the dock control with
   `"preview": true` (Dock config → "Serves branch previews"), or the
   project's only control. With several controls and none flagged, the
   request is refused (`409 no_preview_control`). Discovered Docker Compose
   services never count — they don't follow `PORT`.
2. Makes sure the branch exists locally, fetching `refs/heads/<branch>`
   from `origin` when it doesn't (a PR's head branch you never checked out).
3. Allocates a free loopback port and starts the control as a dock session
   in a `.mullion-worktrees/dock-preview-*` worktree of the branch, with
   `PORT=<port>` in its environment. **The control's command must listen on
   `$PORT`** (e.g. `vite --host 127.0.0.1 --port $PORT --strictPort`); see
   [`dock.md`](dock.md)'s `PORT` convention.
4. Binds the `(project, branch)` preview row to that session and port. The
   proxy forwards that preview's slug to the port, not to `devServerUrl`.

`POST /api/previews {kind: "project", projectId, branch}` is the API;
`POST /api/projects/:id/github/prs/:number/preview` resolves a PR's head
branch first. Both are idempotent per (project, branch): reuse is decided
from the database row and the bound session's live state, so it survives a
Mullion restart. A dead session is restarted under the same slug; a
`dock-preview-*` worktree it left behind is recut from the branch's tip, and
one that a different live session is still running in is refused
(`409 worktree_busy`). The first open usually lands before the dev server
has bound its port — the pane says so; reload in a moment.

To stop a branch preview, stop its dock session (from the Dock). Deleting
the preview row alone (`DELETE /api/previews/:slug`) leaves that dev server
running, and the next start then refuses with `409 worktree_busy` until it
is stopped.

### On a remote host (#3428)

**A branch preview runs on the project's own host.** That host's checkout is
where the branch is fetched and the `dock-preview-*` worktree is cut, so the
port is picked and the dev server started there too; the dock session is
_targeted_ at the project's host (`target: {hostId}`), never placed elsewhere
by the placement policy, and is refused (`502 start_failed`) when that host
can't take it. The steps above run unchanged; for a project on an agent host,
the ones that touch its checkout or its ports go to the agent:

| Step                                     | Agent route                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| Read the preview control (`dock.json`)   | `GET /internal/dock`                                                        |
| Make the branch exist (and fast-forward) | `POST /internal/git-ensure-branch {cwd, branch, fastForward}` (mutating)    |
| Clear a dead preview's worktree          | `POST /internal/worktree-clear-stale {cwd, path}` (mutating)                |
| Pick a free loopback port                | `POST /internal/preview-port {taken}` (read-only: probes, reserves nothing) |

What only the primary knows stays on the primary: whether a live session
still runs in the worktree (checked before the agent is asked to clear it),
and the ports already bound to branch previews on that host plus the
in-flight reservations, which it sends as `taken`. The agent re-runs the
worktree path guard on its own resolved checkout — `path` must name a
`dock-preview-*` directory directly under `cwd`'s `.mullion-worktrees`, else
`400` — so a forged path can't reach a task worktree or anything outside it.
Every path also goes through the agent's `PROJECTS_ROOTS` containment.

A host that can't be asked is refused with its own code instead of reading as
"no such branch": `503 host_unavailable` (unreachable, busy, or the connection
dropped mid-request — the next start re-checks), and `409 host_unsupported`
for an agent build without these routes, whose message says to update that
host. The proxy then reaches the bound port through the session's host, as
described under "Multi-host previews" below.

Not yet supported, refused with a code the UI explains:

- A **fork's** pull request (`409 fork_unsupported`) — its head branch isn't
  on `origin` ([#2058](https://github.com/s3ntin3l8/mullion-session-manager/issues/2058)).

## Multi-host previews

If a project's session runs on a remote **agent** host (see
[`multi-host.md`](multi-host.md)) rather than the primary, previewing it is
a two-hop proxy: the primary forwards the request to that agent's internal
API, and the **agent** then connects to its own `127.0.0.1:<port>` — never
to an arbitrary host or port. The remote host portion of the project's
`devServerUrl` is intentionally discarded for this hop, so even a leaked
`MULLION_AGENT_TOKEN` or a compromised primary can only reach ports on that
agent's own loopback, never pivot into its LAN.

### Which host a preview targets

A preview resolves its target from the **session it is bound to**, through the
shared execution-context resolver, not from the project's configured host:

- A preview **bound to a session** (a checkout preview whose dev server a
  session announced, or a branch preview's dock session) is served from that
  session's host. "localhost" in the project's `devServerUrl` means the
  _owning_ host's loopback, never the primary's or the project's.
- A bound session that can't be resolved — its host is unreachable or
  unregistered, the project has no checkout there, or (for a branch preview)
  the session is gone — makes the preview answer `503`. It never falls back to
  the project's host.
- A preview **with no session** is project-default: explicitly scoped to the
  project's own host and `devServerUrl`.
- An open preview keeps its original target. The checkout preview is one row
  per project; a later dev-server accept from a session on a _different_ host
  does not repoint it while the original session is still active. Once that
  session ends, the next accept rebinds it.
- `GET`/`PUT /api/projects/:id/dock/config` take an optional `?sessionId=` to
  read or write the dock config in that session's host and checkout; without
  it they act on the project's own checkout.
- The dock-session port-in-use check (`409 port_in_use`) probes only the host
  the session will run on, and only counts holders on that host.

Branch-preview ports are tracked per host (`listUpstreamPorts(app, hostId)`
and the in-flight reservations), so the same port on two hosts is not a
conflict; the port itself is picked on the project's host (the agent's
`/internal/preview-port` for a remote one, see "On a remote host" above). This
is only the ports Mullion itself handed to branch previews; a full
cross-session port inventory per worktree remains separate work
([#2070](https://github.com/s3ntin3l8/mullion-session-manager/issues/2070)).

## Security

- External preview URLs are validated with the same SSRF-guard classifier
  used elsewhere in Mullion (`src/services/url-guard.ts`), but with a
  stricter policy than host registration: loopback and RFC1918/IPv6-ULA
  private ranges are blocked outright here (unlike remote-host
  registration, where loopback/private ranges are legitimate), along with
  link-local, RFC 6598 shared-NAT space, and IPv4-mapped/IPv4-compatible
  IPv6 forms that could otherwise smuggle a blocked address past an
  IPv4-only check. Redirects are followed manually (`redirect: "manual"`)
  and re-checked rather than trusted.
- That creation-time check is IP-literal only, so it is no longer the only
  one: the proxy re-applies the same strict policy on every request and pins
  the connection to a validated resolved address (`pinned-connect.ts`, issue
  #250). A hostname that resolves safely when the preview is created and is
  rebound to a private address afterward is caught at connect time, on both
  the HTTP and the WebSocket hop — the WS hop especially, since `redirect:
"manual"` isn't available on a WebSocket upgrade and it previously had no
  guard at all. Because the row is re-validated on every request rather than
  trusted from when it was written, an `external` preview whose stored URL
  points somewhere the policy forbids is refused even if it reached the
  database some other way.
- A project's own dev server is a different trust level and keeps the
  permissive policy — an admin-configured dev server on loopback or a private
  LAN is the normal case, and blocking it would break the feature. Only
  user-typed `external` URLs get the strict one. Beyond that, treat "who can
  create a preview" as a trusted-user action for the same reason multi-host
  registration is.
- `GET /api/server-info` exposes `previewsEnabled`/`previewBaseHost` so the
  frontend can gate the preview UI on it; there's nothing sensitive in that
  response.
- A preview host is exempt from the app-wide `RATE_LIMIT_MAX` limiter
  (`src/plugins/security.ts`) but has its own dedicated per-IP ceiling
  instead — `PREVIEW_RATE_LIMIT_MAX` (default `2000`/min, see
  [`configuration.md`](configuration.md)) — sized for a single page load's
  dozens of subresource requests rather than API traffic. It's an
  every-HTTP-method proxy, and Mullion's own in-process auth
  (`MULLION_AUTH_TOKEN`/OIDC, see [`auth.md`](auth.md)) cannot cover it at
  all by default — a session cookie can't reach a cross-subdomain iframe,
  and a bare `<iframe>` can't attach a Bearer header either. This is not new
  to this proxy consuming every method rather than just GET/HEAD; it just
  means the surface it was always true for now includes writes too.
  **Whatever forwardAuth middleware protects the main app must also protect
  the preview router** (Setup step 5, above), unless the opt-in
  `PREVIEW_AUTH_REQUIRED` flag (issue #383, see [`auth.md`](auth.md)) is set
  — that flag closes this gap in-process, at the cost of a preview cookie
  whose revocation lag is bounded but not instant (~24h for an idle
  preview — see finding AS12 in that doc's Current limitations) and a
  plain-http + cross-registrable-domain constraint. With the flag off
  (the default), gateway forwardAuth remains the only thing standing between
  an open preview subdomain and the dev server behind it.

## Current limitations

- Direct-embed mode can't show an `http://` dev server once Mullion itself
  is served over https (browser mixed-content block, not overridable), and
  can't frame sites that refuse embedding via their own
  `X-Frame-Options`/`frame-ancestors` (e.g. Google, GitHub) regardless of
  scheme. Both require the subdomain proxy — see "Why the proxy exists"
  above.
- WebSocket upgrades proxied through an Authentik forwardAuth deployment
  are not yet verified end-to-end in production for previews specifically
  (same open question as `/ws/terminal` — see `deploy/README.md`).
- Port auto-discovery only works for projects running on the primary
  itself; it has no visibility into a remote agent's terminal scrollback.
- `BrowserPanel.tsx`'s pre-mount probe (issue #1318) can tell a proxy error
  apart from a real load, but not which proxy error it was — 404 (unknown
  slug), 401 (`PREVIEW_AUTH_REQUIRED`), and 429 (rate-limited) all surface as
  the same generic "not reachable through the proxy" message, since the
  frontend only ever gets a bare status code, by design
  (`src/plugins/preview-proxy.ts`'s own early-return responses stay
  detail-free even to the dashboard's own origin — see that file's
  Access-Control-Allow-Origin comment). The 502/503 (dev server down) case is
  the one exception: it's covered instead by the same-origin
  `devServerOnline` poll, which pre-empts the generic message with a
  dedicated "Dev server not reachable. It may have crashed or stopped — check
  the session, then retry." before the iframe even has a chance to report a
  generic error, for a project preview reached through the proxy.
  The same "not reachable" state is deliberately _not_ shown for
  a saved URL or the no-proxy direct-embed fallback (`previewsEnabled`
  false): those already surface a connection failure via the iframe's own
  browser-native error page plus the toolbar's online/offline dot.

## Named project targets

Use **Project → Dock → Previews** to configure the existing Dev server and additional named destinations such as Docker web or API docs. The Dev server field has moved out of Edit project. Preview configuration is stored in Mullion's database; changing an address does not edit `.crs/dock.json` or restart monitors.

Destinations accept a port, `IP:port`, `hostname:port`, or a full HTTP(S) URL with a path/query. Shorthand uses HTTP. Each additional target chooses **Project host** (the default) or **Main Mullion server** as the connection origin; localhost refers to that machine. The Dock's **Preview ▾** menu shows names and destinations, **New preview tab**, and **Manage previews…**. The palette's **Browser** row (a default row) offers the same choices, and opens the active session's agent browser instead when a session pane is active.

Named targets require `PREVIEW_BASE_HOST`. Each has its own stable pane and preview slug. Reopening or reloading uses its saved destination; removing a target removes its registered preview. Targets are explicit destinations, independent of Docker discovery, monitor lifecycle, bookmarks, and branch/PR previews.

Named targets on remote hosts use a separate authenticated configured-target transport which permits explicit loopback/private HTTP(S) destinations, with DNS pinning and credentials stripped before the onward hop. This expands the capability of the trusted primary for these configured requests; the legacy remote dev-server transport remains loopback-only. Upgrade the owning host if it does not yet support named targets. An unavailable host never causes a fallback to a different connection origin.

## Browser panes follow the session's execution target

The Browser pane and the agent's `use_browser` automation open the session's own execution target (host and checkout), the same one its preview and git routes use, not the project's. A pane stays on the target it was opened on when the session focus changes. All targets on a machine share one Chromium process, each in its own isolated browser context, keyed by project, checkout and preview endpoint, so two previews of one checkout never share cookies or storage (the endpoint is the slug of the preview bound to the session, decided once when the session first binds a browser and stored with its browser binding so ending the session closes that context; a session with no preview keeps the legacy endpoint). A local session's endpoint is fixed in one place, a compare-and-set on its binding row, so the panel and `use_browser` can never key a session differently even when a dev server is accepted between their first requests.

**Cookie files (#2701).** The project's default checkout (its default host and project directory) keeps the cookie file its browser had before targets existed, `project-<id>.json`, for _every_ session in it, whatever preview slug that session has. The only time a default-checkout endpoint gets a hashed file (`project-<id>-<digest>.json`) is when a second, different endpoint of the same checkout is open at the same moment, the user's explicit choice of a second context; the claim on the legacy file is held in memory by the running context (decided in one synchronous step, so concurrent first opens cannot both take it) and released when that context closes. Any other checkout (a worktree) always has a hashed file. Deleting a project closes its browsers and removes its cookie file, any obsolete `project-<id>.owner` claim file left by the earlier release, and every per-target file and downloads directory; merging a duplicate project into its survivor does the same for the duplicate (#2725). Both clean the primary's own storage only: an agent host keeps the files its own browsers wrote for the project, because no operation carries a project-level forget to an agent (a worktree's files are removed when the worktree is, by the shared removal helper).

**Mixed versions.** Against an agent that does not advertise `browser-endpoints` the legacy endpoint is used on every path. A close is always sent under the endpoint the context was opened with (the pending-close record stores it), so a capability downgrade after an endpoint bind still closes the endpoint-keyed context; while the host does not advertise the operation the legacy key is closed as well, unless another session is bound to it. A remote session gets its endpoint from the preview it serves, sent to the agent with the first browser request. A remote session keeps its browser target across an agent restart (the agent persists it under `SESSIONS_DIR`). Imported project cookie profiles are applied to every target of the project. See [Browser automation → Execution targets](browser-automation.md#execution-targets).

A pane's binding is re-validated when it is used: if its checkout was deleted or its host removed, the pane shows the reason with **Re-bind** (unbind, then attach to the session's current host and checkout) and **Unbind** actions. Both call `DELETE /api/sessions/:id/browser`; `mullion browser unbind` does the same from a terminal, and `mullion browser …` / `use_browser` print the reason (with the same way out) when they hit it. The refusal carries `code: "binding_unavailable"`.

Attaching is leak-free by construction: the attach window always ends, a binding that cannot be recorded (for example the session row was deleted while the browser launched) closes the context if nothing else uses it and reports an error to the pane, and a remote agent that never opens its WebSocket is given up on after 15 seconds. A remote automation call records its binding only after the agent took it.

Removing a worktree (task approval, claim rollback and the claim-time orphan clear, abandoning a task, promote and create rollback, the session reconciler and the auto-rebase stale-worktree clear, dock and branch preview session end, the reclaim, boot-orphan and developer-worktree sweeps, the Source Control remove route, project setup) goes through one set of helpers in `src/services/checkout-removal.ts` (`removeCheckoutIfClean`, `removeCheckoutForced`, `removeListedCheckout`, `pruneCheckouts`, `clearOrphanedCheckout`, `clearStalePreviewCheckout`). Each closes that checkout's browsers and deletes their stored cookies and downloads (the project default's file is kept). `npm run check:checkout-removal` (part of `make lint`) fails and names the file when anything else in `src/` calls a low-level remove (`removeWorktree*`, `removeListedWorktree`, `pruneWorktrees`, `clearOrphanedTaskWorktree`, `clearStalePreviewWorktree`, `git worktree remove`); add a file to its allowlist only for an implementation of those operations. Storage is found even for contexts that already stopped: each time an endpoint context opens, its endpoint is appended to a per-checkout `project-<id>-<digest>.endpoints` index in the browser data dir (on the machine that runs the browser), and forgetting the checkout deletes the storage file and downloads directory of every indexed endpoint, every running one and the default-endpoint target, then the index. Contexts opened before the index existed are not listed, so their files stay until the data dir is cleaned. A close that a remote host could not take is queued and retried on a timer that runs on the primary whether or not its own browser is enabled; a new close request for a target whose record already gave up re-arms it, and queued closes for a host that was removed from the registry are dropped. A browser that could not be closed after a day is shown as leaked in Settings → Hosts. Details: [Browser automation → Execution targets](browser-automation.md#execution-targets).
