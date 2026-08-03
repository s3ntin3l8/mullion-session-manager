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
Master write** (claiming a task, most commonly). Only one of those writes
actually surfaces the error where you'd see it: a scope failure during
**promotion** (approve) shows a specific failure reason on the task
itself. Every other write — including that first claim — is
fire-and-forget by design (the local task row must never be blocked by a
GitHub failure), so a scope error there is logged server-side only and
never shown in the dashboard. If claiming a task never actually
labels/comments on its GitHub issue, check the server logs for a 403
before assuming something else is broken. If you're setting this up ahead
of time, save yourself that round trip and provision write access up
front.

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

### GitHub App (Task Master writes only, opt-in)

Everything above — the PAT and device-flow paths — is a **classic OAuth
App**, not a GitHub App (see the note above). This section is a deliberate,
narrowly-scoped exception: a genuine GitHub App, used **only** for [Task
Master](tasks.md)'s own writes (sync comments/labels, PR promotion, the
branch push). The repo-status widget, PR/CI poller, and webhook
registration all keep using the PAT/OAuth token above regardless of whether
an App is configured — this does not replace that connection.

Configuring one:

1. Register a **GitHub App** at
   [github.com/settings/apps](https://github.com/settings/apps) (or your
   org's equivalent) with **Issues: Read & write**, **Pull requests: Read &
   write**, and **Contents: Read & write** permissions. No webhook
   subscription is needed here — that's the classic-App webhook path above.
2. Generate a private key for it and install the App on whichever
   repositories/orgs Task Master should write to.
3. `PUT /api/integrations/github/app` with `{ "appId": "<numeric App id>",
"privateKey": "<PEM contents>" }`. Stored encrypted at rest, independent
   of the PAT/OAuth token — configuring one doesn't disturb the other.
   `DELETE /api/integrations/github/app` clears it.

Once configured, a Task Master write for `owner/repo` mints a short-lived
(~1h) installation token scoped to exactly that repository and the three
permissions above — never the App's full installation grant, and never
bound to a single issue (a GitHub App installation token can't scope to an
individual issue, only a repository). If the App isn't installed on a given
`owner`, or the mint itself fails (a transient GitHub outage), the write
transparently falls back to the PAT/OAuth token instead of failing outright
— recorded via the same `githubSyncError` field a PAT scope failure would
use (see [`tasks.md`](tasks.md#github-sync)). A "not installed on this
owner" result is itself cached for the same ~1h, so installing the App on a
new owner and expecting the very next write to pick it up won't work —
re-`PUT` the App config (even with unchanged values) to flush that cache
immediately, or wait out the hour.

## Webhook delivery

Once connected, the backend polls GitHub for repo status. Enabling webhooks
replaces the fixed 60s poll cycle with push delivery: GitHub POSTs events
to your Mullion instance, and the poller adapts to a slower, rate-limit-
friendly quiet cycle after a webhook confirms there's nothing new.

Webhooks are opt-in. Enable them in Settings → Integrations → GitHub and
set `MULLION_WEBHOOK_BASE_URL` (see Configuration below). When enabled, the
backend registers a webhook on every connected repo that has a github.com
origin, using the stored PAT/OAuth token.

### How it works

When a webhook-enabled event occurs on GitHub (PR, CI run, issue, push,
etc.), GitHub sends an HTTP POST to
`MULLION_WEBHOOK_BASE_URL/api/webhooks/github`. The backend verifies the
payload via HMAC-SHA256 and forwards relevant updates to connected
frontends via a WebSocket channel (`/ws/github`).

Task Master shares this same delivery path (`#490`): a `labeled`/`closed`
issue event also drives Task Master ingest immediately, using the exact
same insert-or-update logic the poll-based watcher uses, so the two can't
produce different results for the same issue. This is additive to, not a
replacement for, the poll-based watcher described in
[`tasks.md`](tasks.md#task-model) — which keeps running as the fallback for
any install without webhooks enabled, or for a project added after
webhooks were already turned on (registration only covers projects that
existed at enable time).

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

- **Webhook registration fails**: Ensure the PAT has `admin:repo_hooks`
  scope.
- **Webhook not received**: Check Traefik/smee connectivity. Verify
  `MULLION_WEBHOOK_BASE_URL` matches what GitHub will POST to.
- **HMAC verification fails**: Check that `MULLION_WEBHOOK_SECRET` matches
  between the Mullion backend and the GitHub webhook configuration. If
  auto-generated, the secret is stored in the DB — to regenerate, disable
  and re-enable webhooks from the Settings UI.

## API surface

| Endpoint                                 | Method | Notes                                                                                                                              |
| ---------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `/api/integrations/github`               | GET    | Connection summary (`connected`, `tokenType`, `login`, `scopes`, `deviceFlowAvailable`, `webhookEnabled`) — never the token itself |
| `/api/integrations/github/token`         | PUT    | Set a PAT; validates against `GET /user` first. Rate-limited 10/min                                                                |
| `/api/integrations/github`               | DELETE | Disconnect                                                                                                                         |
| `/api/integrations/github/device/start`  | POST   | Start device flow; 400 if `GITHUB_OAUTH_CLIENT_ID` isn't set. Rate-limited 10/min                                                  |
| `/api/integrations/github/device/status` | GET    | Poll device-flow progress; 404 if none in progress                                                                                 |
| `/api/projects/:id/github`               | GET    | Per-project repo status (issues, PRs, Actions runs, `ciStatus`). Rate-limited 30/min                                               |

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
