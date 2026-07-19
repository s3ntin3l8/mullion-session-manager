# GitHub integration

Tessera can connect to GitHub to surface repo status — open issues/PRs and
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

This is the tighter-scoped option — if you only care about issue/PR counts
and don't need Actions workflow status, a PAT without `Actions: read` still
works, it just leaves the CI dot empty rather than erroring.

### Device flow ("Connect with GitHub" button, opt-in)

This requires one-time setup by whoever operates the Tessera instance:

1. Register a **GitHub OAuth App** at
   [github.com/settings/developers](https://github.com/settings/developers)
   and enable **Device Flow** for it. (This is a classic OAuth App, not a
   GitHub App.)
2. Set `GITHUB_OAUTH_CLIENT_ID` to that app's client id in the **primary's**
   environment and restart. This is a public identifier, not a secret —
   safe to bake into the built frontend bundle or a log line, unlike
   `DB_ENCRYPTION_KEY`/`TESSERA_AGENT_TOKEN`. (Agent hosts never need this —
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

Only one device-flow attempt is in flight per install at a time; starting a
new one supersedes any pending attempt.

## API surface

| Endpoint                                 | Method | Notes                                                                                                            |
| ---------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| `/api/integrations/github`               | GET    | Connection summary (`connected`, `tokenType`, `login`, `scopes`, `deviceFlowAvailable`) — never the token itself |
| `/api/integrations/github/token`         | PUT    | Set a PAT; validates against `GET /user` first. Rate-limited 10/min                                              |
| `/api/integrations/github`               | DELETE | Disconnect                                                                                                       |
| `/api/integrations/github/device/start`  | POST   | Start device flow; 400 if `GITHUB_OAUTH_CLIENT_ID` isn't set. Rate-limited 10/min                                |
| `/api/integrations/github/device/status` | GET    | Poll device-flow progress; 404 if none in progress                                                               |
| `/api/projects/:id/github`               | GET    | Per-project repo status (issues, PRs, Actions runs, `ciStatus`). Rate-limited 30/min                             |

`GET /api/projects/:id/github` degrades gracefully rather than erroring: it
returns 204 for no github.com remote, no connected account, or any GitHub
API failure (private repo the token can't see, GitHub rate-limited, etc.).
The only real error status is an unreachable _remote host_ on a multi-host
project (see [`multi-host.md`](multi-host.md)) — 503.

## Security

- The token is stored in the `integrations` table and encrypted at rest via
  `app.encryption` (AES-256-GCM) whenever `DB_ENCRYPTION_KEY` is set — same
  convention as remote-host tokens in `hosts`. As elsewhere in Tessera, this
  encryption is opt-in, not enforced specifically for this feature.
- No route here has its own auth hook; like every other route, it relies on
  the app-wide gateway auth (external Traefik + Authentik `forwardAuth`) —
  see the main [README](../README.md).
- The token is never returned by any API response.

## Current limitations

- One shared credential for the whole install — not scoped per project or
  per browser user.
- Issue/PR listings cap at 100 open items in one page (no further
  pagination) and Actions status looks at the latest 100 runs on the
  default branch, keeping one latest run per workflow name. This is a
  glance-level widget, not an exhaustive report — a very active repo will
  undercount silently.
- Repo status is cached 60s per `owner/repo` (with ETag revalidation to
  save GitHub's rate-limit budget), so the widget can lag real GitHub state
  by up to a minute.
- If the connected token lacks `Actions: read`, the CI dot just stays empty
  — there's no UI signal distinguishing "no workflows" from "no
  permission."
- GitHub Enterprise and non-github.com remotes aren't supported.
