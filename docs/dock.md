# Dock

The Dock is a persistent bottom panel showing per-project monitors — dev
servers, logs, status watchers — one column per project currently tiled in
the active workspace (plus any manually pinned). Each column can have
multiple toggleable monitors, each running as a `kind: "dock"` session
that stays out of the normal per-project session inventory.

A monitor is just a shell command that runs on the host (the same
`dtach` + `systemd --user` lifecycle as regular terminal sessions), so
it survives service restarts and tab closures. The Dock never starts a
monitor that isn't already configured in `dock.json`.

A project's column can also show:

- **GitHub status** — open issue/PR counts and a CI status dot, if a
  GitHub account is connected and the project has a `github.com` origin
  remote. Clicking opens the GitHub panel. See
  [`docs/github-integration.md`](github-integration.md).
- **Browser preview** — a shortcut to open the project's dev server URL
  in a dockview panel, if one is configured. Clicking opens the browser
  preview panel. See [`docs/browser-previews.md`](browser-previews.md).

## Quick start

Create `.crs/dock.json` in your project's repo (the path must be exactly `.crs/dock.json` relative to the project root):

```json
{
  "controls": [
    {
      "id": "dev-server",
      "title": "Dev server",
      "command": "make dev"
    },
    {
      "id": "logs",
      "title": "Logs",
      "command": "tail -f data/app.log"
    }
  ]
}
```

Refresh the dashboard — the Dock appears at the bottom with a column for
your project, each monitor showing a toggle switch. Click a monitor to
start it; its terminal output appears inline.

## dock.json schema

The file lives at `.crs/dock.json` inside a project's repo (tracked,
team-shareable). A global fallback lives at `~/.config/crs/dock.json`
(controlled by `CRS_CONFIG_DIR`).

### Fields (`DockControl`)

| Field     | Type                    | Required | Description                                              |
| --------- | ----------------------- | -------- | -------------------------------------------------------- |
| `id`      | `string`                | yes      | Unique identifier for this monitor                       |
| `title`   | `string`                | yes      | Display name shown in the column header                  |
| `command` | `string`                | yes      | Shell command to run (`npm run dev`, `tail -f log`, ...) |
| `cwd`     | `string`                | no       | Working directory override (defaults to project root)    |
| `height`  | `number`                | no       | Initial terminal height in pixels for the monitor body   |
| `env`     | `Record<string,string>` | no       | Environment variables to set for the session             |

### Full example

```json
{
  "controls": [
    {
      "id": "dev-server",
      "title": "Dev server",
      "command": "npm run dev",
      "cwd": "packages/frontend",
      "height": 300,
      "env": { "NODE_ENV": "development" }
    },
    {
      "id": "typecheck-watch",
      "title": "TypeScript",
      "command": "tsc --noEmit --watch"
    }
  ]
}
```

### Validation

- `id`, `title`, and `command` must be non-empty strings.
- `height` must be a positive integer (pixel value for the monitor body).
- `env` entries must be string-to-string.
- A malformed file is silently treated as empty — the backend logs a
  warning but never throws.

## Global vs. per-project config

The Dock merges two config layers by monitor `id`:

1. **Global defaults** — `<configDir>/dock.json`
   (`~/.config/crs/dock.json` by default).
2. **Per-project overrides** — `<project>/.crs/dock.json`.

Per-project wins on `id` conflict. Unlike the action launcher
(`actions.json`), there is no `override` flag — dock monitors are
commonly additive across a team's shared config and a developer's
personal ones, so only `id`-based merge is supported.

## Dev server port detection

When a dock monitor's session output contains a dev server startup banner
matching `Local: http(s)://localhost:<port>`, the backend extracts the
port and surfaces it as a suggestion when editing the project's
`devServerUrl` setting. The detected port is never auto-applied.

Detection covers Vite, Next.js, Create React App, and Astro startup
banners. It strips ANSI escape sequences before matching (real PTY
output includes color/bold formatting). Only the _last_ matching port
is returned, so a dev server that restarts on a different port produces
the right result.

Only works for local-host projects (the same process's PtyManager).
A remote-hosted project's dock sessions live on a different machine and
are not scanned.

## UI reference

| Operation                    | How                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| **Toggle a monitor on/off**  | Click the monitor's header row                                                      |
| **Resize the Dock height**   | Drag the top border handle (`ns-resize` cursor)                                     |
| **Collapse/expand the Dock** | Click the chevron button (collapsed header shows live monitor count)                |
| **Resize column widths**     | Drag the vertical dividers between columns                                          |
| **Pin a project column**     | Use the "+ Add project column" dropdown in the Dock header                          |
| **Remove a pinned column**   | Click the "x" on a manually pinned column (not shown for workspace-derived columns) |
| **Open GitHub panel**        | Click the GitHub status row in a project's column                                   |
| **Open browser preview**     | Click the browser URL row in a project's column                                     |

Dock state persists to `localStorage` (collapsed state, region height,
manually pinned project IDs). Column widths from divider drags are
ephemeral and reset on reload.

## Troubleshooting

- **Monitors don't appear.** Check that `.crs/dock.json` is valid JSON
  with a `controls` array. A parse failure is silently reduced to an
  empty list — check the backend logs for a warning.
- **Config changes don't take effect.** The dock config is read at
  render time and cached per-page navigation. Re-navigate to the
  project or restart the dashboard to pick up changes.
- **No dev server port detected.** Only local-host projects are scanned.
  The banner must contain `Local:` followed by an `http(s)://localhost`
  URL — some frameworks use different labels or non-standard ports
  without the word "Local".
