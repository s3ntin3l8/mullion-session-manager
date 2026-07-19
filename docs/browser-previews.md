# Browser previews

Tessera can show a project's dev server — or any external URL — in a
dockview panel alongside your terminals. It has two distinct modes,
switched automatically by whether `PREVIEW_BASE_HOST` is set — there's no
separate flag:

- **`PREVIEW_BASE_HOST` unset (default): direct embed.** The panel's iframe
  points straight at the target URL — no proxy, no extra infra. This is
  what you get out of the box, including during local development where
  Tessera itself is served over plain http.
- **`PREVIEW_BASE_HOST` set: subdomain proxy.** Tessera fetches the target
  itself and re-serves it same-origin. Needed once Tessera's own dashboard
  is served over https (see "Why the proxy exists" below) and buys framing
  sites that refuse direct embedding.

There are two kinds of preview, in either mode:

- **Project preview** — one per project (opening it again reuses the same
  slug in proxy mode). Resolves to the project's configured dev-server
  URL/port.
- **External preview** — any URL you paste via "Open URL" or "New browser
  tab", validated against SSRF guards at creation time in proxy mode (see
  Security below); direct-embed mode has no server-side fetch, so there's
  nothing to validate — the guard simply doesn't apply.

Open a preview from a project's Dock row ("Open browser preview"), the
command palette ("Preview: `<project>`"), "Open URL…", or "New browser
tab" (an empty pane with the address bar focused, for typing a URL
directly) for an arbitrary site.

## Why the proxy exists (and when you need it)

A plain iframe pointing at `http://localhost:5173` works fine as long as
Tessera's own dashboard is _also_ served over plain http — exactly the
local-dev case above. It stops working the moment Tessera is served over
**https**: browsers block a plain-http iframe inside an https page outright
as mixed content, and there's no CSP or app-level override for that (it's
enforced before the page's own headers are even considered). Most sites
also refuse to be framed cross-origin via their own `X-Frame-Options`/CSP,
regardless of scheme — direct embed can't do anything about that either.

The subdomain proxy solves both: Tessera fetches the target server-side
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

**Bottom line:** if Tessera is only ever reached over plain http (a local
box, a LAN-only deployment), direct embed is all you need. If it's served
over https — the recommended production setup — previewing an `http://`
dev server (as opposed to an external `https://` site) requires the proxy;
see Setup below.

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
5. **Put the same forwardAuth middleware on the preview router as the main
   app.** This is not optional: without it, every preview subdomain is an
   open, unauthenticated proxy into whatever it's pointed at.

### Worked example: `tessera.s3ntin3l8.de`

A concrete instance of the steps above, for the production deployment
behind `https://tessera.s3ntin3l8.de` — filled in, not placeholders:

- **Preview base host**: `preview.s3ntin3l8.de` (a sibling label, not a
  subdomain of `tessera.s3ntin3l8.de` itself — keeps the main dashboard's
  cert a single name; reusing `tessera.s3ntin3l8.de` as the base also works,
  but then that cert must SAN both the apex and `*`).
- **`.env`**: `PREVIEW_BASE_HOST=preview.s3ntin3l8.de` — must match Traefik's
  value byte-for-byte (`src/services/preview-host.ts` compares the `Host`
  header verbatim).
- **DNS**: one wildcard record, `*.preview.s3ntin3l8.de` → the same target
  `tessera.s3ntin3l8.de` already points at.
- **TLS**: a wildcard cert for `*.preview.s3ntin3l8.de`, issued via DNS-01
  (the `certResolver` needs DNS-provider credentials — HTTP-01 can't prove a
  wildcard).
- **Traefik**: fill in `deploy/traefik-dynamic.yml`'s already-templated
  `claude-remote-session-preview` router —
  `CHANGEME_PREVIEW_BASE_HOST` → `preview.s3ntin3l8.de`,
  `CHANGEME_MIDDLEWARE` → the same Authentik forwardAuth reference as the
  main router, `CHANGEME_CERTRESOLVER` → the DNS-01 resolver. Its `service:`
  already points at the Tessera app itself
  (`http://127.0.0.1:3450`) — **no per-dev-app Traefik config, ever**;
  Tessera resolves each preview slug and proxies it internally, so adding a
  new preview is just opening a project in Tessera.
- **Reachability**: the **Tessera host itself** (or its registered agent —
  see [`multi-host.md`](multi-host.md)) needs to reach the dev server's
  `ip:port`, not the browser — so a LAN or Tailscale address works as long
  as Tessera can dial it. Project previews (`kind: "project"`) use the
  project's configured `devServerUrl` directly and are **not** subject to
  the external-preview SSRF guard (see Security below), so a private
  `ip:port` there is expected and allowed.

## Dev-server port auto-discovery

For local (non-remote-host) projects, Tessera scans that project's dock
session's terminal scrollback for a dev server's own "Local:
http://localhost:`<port>`" startup banner (Vite/Next/CRA/Astro-style) and
offers it as a one-click suggestion — "Detected dev server on port N — use
it?" — when creating/editing a project. It's never applied automatically;
you still confirm it, and it only ever informs the `devServerUrl` field you
could also type in by hand.

## Multi-host previews

If a project's session runs on a remote **agent** host (see
[`multi-host.md`](multi-host.md)) rather than the primary, previewing it is
a two-hop proxy: the primary forwards the request to that agent's internal
API, and the **agent** then connects to its own `127.0.0.1:<port>` — never
to an arbitrary host or port. The remote host portion of the project's
`devServerUrl` is intentionally discarded for this hop, so even a leaked
`TESSERA_AGENT_TOKEN` or a compromised primary can only reach ports on that
agent's own loopback, never pivot into its LAN.

## Security

- External preview URLs are validated with the same SSRF-guard classifier
  used elsewhere in Tessera (`src/services/url-guard.ts`), but with a
  stricter policy than host registration: loopback and RFC1918/IPv6-ULA
  private ranges are blocked outright here (unlike remote-host
  registration, where loopback/private ranges are legitimate), along with
  link-local, RFC 6598 shared-NAT space, and IPv4-mapped/IPv4-compatible
  IPv6 forms that could otherwise smuggle a blocked address past an
  IPv4-only check. Redirects are followed manually (`redirect: "manual"`)
  and re-checked rather than trusted.
- As with remote-host registration, this is IP-literal validation at
  creation time, not DNS-rebinding protection — a hostname that resolves
  safely when the preview is created and gets rebound to a private address
  afterward isn't caught. Treat "who can create a preview" as a trusted-user
  action for the same reason multi-host registration is.
- `GET /api/server-info` exposes `previewsEnabled`/`previewBaseHost` so the
  frontend can gate the preview UI on it; there's nothing sensitive in that
  response.

## Current limitations

- No DNS-rebinding protection (see Security above) — proxy mode only; direct
  embed has no server-side fetch, so it isn't SSRF-relevant at all.
- Direct-embed mode can't show an `http://` dev server once Tessera itself
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
