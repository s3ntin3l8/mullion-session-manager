# GitHub integration

Mullion can connect to GitHub to surface repo status — open issues/PRs and
CI/Actions workflow status — for any project whose git `origin` points at
github.com. This is one credential per install (Settings → Integrations),
not per-project or per-user: everyone using the dashboard shares the same
connected GitHub identity.

## What you get once connected

- A **Dock widget row** for any project with a github.com `origin` remote,
  showing `owner/repo`, open issue count, open PR count, and a CI status dot
  (success / failure / in progress).
- A **GitHub panel** (open it from the Dock row, or the command palette's
  Integrations section) listing open PRs and issues with links, plus the
  latest run status per Actions workflow.

Owner/repo is derived by parsing the project's own `.git/config` — no
`git remote` shell-out. Non-github.com remotes (GitHub Enterprise, GitLab,
Bitbucket) and projects with no `origin` at all are silently treated the
same as "no repo detected": no widget, no error.

## Connecting

Settings → Integrations → GitHub offers two independent ways to connect:

### Personal access token (always available, zero setup)

Create a **fine-grained PAT** with read access to **Contents, Issues, and
Pull requests**, paste it into Settings → Integrations, and click Connect.
The token is validated against GitHub's `/user` endpoint before being
stored, so a malformed or already-revoked token is rejected immediately
rather than failing mysteriously later.

For webhook support the PAT also needs permission to manage repository
webhooks — "Administration: Read and write" for a fine-grained PAT, or
`admin:repo_hook` scope for a classic PAT. Without it the webhook toggle
in Settings turns on but registration fails silently per repo (see
Troubleshooting below).

This is the tighter-scoped option — if you only care about issue/PR counts
and don't need Actions workflow status, a PAT without `Actions: read` still
works, it just leaves the CI dot empty rather than erroring.

#### Task Master (additional scope)

The base scope above is **read-only** and is all the Dock widget/GitHub
panel ever need. [Task Master](tasks.md) is different: claiming a task,
syncing its state back to the issue, and promoting an approved task to a
PR are all GitHub **writes**. If you plan to turn on Task Master — whether
via `MULLION_TASK_MASTER_ENABLED` or Settings → Task Master's "Enable Task
Master" toggle — re-provision the fine-grained PAT with **write** access
to:

- **Issues** — labels (`mullion-claimed`/`mullion-reviewing`/`mullion-done`),
  comments, assigning the task to the connected identity, closing the
  issue on promotion.
- **Pull requests** — opening the promotion PR.
- **Contents** — pushing the task's branch.

A PAT provisioned only per the read-only scope above will connect and work
fine for the Dock widget/GitHub panel, but **403s on the very first Task
Master write** (claiming a task, most commonly). That write is
fire-and-forget with respect to the local row (the task's own status is
never blocked by a GitHub failure), but the failure itself is not silent:
every write failure — including that first claim — is logged server-side
**and** recorded on the task's `githubSyncError` field, rendered directly
in the task detail drawer regardless of the task's status (see
[`tasks.md`](tasks.md#github-sync)). If claiming a task never actually
labels/comments on its GitHub issue, the task itself will say why. If
you're setting this up ahead of time, save yourself that round trip and
provision write access up front.

### Device flow ("Connect with GitHub" button, opt-in)

This requires one-time setup by whoever operates the Mullion instance:

1. Register a **GitHub OAuth App** at
   [github.com/settings/developers](https://github.com/settings/developers)
   and enable **Device Flow** for it. (This is a classic OAuth App, not a
   GitHub App.)
2. Set `GITHUB_OAUTH_CLIENT_ID` to that app's client id in the **primary's**
   environment and restart. This is a public identifier, not a secret —
   safe to bake into the built frontend bundle or a log line, unlike
   `DB_ENCRYPTION_KEY`/`MULLION_AGENT_TOKEN`. (Agent hosts never need this —
   GitHub integration is primary-only, same as the rest of the DB.)
3. Settings → Integrations now shows a "Connect with GitHub" button. Click
   it, and follow the device code / `github.com/login/device` flow shown in
   the modal.

Device-flow tokens use OAuth scope `repo` — broader than the fine-grained
PAT path above — because GitHub OAuth Apps don't offer a finer-grained
classic scope for read-only repo access, and (unlike a GitHub App's
user-to-server token) they don't expire, so there's no refresh handling to
build. If scope minimization matters more to you than one-click connect,
use the PAT path instead.

`repo` already includes read+write on issues, pull requests, and contents,
so a device-flow token works for [Task Master](tasks.md) out of the box —
no re-provisioning needed the way a read-only fine-grained PAT requires
(see Task Master (additional scope) above).

Only one device-flow attempt is in flight per install at a time; starting a
new one supersedes any pending attempt.

### GitHub App (opt-in, layers on top of the PAT/OAuth token)

Everything above — the PAT and device-flow paths — is a **classic OAuth
App**, not a GitHub App (see the note above). This section is a deliberate,
narrower-scoped addition on top of that connection, not a replacement for
it: a genuine GitHub App, used for both [Task Master](tasks.md)'s own writes
(sync comments/labels, PR promotion, the branch push, issue ingest) and,
read-only, for the base GitHub integration's own polling (repo-status
widget, PR/CI poller). Everything else — including webhook registration,
which has no App-token equivalent (a GitHub App doesn't create per-repo
hooks, it receives events by installation) — keeps using the PAT/OAuth
token unconditionally.

Configuring one:

1. Register a **GitHub App** at
   [github.com/settings/apps](https://github.com/settings/apps) (or your
   org's equivalent) with **Issues: Read & write**, **Pull requests: Read &
   write**, **Contents: Read & write**, **Actions: Read-only**, and
   **Metadata: Read-only** permissions. No webhook subscription is needed
   here — that's the classic-App webhook path above.
2. Generate a private key for it and install the App on whichever
   repositories/orgs it should cover.
3. `PUT /api/integrations/github/app` with `{ "appId": "<numeric App id>",
"privateKey": "<PEM contents>" }`. Before persisting, the backend verifies
   the pair against GitHub's own `GET /app` — a genuine `401` (the key
   doesn't work) or a mismatched App id in the response (the key works, but
   for a _different_ App) is rejected with `400`, nothing stored. A
   response the backend can't get at all — a timeout, a `5xx`, or another
   `4xx` like a secondary rate limit — is treated as "GitHub had a bad
   moment," not "this credential is wrong": the App is still persisted, and
   the response reports `{ "verified": false, "warning": "..." }` instead
   of failing the request outright. On success the response is `{
"verified": true, "appSlug": "...", "keyFingerprint": "..." }`. Stored
   encrypted at rest, independent of the PAT/OAuth token — configuring one
   doesn't disturb the other. `DELETE /api/integrations/github/app` clears
   it. Settings → Integrations → GitHub shows whether an App is configured,
   its App id, installation count, and the current key's fingerprint —
   never the private key itself, which no endpoint echoes back.

Once configured, a call for `owner/repo` mints a short-lived (~1h)
installation token scoped to exactly that repository and one of two
permission sets — never the App's full installation grant, and never bound
to a single issue (a GitHub App installation token can't scope to an
individual issue, only a repository):

- **write** — Issues, Pull requests, Contents — used for Task Master's own
  writes and its issue-label ingest reads.
- **read** — Actions, Metadata, Pull requests — used for the repo-status
  widget and PR/CI poller.

The two are minted and cached independently, so an installation that only
granted the write set (e.g. one approved before Actions/Metadata were added
to the App definition) still gets Task Master's writes covered while the
read-scoped calls fall back to the PAT. If the App isn't installed on a
given `owner`, a mint 422s because the installation never granted that
permission set, or the mint fails outright (a transient GitHub outage), the
call transparently falls back to the PAT/OAuth token instead of failing
outright. The fallback itself is quiet — it's a debug/warn server log
line, not something surfaced on the task — because it's the expected
steady state for any repo the App simply isn't installed on, or any
installation that hasn't re-approved a widened permission set. Only a
_subsequent failure of the fallback write itself_ (e.g. the PAT also
lacking scope) reaches the task's `githubSyncError` field, the same way
any other write failure does (see [`tasks.md`](tasks.md#github-sync)). A
"not installed on this owner" or "permission denied" result is itself
cached for the same ~1h per repo _and_ per flavor, so installing the App on
a new owner (or re-approving a widened permission set) and expecting the
very next call to pick it up won't work — re-`PUT` the App config (even
with unchanged values, or via Settings → Integrations → GitHub → **Rotate
key** with the same key pasted back in) flushes both caches immediately
instead of waiting out the hour. Because the `PUT` now makes a live call to
GitHub (see above), this workaround itself degrades gracefully during an
outage: the caches still flush (`setGitHubApp` runs either way), just with
`verified: false` in the response rather than a confirmed check.

#### Rotating the private key

GitHub allows up to 25 active keys per App at once specifically so a
rotation never has a gap where nothing works — use that. There is no
separate "rotate" endpoint; `PUT /api/integrations/github/app` is both
"configure" and "rotate," and Settings → Integrations → GitHub → **Rotate
key** is the same request with the App id prefilled.

**Planned rotation:**

1. On GitHub, generate a **new** private key for the App. Don't delete the
   old one yet.
2. `PUT` the new key to Mullion (or use Settings' **Rotate key**). Confirm
   the response's `keyFingerprint` matches the fingerprint GitHub shows for
   the new key on its own App settings page.
3. Only now delete the old key on GitHub. Deleting it first would 401 every
   mint in the gap before step 2 lands.

Step 1–2's overlap window (old and new key both active on GitHub, only the
new one configured in Mullion) is the normal case GitHub's own multi-key
support exists for — but Mullion's JWT signing
(`signAppJwt`, `src/services/github-app.ts`) is deliberately single-key
only and sends no `kid` header claim, and that function's own doc comment
flags the multi-key window as a real-but-untested edge: GitHub's docs
don't state whether `kid` is required once an App has more than one active
key, so a mint during the overlap _could_ 401 and silently fall back to
the PAT rather than being confirmed to work. If a mint does fail during
this window, that's the edge case in question — see that comment before
assuming it's a Mullion bug.

**Suspected compromise** — invert the order: delete the key on GitHub
immediately, accept that installation-token mints fail and every call
falls back to the PAT/OAuth token until step 2, then `PUT` the replacement.

**What rotation does and doesn't do.** `PUT`ting a new key immediately
flushes every cached installation token and installation-id lookup for
this App (`clearInstallationTokenCacheForApp`), so Mullion stops _serving_
tokens minted under the old key right away. It does **not** revoke
already-minted tokens at GitHub's end. Installation access tokens are
independent, opaque credentials, not something GitHub invalidates as a
side effect of a key change — an installation token handed out moments
before rotation stays valid there for up to its own ~1h lifetime no matter
what happens to the key that signed the JWT which minted it, and deleting
the old key on GitHub doesn't change that either (it only stops _future_
JWTs from working, per GitHub's own docs on managing App private keys).
The only way to invalidate a specific already-issued token immediately is
`DELETE /installation/token`, called with that token itself — Mullion
doesn't do this today (a deliberate scope decision: the caches hold the
tokens, so it's feasible, but it would turn a synchronous cache flush into
a background sweep of `DELETE` calls with its own partial-failure mode). If
that ~1h residual window is unacceptable for a specific suspected
compromise, GitHub's own installation-suspend
(`PUT /app/installations/:id/suspended`, called with the App's own
credentials — GitHub's docs describe this as an App-owner/manager action,
not something available from the installing account's own Settings UI)
blocks that installation from the GitHub API immediately. GitHub's docs
don't explicitly say whether an already-issued installation token stops
working the moment an installation is suspended, or only future API calls
against it stop being authorized either way — confirm this against
GitHub's current documentation before relying on it as a guaranteed
immediate revocation, rather than trusting this paragraph's characterization
of it.

## Webhook delivery

Once connected, the backend polls GitHub for repo status. Enabling webhooks
replaces the fixed 60s poll cycle with push delivery: GitHub POSTs events
to your Mullion instance, and the poller adapts to a slower, rate-limit-
friendly quiet cycle after a webhook confirms there's nothing new.

Webhooks are opt-in. Enable them in Settings → Integrations → GitHub and
set `MULLION_WEBHOOK_BASE_URL` (see Configuration below). When enabled, the
backend registers a webhook on every connected repo that has a github.com
origin, using the stored PAT/OAuth token. A project added, or re-pointed at
a different repo, after webhooks are already enabled gets a hook
immediately too — `routes/projects.ts`'s create/update handlers register
one the same way `enableWebhooks` does — with a periodic reconciler (every
6h, plus a pass shortly after boot) as a backstop for anything that path
doesn't cover (a project added by direct DB write, a seed script, or while
the primary was down; a registration attempt that failed outright).
Deleting a project unregisters its hook.

Re-enabling webhooks (or the reconciler repairing a missing registration)
updates an already-existing Mullion hook's secret in place rather than
skipping it — this is what keeps a locally-stored secret and the one
GitHub's hook actually signs with from diverging after a restart with no
`MULLION_WEBHOOK_SECRET` set (each such restart would otherwise mint a
fresh local secret while the live hook kept the old one, silently 401ing
every delivery afterward).

Settings → Integrations → GitHub shows how many repos currently have a
live registration (`webhookRegisteredCount`), read from the same
per-project registration record the reconciler diffs against.

### How it works

When a webhook-enabled event occurs on GitHub (PR, CI run, issue, push,
etc.), GitHub sends an HTTP POST to
`MULLION_WEBHOOK_BASE_URL/api/webhooks/github`. The backend verifies the
payload via HMAC-SHA256 and forwards relevant updates to connected
frontends via a WebSocket channel (`/ws/github`). Deliveries are only
verified — and therefore only acted on — while webhooks are enabled; a
secret left over from a previous enable no longer verifies anything once
disabled.

`/ws/github`'s wire contract, unlike [`/ws/tasks`](tasks.md#the-tasks-panel)
(which pushes every task event install-wide with no handshake): a client
sends `{"type": "subscribe", "projectId": <number|string>}` per project it
wants events for — one socket can subscribe to several projects — and the
server pushes the matching `GitHubWSEvent` (`pr`/`issue`/`ci`/`release`/
`push`, see `github-ws-broadcast.ts`) to every socket subscribed to that
`projectId`. There's no unsubscribe message; a subscription lasts for the
socket's lifetime and is cleared on close.

Task Master shares this same delivery path (`#490`): a `labeled`/`opened`
issue event drives ingest immediately (`opened` is needed too — an issue
created _with_ the task label already on it fires `opened`, never
`labeled`), a `closed` event syncs the linked task to `done` immediately,
and an `unlabeled` event of the task label fails a `backlog`/`ready` task
(reversible via Retry) or leaves an already-claimed one alone — all three
using the exact same logic the poll-based watcher's own read-back uses
(`upsertIssueTask`/`syncClosedIssueToLocal`/`syncUnlabeledIssueToLocal`),
so the two paths can't produce different results for the same issue. This
is additive to, not a replacement for, the poll-based watcher described in
[`tasks.md`](tasks.md#task-model) — which keeps running as the fallback for
any install without webhooks enabled, or (per-repo, briefly) for a project
added after webhooks were already turned on, until the create/update
handler's immediate registration or the periodic reconciler catches up
(see the registration paragraph above).

The adaptive poller continues as a safety net:

| Mode    | Interval | Trigger                                               |
| ------- | -------- | ----------------------------------------------------- |
| active  | 15s      | Any repo has open PRs or running CI                   |
| quiet   | 60s      | No repo has open PRs or running CI                    |
| stalled | 30s      | No webhook received for `GITHUB_POLL_STALE_THRESHOLD` |

### Delivery options

Choose **one** of the following methods to make your Mullion instance
reachable from GitHub.

#### Option A: Public Traefik route (recommended for production)

Add a dedicated webhook endpoint to your Traefik configuration:

```yaml
# traefik-dynamic.yml
http:
  routers:
    mullion-webhooks:
      rule: "Host(`hooks.yourdomain.com`) && PathPrefix(`/api/webhooks/github`)"
      service: mullion
      middlewares:
        - chain-public # optional rate-limiting, no auth
  services:
    mullion:
      loadBalancer:
        servers:
          - url: "http://localhost:3456"
```

Set `MULLION_WEBHOOK_BASE_URL=https://hooks.yourdomain.com` in the Mullion
environment. The `deploy/traefik-dynamic.yml` template includes a
commented-out webhook router ready to use.

#### Option B: smee.io tunnel (recommended for development)

For local development or hosts without a public IP:

1. Install the smee client: `npm install -g smee-client`
2. Start the tunnel:
   `smee --url https://smee.io/YOUR_CHANNEL --path /api/webhooks/github --port 3456`
3. Set `MULLION_WEBHOOK_BASE_URL=https://smee.io/YOUR_CHANNEL` in the
   Mullion environment.
4. The smee client forwards POSTs to your local instance.

#### Option C: Authentik / reverse-proxy gateway

If you already expose the main Mullion frontend via Authentik, you can
expose the webhook endpoint through the same route by adding an exception
for `/api/webhooks/github` in Authentik's protected paths. The endpoint
performs its own HMAC verification and does not require app-level auth.

### Troubleshooting webhooks

- **Webhook registration fails**: Ensure the PAT has `admin:repo_hook`
  scope.
- **Webhook not received**: Check Traefik/smee connectivity. Verify
  `MULLION_WEBHOOK_BASE_URL` matches what GitHub will POST to.
- **HMAC verification fails**: Check that `MULLION_WEBHOOK_SECRET` matches
  between the Mullion backend and the GitHub webhook configuration. If
  auto-generated, the secret is stored in the DB — to regenerate, disable
  and re-enable webhooks from the Settings UI.

## API surface

| Endpoint                                   | Method | Notes                                                                                                                                                                                                                                                             |
| ------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/integrations/github`                 | GET    | Connection summary (`connected`, `tokenType`, `login`, `scopes`, `deviceFlowAvailable`, `webhookEnabled`) — never the token itself                                                                                                                                |
| `/api/integrations/github/token`           | PUT    | Set a PAT; validates against `GET /user` first. Rate-limited 10/min                                                                                                                                                                                               |
| `/api/integrations/github`                 | DELETE | Disconnect                                                                                                                                                                                                                                                        |
| `/api/integrations/github/device/start`    | POST   | Start device flow; 400 if `GITHUB_OAUTH_CLIENT_ID` isn't set. Rate-limited 10/min                                                                                                                                                                                 |
| `/api/integrations/github/device/status`   | GET    | Poll device-flow progress; 404 if none in progress                                                                                                                                                                                                                |
| `/api/integrations/github/app`             | PUT    | Configure (or rotate) a GitHub App's `appId`/`privateKey`. Verifies against `GET /app` first; 400 on a rejected/mismatched credential, otherwise `200 { verified, appSlug?, keyFingerprint, warning? }`. Rate-limited 10/min — see Rotating the private key above |
| `/api/integrations/github/app`             | DELETE | Clear the configured GitHub App                                                                                                                                                                                                                                   |
| `/api/integrations/github/webhooks/status` | GET    | Whether webhooks are enabled and the configured base URL                                                                                                                                                                                                          |
| `/api/integrations/github/webhooks`        | POST   | Enable webhooks: registers hooks on every connected repo. Rate-limited 10/min                                                                                                                                                                                     |
| `/api/integrations/github/webhooks`        | DELETE | Disable webhooks: tears down registered hooks                                                                                                                                                                                                                     |
| `/api/projects/:id/github`                 | GET    | Per-project repo status (issues, PRs, Actions runs, `ciStatus`). Rate-limited 30/min                                                                                                                                                                              |

`GET /api/projects/:id/github` degrades gracefully rather than erroring: it
returns 204 for no github.com remote, no connected account, or any GitHub
API failure (private repo the token can't see, GitHub rate-limited, etc.).
The only real error status is an unreachable _remote host_ on a multi-host
project (see [`multi-host.md`](multi-host.md)) — 503.

## Configuration reference

| Variable                      | Default        | Description                                                                                                                                 |
| ----------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_OAUTH_CLIENT_ID`      | _(empty)_      | GitHub OAuth App client id; enables the device-flow "Connect with GitHub" button. PAT connect works with no client id at all.               |
| `GITHUB_POLL_INTERVAL_ACTIVE` | `15`           | Seconds between adaptive poller ticks when a repo has open PRs or running CI.                                                               |
| `GITHUB_POLL_INTERVAL_QUIET`  | `60`           | Seconds between adaptive poller ticks when no repo has open PRs or running CI.                                                              |
| `GITHUB_POLL_STALE_THRESHOLD` | `300`          | Seconds without a webhook delivery before the poller enters stalled mode and syncs at 30s.                                                  |
| `MULLION_WEBHOOK_BASE_URL`    | _(empty)_      | Public https:// base URL for webhook delivery. Empty disables webhook support — polling alone is always active as a fallback.               |
| `MULLION_WEBHOOK_SECRET`      | Auto-generated | HMAC-SHA256 secret for webhook payload verification. If unset on first enable, a random secret is generated and stored encrypted in the DB. |

## Security

- The token is stored in the `integrations` table and encrypted at rest via
  `app.encryption` (AES-256-GCM) whenever `DB_ENCRYPTION_KEY` is set — same
  convention as remote-host tokens in `hosts`. As elsewhere in Mullion, this
  encryption is opt-in, not enforced specifically for this feature.
- No route has its own auth hook; like every other route, it relies on the
  app-wide gateway auth (external Traefik + Authentik `forwardAuth`) — see
  the main [README](../README.md). The one exception is
  `/api/webhooks/github`, which is intentionally unauthenticated at the app
  level (GitHub cannot send custom auth headers). Webhook payloads are
  verified via HMAC-SHA256 instead.
- Webhook secrets are encrypted at rest using the same `DB_ENCRYPTION_KEY`
  used for token storage.
- The token is never returned by any API response.

## Current limitations

- One shared credential for the whole install — not scoped per project or
  per browser user.
- Issue/PR listings cap at 100 open items in one page (no further
  pagination) and Actions status looks at the latest 100 runs on the
  default branch, keeping one latest run per workflow name. This is a
  glance-level widget, not an exhaustive report — a very active repo will
  undercount silently.
- Without webhooks, repo status is cached 60s per `owner/repo` (with ETag
  revalidation to save GitHub's rate-limit budget), so the widget can lag
  real GitHub state by up to a minute. With webhooks enabled the widget
  updates in real time and the poller drops to a slower quiet cycle.
- If the connected token lacks `Actions: read`, the CI dot just stays empty
  — there's no UI signal distinguishing "no workflows" from "no permission."
- GitHub Enterprise and non-github.com remotes aren't supported.
