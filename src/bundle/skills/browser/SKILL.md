---
name: browser
description: "Driving the browser pane Mullion binds to a hosted session — mullion browser <action> / the browser_action, use_browser MCP tools. Covers download capture, the ref-invalidation footgun, and iframes. Read this if you're an agent CLI running inside a Mullion-hosted session with a browser pane, in ANY repo."
---

# Mullion browser automation

Check for `$MULLION_SOCKET_PATH` before following anything below — if it's
unset, you're not inside a Mullion-hosted session and this control surface
isn't available. Even inside a session, this only works if `BROWSER_ENABLED`
is on and a browser pane is bound to it — if `mullion browser <action>` (or
the MCP tools) reply with an error saying no browser is bound, that's the
reason, not a bug.

## Actions

`mullion browser <action>` (or the MCP `browser_action`/`use_browser`
tools) drives the pane: `navigate`, `snapshot`, `click`, `fill`, `type`,
`press`, `select`, `check`/`uncheck`, `hover`, `scroll`, `wait`, `dialog`,
`get`, `eval`, `screenshot`, `console`, `errors`, `find`, `download`. See
`docs/cli.md`'s browser table for each action's full argument shape.

## Capturing a file download

`download` retrieves a file the previewed app triggers a browser download
for (a CSV export, a PDF report, ...). The download is captured by a
listener installed once at browser-launch time, so it doesn't matter
whether the triggering click already happened before you think to call
`download` — it waits up to `timeout_ms` (default 30s, capped at 120s) if
nothing's buffered yet. Pass `contents: true` (`--contents`, or implicitly
via `--out <path>` on the CLI) to get the file's bytes back as base64,
subject to a 1 MiB `max_bytes` cap. `path` is host-local; `contents` is the
portable field if the session is remote-hosted.

## The ref-invalidation footgun

A `ref` returned by `snapshot`/`find`/`click`/etc. is invalidated by the
very next `navigate` or `snapshot`/`find` call. **Re-snapshot before reusing
a ref** — a stale ref from three actions ago will not silently work, and
this is the single most common way a scripted multi-step interaction
breaks. Target by `--selector` instead when you don't need a fresh snapshot
anyway.

`eval` runs arbitrary in-page JavaScript with no additional restriction
beyond what an authenticated caller can already do through the browser
pane — same trust tier as shell access through your own terminal, scoped to
whatever the browser can reach.

## Driving content inside an iframe

Most actions (all except `navigate`, `screenshot`, `dialog`, `console`,
`errors`, `download`) accept a `frame` field/`--frame` flag — a CSS
selector for the iframe's host element — scoping the action to that
iframe's own document (a Stripe payment widget, an embedded chat, ...).
`press`/`type` only accept it alongside a `ref`/`selector` target. A ref
from a `frame`-scoped `snapshot`/`find` only resolves inside that same
frame — pass `frame` again on the follow-up action or the lookup won't find
it. Nested iframes aren't supported.
