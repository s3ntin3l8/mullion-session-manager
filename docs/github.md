# GitHub Webhook Delivery

Phase 2 of GitHub integration adds webhook-driven real-time updates. This
document covers the delivery options and how to configure them.

## How It Works

When a webhook-enabled event occurs on GitHub (PR, CI run, issue, push, etc.),
GitHub sends an HTTP POST to `MULLION_WEBHOOK_BASE_URL/api/webhooks/github`.
The backend verifies the payload via HMAC-SHA256 and forwards relevant updates
to connected frontends via a WebSocket channel (`/ws/github`).

## Delivery Options

Choose **one** of the following methods to make your Mullion instance reachable
from GitHub.

### Option A: Public Traefik route (recommended for production)

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
environment.

### Option B: smee.io tunnel (recommended for development)

For local development or hosts without a public IP:

1. Install the smee client: `npm install -g smee-client`
2. Start the tunnel: `smee --url https://smee.io/YOUR_CHANNEL --path /api/webhooks/github --port 3456`
3. Set `MULLION_WEBHOOK_BASE_URL=https://smee.io/YOUR_CHANNEL` in the Mullion
   environment.
4. The smee client forwards POSTs to your local instance.

### Option C: Authentik / reverse-proxy gateway

If you already expose the main Mullion frontend via Authentik, you can expose
the webhook endpoint through the same route by adding an exception for
`/api/webhooks/github` in Authentik's protected paths. The endpoint performs
its own HMAC verification and does not require app-level auth.

## Configuration

| Variable                   | Required        | Default        | Description                                                                                                                                                     |
| -------------------------- | --------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MULLION_WEBHOOK_BASE_URL` | Yes (to enable) | —              | Public base URL for webhook delivery. Must be the externally-accessible URL without a trailing `/api/webhooks/github`. Empty or unset disables webhook support. |
| `MULLION_WEBHOOK_SECRET`   | No              | Auto-generated | HMAC-SHA256 secret for webhook verification. If unset, a random secret is generated on first enable and stored encrypted in the DB.                             |

## Security

- Webhook payloads are verified via HMAC-SHA256 using the stored secret.
- The `/api/webhooks/github` endpoint is intentionally **unauthenticated** at
  the app level — GitHub cannot send custom auth headers. HMAC is the trust
  mechanism.
- Webhook secrets are encrypted at rest using the same `DB_ENCRYPTION_KEY` used
  for token storage.

## Troubleshooting

- **Webhook registration fails**: Ensure the PAT has `admin:repo_hooks` scope.
- **Webhook not received**: Check Traefik/smee connectivity. Verify
  `MULLION_WEBHOOK_BASE_URL` matches what GitHub will POST to.
- **HMAC verification fails**: Check that `MULLION_WEBHOOK_SECRET` matches
  between the Mullion backend and the GitHub webhook configuration. If auto-
  generated, the secret is stored in the DB — to regenerate, disable and re-
  enable webhooks from the Settings UI.
