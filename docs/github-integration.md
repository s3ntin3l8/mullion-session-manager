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

#### Release (additional scope, #744)

A repo whose `.github/workflows/` includes a `workflow_dispatch`-triggered
release-please workflow gets a **Release** section in the GitHub panel: it
shows the open `chore(main): release` PR (if any), a **Run** button that
dispatches the workflow on demand instead of waiting for the next push to
the default branch, and a **Merge** button gated hard on GitHub's own
mergeability verdict — never a force/override path.

**Run** needs `Actions: write` (classic PAT: the `workflow` scope) on top of
whatever scope you've already provisioned above — none of the read/write
sets do. Without it the button still renders (detecting the workflow only
needs `Actions: read`, already covered by the base scope), but every click
fails; the panel doesn't currently distinguish that from any other dispatch
failure (see Current limitations below — the same gap this doc already
notes for the CI dot). **Merge** reuses whatever write scope Task Master's
own **Pull requests** permission already provisioned above; no separate
grant needed.

**Autorelease (`#744`, [Task Master](tasks.md)'s per-project
`autoTagRelease` setting)** reuses the exact same Merge decision logic as the
button above (`resolveReleaseMerge`, `services/release-merge.ts`), from a
reconciler sweep instead of a click — same token scope as **Merge**, nothing
additional. Unlike **Run**, the sweep never dispatches: a task PR's own merge
is already the push that regenerates the release PR, so the sweep needs no
`Actions: write`/`dispatch`-scoped token at all. See
[Autorelease after tasks land](tasks.md#autorelease-after-tasks-land-744) for
the trigger, the quiet-window batching, and the `workflow_dispatch`-only
degradation (a repo without an `on: push` trigger on its release workflow
never gets a release PR out of a task landing, so the sweep waits forever —
the human still needs the manual **Run** button there).

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
   write**, **Contents: Read & write**, **Actions: Read & write** (#744 —
   `Read-only` covers the CI dot and repo-status widget, but not
   dispatching the release-please workflow), and **Metadata: Read-only**
   permissions. No webhook subscription is needed here — that's the
   classic-App webhook path above.
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
installation token scoped to exactly that repository and one of three
permission sets — never the App's full installation grant, and never bound
to a single issue (a GitHub App installation token can't scope to an
individual issue, only a repository):

- **write** — Issues, Pull requests, Contents — used for Task Master's own
  writes and its issue-label ingest reads.
- **read** — Actions, Metadata, Pull requests — used for the repo-status
  widget and PR/CI poller.
- **dispatch** (#744) — Actions: write, Metadata — used only for the
  release-please "Run" trigger (`POST .../actions/workflows/:id/dispatches`),
  which needs `actions: write`, a permission neither of the other two sets
  grants. Deliberately its own set rather than folded into `write`: Task
  Master's ordinary issue/PR/push writes have no business holding an
  Actions-write scope.

The three are minted and cached independently, so an installation that only
granted the write set (e.g. one approved before Actions/Metadata were added
to the App definition) still gets Task Master's writes covered while the
read- and dispatch-scoped calls fall back to the PAT. If the App isn't
installed on a given `owner`, a mint 422s because the installation never granted that
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

### Reviewer App (opt-in, a second identity — #737)

The GitHub App above and the review-agent PR review [Task Master](tasks.md)
posts (`createPullRequestReview`, `src/services/github-write.ts`) share the
same identity: the App that opens the draft PR is the same App that reviews
it. GitHub rejects both `APPROVE` and `REQUEST_CHANGES` from a PR's own
author with a 422, so that review is always `event: "COMMENT"` — it can
never gate merge, no matter how a repo's branch protection is configured.

A **second, separately-registered GitHub App** — used for nothing except
submitting that review — fixes this: as a distinct identity, its review can
be `APPROVE`/`REQUEST_CHANGES`, which a required-approving-reviews branch
protection rule does count (confirmed empirically against a real repo before
this shipped — a `github-actions[bot]`-style default token does not count
toward that rule, but a dedicated App or PAT does). Entirely optional and
independent of the primary App above — configuring one, the other, both, or
neither are all valid states. With no reviewer App configured, every review
keeps posting as `COMMENT` exactly as it does today.

Configuring one:

1. Register a **second GitHub App** at
   [github.com/settings/apps](https://github.com/settings/apps) — genuinely
   a different App from the one above, not the same App reused. Grant only
   **Pull requests: Read & write** and **Metadata: Read-only**. It
   deliberately gets no Issues/Contents grant: this identity only ever calls
   `createPullRequestReview`.
2. Generate a private key for it and install it on the same
   repositories/orgs as the primary App.
3. `PUT /api/integrations/github/reviewer-app` with the same
   `{ "appId": "...", "privateKey": "..." }` shape and the same live-verify-
   before-persist behavior as `PUT /api/integrations/github/app` above —
   see that section for the full verified/unreachable/rejected response
   contract, which this route shares byte-for-byte. **One additional
   check**: a `400` if `appId` matches the primary App's currently-configured
   id — configuring the same App as its own reviewer would silently
   reintroduce the exact 422 this mechanism exists to route around, so it's
   caught at config time instead of surfacing later as a mysterious
   COMMENT-only review. `DELETE /api/integrations/github/reviewer-app`
   clears it. Settings → Integrations → GitHub shows a second "Reviewer App"
   card, identical in shape to the App card above (App id, installation
   count, key fingerprint, rotation date) and rotated the same way.
4. Optional: give it a distinct avatar so its reviews are visually
   distinguishable from the primary App's in a PR's timeline.
   `docs/assets/github-reviewer-app-logo.png` is a variant of Mullion's own
   tile-grid mark — same geometry, recolored to indigo with a diagonal
   accent pair (standing for the two verdicts this identity can cast) —
   ready to upload as-is under the new App's Display information → Logo.
   Its artwork fills the canvas edge-to-edge, matching `icon-512.png`'s own
   geometry — GitHub's circular crop will clip each tile's outer corner
   slightly, the same tradeoff the app's own icon already accepts
   elsewhere. Set the App's background color to `#eef1ef` to match the
   thin transparent margin. The SVG source is alongside it if you need to
   re-export at a different size.

**Not wired up to a review yet.** As of this write-up, configuring a
reviewer App provisions the credential and its resolver
(`resolveReviewerToken`, `src/services/github-integration.ts` — mints a
short-lived installation token scoped to `pull_requests: write` +
`metadata: read` for a given repo) but **nothing in Task Master calls it
yet**: `createPullRequestReview` (`src/services/github-write.ts`) still
hardcodes `event: "COMMENT"` regardless of whether a reviewer App is
configured. Configuring one today has no visible effect on the review
agent's posted reviews — it's provisioning ahead of the follow-up change
that actually maps a review verdict onto a gating event and calls this
resolver. That follow-up will use exactly this shape:

- review agent verdict `clean` → `event: "APPROVE"`
- review agent verdict `changes-requested` → `event: "REQUEST_CHANGES"`
- verdict missing/inconclusive → `event: "COMMENT"` (unchanged)

**No PAT fallback, ever** — unlike `resolveGitHubToken`, `resolveReviewerToken`
never falls back to the shared PAT/OAuth token. Falling back would hand a
gating review to the primary identity, reintroducing the 422-from-the-
PR's-own-author problem this whole mechanism exists to avoid. Not
configured, not installed on this particular owner, or a mint failure will
all mean the same thing once the caller exists: that round's review quietly
downgrades to `COMMENT` from the primary identity, logged at `debug`, never
surfaced as a `githubSyncError` — the same "this is the expected steady
state for a repo the reviewer App isn't covering" posture `resolveGitHubToken`
already has for the primary App.

A reviewer App is **not** a substitute for a CODEOWNERS entry — a GitHub App
can't be a CODEOWNER. It can only satisfy a branch protection rule's numeric
"required approving reviews" count. See [`tasks.md`](tasks.md#merge-on-approve)
for what this will change about merge behavior once both branch protection
requires an approval and the follow-up review-wiring change has landed,
including what happens when Mullion's own later pushes (an auto-rebase, a
"branch is behind" update) dismiss that approval.

## Webhook delivery

Once connected, the backend polls GitHub for repo status. Enabling webhooks
replaces the fixed 60s poll cycle with push delivery: GitHub POSTs events
to your Mullion instance, and the poller adapts to a slower, rate-limit-
friendly quiet cycle after a webhook confirms there's nothing new.

Webhooks are opt-in. Enable them in Settings → Integrations → GitHub and
set `MULLION_WEBHOOK_BASE_URL` (see Configuration below). When enabled, the
backend registers a webhook on every connected repo that has a github.com
origin, using the stored PAT/OAuth token, subscribed to `pull_request`,
`push`, `issues`, `workflow_run`, `release`, and `issue_dependencies`
(`#667` — see the Task Master paragraph below for what that last one
drives). A project added, or re-pointed at a different repo, after
webhooks are already enabled gets a hook immediately too —
`routes/projects.ts`'s create/update handlers register one the same way
`enableWebhooks` does — with a periodic reconciler (every 6h, plus a pass
shortly after boot) as a backstop for anything that path doesn't cover (a
project added by direct DB write, a seed script, or while the primary was
down; a registration attempt that failed outright; **or, since `#667`, a
hook whose subscribed-event list is behind the one this version of Mullion
registers** — the reconciler diffs on `eventsVersion`, not just presence,
so a hook registered by a version of this install that predates an
event-list change re-registers automatically within one reconcile pass,
no manual re-enable needed). Deleting a project unregisters its hook.

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

`/ws/github`'s wire contract, unlike [`/ws/tasks`](tasks.md#the-task-board)
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

Dependency-aware claiming (`#667`, see
[`tasks.md`](tasks.md#dependency-aware-claiming-667)) rides the same
webhook two ways: an `issue_dependencies`/`blocked_by_added` or
`blocked_by_removed` delivery re-checks the blocked task's own dependency
state immediately, and a `closed` delivery for an issue with dependents
(`issue_dependencies_summary.blocking > 0`) re-checks each of them via
`GET .../dependencies/blocking` — the latter is what makes a landed
blocker unblock its dependents in ~1s instead of waiting for the next poll
tick. Both are fire-and-forget, same posture as the rest of this section;
a failure just leaves the affected task's dependency state as it was until
its next check.

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
| `/api/integrations/github/reviewer-app`    | PUT    | Configure (or rotate) the reviewer App (#737) — same shape/verification as the App route above, plus a 400 if `appId` matches the primary App's. Rate-limited 10/min                                                                                              |
| `/api/integrations/github/reviewer-app`    | DELETE | Clear the configured reviewer App                                                                                                                                                                                                                                 |
| `/api/integrations/github/webhooks/status` | GET    | Whether webhooks are enabled and the configured base URL                                                                                                                                                                                                          |
| `/api/integrations/github/webhooks`        | POST   | Enable webhooks: registers hooks on every connected repo. Rate-limited 10/min                                                                                                                                                                                     |
| `/api/integrations/github/webhooks`        | DELETE | Disable webhooks: tears down registered hooks                                                                                                                                                                                                                     |
| `/api/projects/:id/github`                 | GET    | Per-project repo status (issues, PRs, Actions runs, `ciStatus`). Rate-limited 30/min                                                                                                                                                                              |
| `/api/projects/:id/release`                | GET    | release-please detection + the open release PR's status (#744). Rate-limited 30/min                                                                                                                                                                               |
| `/api/projects/:id/release/run`            | POST   | Dispatches the release-please workflow. Needs a `dispatch`-scoped token. Rate-limited 10/min                                                                                                                                                                      |
| `/api/projects/:id/release/merge`          | POST   | Merges the open release PR, gated hard on GitHub's own mergeability verdict. Rate-limited 10/min                                                                                                                                                                  |

`GET /api/projects/:id/github` degrades gracefully rather than erroring: it
returns 204 for no github.com remote, no connected account, or any GitHub
API failure (private repo the token can't see, GitHub rate-limited, etc.).
The only real error status is an unreachable _remote host_ on a multi-host
project (see [`multi-host.md`](multi-host.md)) — 503.

`GET .../release` follows the same 204 posture, but unlike `/github` its
detection result is never collapsed into the 204 — see Current limitations
below for why that distinction exists. `POST .../release/run` and
`POST .../release/merge` follow a different convention from every other
write in this table: a domain refusal (no workflow, checks not green, the
branch moved) is a normal `200 { dispatched: false, reason }` /
`{ merged: false, reason }`, not a thrown error — only a genuine HTTP
failure does. Same posture as `POST /api/projects/:id/git-pull` (see
[`git-panel.md`](git-panel.md)).

## Configuration reference

See [`configuration.md`](configuration.md)'s "GitHub integration" section
for `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_POLL_INTERVAL_ACTIVE`,
`GITHUB_POLL_INTERVAL_QUIET`, `GITHUB_POLL_STALE_THRESHOLD`,
`MULLION_WEBHOOK_BASE_URL`, and `MULLION_WEBHOOK_SECRET` — that's the single
copy of this table now, so it doesn't drift from `.env.example` the way it
once did.

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
  The Release section (#744) deliberately does NOT repeat this: its
  detection result distinguishes `"not-configured"` (no release-please
  workflow) from `"no-actions-scope"` (the token couldn't even list
  workflows) — see `ProjectReleaseStatus` in `src/shared/types.ts`. Detection
  matches the workflow file's basename against `release-please.yml`/`.yaml`
  only — a repo whose release-please workflow lives under a different
  filename reports `"not-configured"` too, indistinguishable from actually
  having no release-please workflow at all. This is deliberate (a generic
  `release.yml` is too common a name for something unrelated to safely
  match), but it means renaming the workflow file away from the
  release-please-action default silently drops the Release section.
- The Release section's **Run** button is hidden only when the repo has no
  detectable release-please workflow — it does NOT hide itself when the
  token can list workflows but lacks the separate `Actions: write` dispatch
  scope; every click just fails with a `dispatch-failed` reason. Symmetric
  with the CI-dot gap above, not yet fixed for either.
- `workflow_dispatch` only exists on a workflow file once that file is on
  the repo's default branch — the Run button 422s with `reason:
"no-dispatch-trigger"` for a repo whose release workflow hasn't picked up
  a `workflow_dispatch:` trigger yet (including this repo itself, before
  the PR that added it merges).
- GitHub Enterprise and non-github.com remotes aren't supported.
- `.../dependencies/blocked_by` and `.../dependencies/blocking` (`#667`)
  are each capped at one page (100 items), matching the issue/PR listing
  cap above.
