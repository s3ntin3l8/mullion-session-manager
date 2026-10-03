# Browser Automation & Control

Mullion features an in-app controllable browser (Phase 3) that allows AI agents to inspect, navigate, and interact with web pages and dev servers. This de-risks development loops by enabling agents to verify their own work (e.g., loading a page, filling forms, asserting UI changes) directly inside a browser Mullion controls.

The browser pane is fully integrated into the tiled Dockview layout (`BrowserPane.tsx`) as a WebSocket-driven canvas client.

---

## Architecture & Lifecycle

- **Pooled Playwright Instance:** Browsers are managed by `BrowserManager` (`src/services/browser-manager.ts`). Mullion runs **one Chromium browser instance per project**, rather than per session.
- **On-Demand Launch:** Chromium launches headlessly on the host the first time a bound session is opened or an automation call is made. It is gated by `BROWSER_ENABLED=true` in `.env`.
- **SSRF & Security Guards:** Headless Chromium is launched with `--no-sandbox` (for container compatibility) but is strictly restricted by `src/routes/browser.ts` to navigate **only** to `http://` or `https://` schemes. Direct filesystem (`file://`) or internal (`chrome://`) navigation is blocked to prevent local data exfiltration.

---

## 1. REST API for Agent Browser Control

Agents control the bound project browser by sending requests to the following endpoints. They share the same authentication and network boundaries as the rest of the Mullion API.

### `POST /api/sessions/:id/browser`

Performs an automation action on the session's bound browser. Every response automatically includes the current page URL, page title, and accessibility tree snapshots so that agents do not need to issue separate "read" requests.

#### Request Body Schema

The request must include an `action` property:

- **`navigate`**: Go to a specific URL.
  ```json
  {
    "action": "navigate",
    "url": "http://localhost:5173",
    "wait_until": "networkidle"
  }
  ```
  `wait_until` options: `"load"`, `"domcontentloaded"`, `"networkidle"`, or `"commit"`.
- **`click`**: Click an element by selector or reference.
  ```json
  {
    "action": "click",
    "ref": "e1"
  }
  ```
- **`fill`**: Populate an input field.
  ```json
  {
    "action": "fill",
    "ref": "e2",
    "value": "my-text-input"
  }
  ```
- **`eval`**: Execute arbitrary JavaScript in page context (or a `frame`'s context — see below).
  ```json
  {
    "action": "eval",
    "script": "document.querySelector('h1').innerText"
  }
  ```
- **`screenshot`**: Capture a PNG screenshot (returned as a base64-encoded string).
  ```json
  {
    "action": "screenshot"
  }
  ```
- **`snapshot`**: Refresh the current accessibility tree.
- **`download`** (issue #381): Retrieve a file the previewed app triggers a
  browser download for. See [The `download` action](#the-download-action-issue-381)
  below.

The full action set also includes `press`, `type`, `select`, `check`,
`uncheck`, `wait`, `dialog`, `hover`, `scroll`, `get`, `console`, and
`errors` (`src/routes/browser-automation.ts`) — keyboard/form input beyond
`fill`, waiting for a selector/condition, handling a native `alert`/
`confirm`/`prompt` dialog, and reading back the page's console/error buffers
without a separate `eval` round trip.

#### The `download` action (issue #381)

A download event fires during the **preceding** action (e.g. a `click` on a
"Download CSV" button), not during a later `download` action call — so
`page.waitForEvent("download")` called only when `download` itself runs
would frequently miss it. Mullion instead installs a `page.on("download",
...)` listener once, at browser-launch time
(`BrowserManager.getOrLaunch`, `src/services/browser-manager.ts`), and every
completed download is saved to a stable on-disk path (Playwright deletes a
download's own temp file once the browser context that produced it closes)
and buffered (capped at 50 entries — the oldest is evicted, deleting its
file, once the cap is exceeded).

```json
{
  "action": "download",
  "timeout_ms": 10000,
  "contents": true,
  "max_bytes": 65536,
  "clear": true
}
```

- `timeout_ms` (default `30000`, clamped to a max of `120000`): if a
  download is already buffered when this action runs, it returns
  immediately; otherwise it waits up to `timeout_ms` for one to arrive, then
  returns whatever's there (possibly empty).
- `contents` (default `false`): include the file's contents as base64.
- `max_bytes` (default **and hard cap** `1048576`, 1 MiB): an agent-supplied
  value above the cap is clamped down to it, never allowed to exceed it —
  the control socket (`src/plugins/control-socket.ts`) caps an NDJSON line
  at 2 MiB, and base64 inflates raw bytes by ~4/3, so 1 MiB raw stays safely
  under that line cap even with the rest of the JSON envelope added. Do not
  expect a larger cap: it would make `mullion browser download --contents`
  trip the socket's own oversized-line guard on exactly the large files it
  exists to help fetch.
- `clear` (default `false`): remove the entries returned in _this_ response
  from the server's buffer afterward (by identity, not a blunt clear — a
  download that completes concurrently between reading and clearing is not
  discarded). This does not delete the file on disk.

Response: `{ "downloads": [ { "filename", "path", "url", "size",
"timestamp", "contents"?, "truncated"? } ] }`, newest first. `contents` is
present only when requested and the file is within `max_bytes`; otherwise,
if `contents` was requested, `truncated: true` is set instead (the base64
string itself is never partially truncated, nor is the field silently
omitted with no explanation).

**Multi-host caveat:** `path` names a file on whichever host actually ran
the browser — meaningless to a caller on a different host (see
`docs/multi-host.md`). `contents` (base64) is the actually-portable field,
exactly like `screenshot`'s own base64 response.

#### The `frame` field (issue #382)

Any of `click`, `fill`, `select`, `check`, `uncheck`, `hover`, `get`, `wait`,
`scroll`, `snapshot`, `find` (its own endpoint, below), and `eval` may also
include a `frame` field: a CSS selector for an **iframe host element** (not
the frame's own body). When present, the action resolves and executes
against that iframe's own document instead of the top-level page:

```json
{
  "action": "click",
  "frame": "#payment-iframe",
  "selector": "#submit"
}
```

`press`/`type` also accept `frame`, but only when a `ref`/`selector` target
is also given — their no-target fallback (`page.keyboard.press`/`type`) is a
global key action with no frame-scoped analogue, and is rejected with a 400
if combined with `frame`.

`frame` is rejected with a 400 on `navigate`, `screenshot`, `dialog`,
`console`, `errors`, and `download` — these are page-or-manager-level by
nature (there's no per-frame navigation, screenshot, dialog queue,
console/error buffer, or download buffer).

**How it resolves:** `frame` is passed to
`page.locator(frameSelector).elementHandle()`, then `.contentFrame()`, to
get a real Playwright `Frame` object (not a `FrameLocator`, which has no
`.evaluate()` — needed for ref-tagging). If the selector matches more than
one element, Playwright's own "strict mode" error propagates as a 400
(ambiguous selectors are rejected, not silently resolved to the first
match).

**No ref collision, even with an identical ref string:** a frame's own
snapshot restarts its `e1, e2, ...` ref counter independently of the main
document's. `page.locator()` never descends into an iframe's separate
document tree, and every ref-resolving call is always scoped to whichever
root the caller explicitly named via `frame` — so `{"ref": "e3"}` (no
`frame`) and `{"frame": "#widget", "ref": "e3"}` can never resolve to each
other's elements, even though the ref string is identical.

**Response envelope:** when a `frame` field was given, the response's
trailing snapshot (see below) is taken of the **resolved frame**, not the
main page — that's the context with fresh refs the caller needs to keep
working — and the response includes `"frame": "<the selector>"` so it's
unambiguous which document the returned refs belong to. `url`/`title`
always describe the top-level page, regardless of `frame`.

**v1 limitation — no nested iframes:** `frame` takes exactly one selector,
resolved against the top-level document only. An iframe inside another
iframe is not reachable. This is a deliberate scope cut, not an oversight.

#### Response Format

```json
{
  "ok": true,
  "url": "http://localhost:5173/",
  "title": "My App Dashboard",
  "result": {},
  "snapshot": {
    "tree": "heading \"Welcome to My App\"\nbutton \"Click me\"",
    "elements": [
      {
        "ref": "e1",
        "role": "button",
        "name": "Click me",
        "tag": "button"
      }
    ]
  }
}
```

---

### `POST /api/sessions/:id/browser/find`

Locates specific elements in the active viewport using Playwright's locator engines. Matches are tagged with temporary reference handles (`ref`).

#### Request Body Schema

```json
{
  "by": "text" | "role" | "label" | "placeholder" | "testid",
  "value": "search string or role name",
  "name": "accessible name filter (only for by: role)",
  "limit": 10,
  "frame": "CSS selector for an iframe host element (optional — see the frame field above)"
}
```

#### Response Format

```json
{
  "ok": true,
  "matchCount": 1,
  "elements": [
    {
      "ref": "e1",
      "role": "button",
      "name": "Sign In",
      "tag": "button"
    }
  ]
}
```

---

## 2. Element Reference-Tagging (`data-mullion-ref`)

To bypass the need for agents to write fragile CSS/XPath selectors:

1. When a snapshot or find is requested, Mullion runs an in-page script to identify visible interactive elements.
2. These elements are tagged in the DOM with a custom attribute: `data-mullion-ref="e1"`, `data-mullion-ref="e2"`, etc.
3. Agents can target these elements in future `click` and `fill` actions by providing the `"ref"` key (e.g. `"ref": "e1"`).

> [!WARNING]
> References (`ref`) are short-lived. They are regenerated on every navigation, snapshot, or find call. Callers should resolve and use them within the same turn.

---

## 3. Cookie & Profile Import

To facilitate logging into corporate or personal staging environments, users can import cookies from their real browser profile (Chrome or Firefox) on the host, or upload a cookie export directly.

- **Storage & Retrieval:** Profile paths and metadata are saved in the `browser_cookies` table; the cookie values themselves are encrypted at rest via `app.encryption` (AES-256-GCM, when `DB_ENCRYPTION_KEY` is set — same convention as other encrypted-at-rest tables). Actual cookies are decrypted and loaded directly into the Playwright browser context when the project's browser launches (`BrowserManager.getOrLaunch`).
- **Endpoints:**
  - **`GET /api/projects/:projectId/browser-cookies`**: List imported cookie profiles for a project. Returns metadata summaries only; decrypted cookie values are **never** returned.
  - **`POST /api/projects/:projectId/browser-cookies/import`**: Synchronously parse and import cookies from a browser profile _path_ on the host's filesystem. Local-host projects only — a remote-hosted project's profile path lives on the agent's disk, not this process's; use Upload instead.
    ```json
    {
      "browser": "chrome",
      "profilePath": "/home/user/.config/google-chrome/Default",
      "label": "My Dev Profile"
    }
    ```
  - **`POST /api/projects/:projectId/browser-cookies/upload`**: Import cookies from an uploaded file's own bytes instead of a host path — works for any project regardless of which host it runs on.
    ```json
    {
      "browser": "chrome",
      "fileBase64": "<base64-encoded cookie export>",
      "label": "My Dev Profile"
    }
    ```
  - **`DELETE /api/projects/:projectId/browser-cookies/:id`**: Remove an imported cookie profile.

---

## 4. WebSocket Streaming Endpoint

The frontend `BrowserPane` attaches to the browser's live display via a dedicated WebSocket pipeline:

```
GET /ws/browser/:sessionId
```

- **Binary Frame Streaming:** Playwright captures page screenshot frames (`page.screenshot()`) and streams them down to the client as raw JPEG binary blobs.
- **Backpressure Handling:** To prevent network flooding and buffering lag, Mullion monitors socket queue size (`BACKPRESSURE_MAX_BUFFERED_BYTES = 4MB`). If client rendering falls behind, newer frames are dropped rather than queued.
- **Event Proxying:** Mouse clicks, movements, scroll wheels, and key events are serialized in the frontend and sent up to the WebSocket server, which replays them using Playwright's `page.mouse` and `page.keyboard` input APIs.
- **Clipboard sync:** Three additional message types cover paste/copy/cut,
  gated behind an explicit user gesture inside the pane rather than any
  generic clipboard mirroring:
  - `{type: "clipboard", text}` (client → server): a host paste
    (Ctrl/Cmd+V), captured by the client's own `paste` DOM event, not by
    forwarding the raw keystroke — the server calls `page.keyboard.insertText()`.
    Text is capped at the same byte limit the device clipboard feature uses
    (`docs/device-panel.md`) to bound the payload.
  - `{type: "copy"}` / `{type: "cut"}` (client → server): sent only from the
    client's own keydown handler on an explicit Ctrl/Cmd+C or +X inside the
    pane. The server reads the page's current selection via `page.evaluate()`
    _before_ pressing the real key (a cut destroys the selection), replies
    with `{type: "clipboard", text}` if non-empty, then presses
    `Control+c`/`Control+x` so the page's own copy/cut handlers (and, for
    cut, the deletion) still run. The press is modifier-aware (#1491): the
    server tracks, per page, which of Control/Meta/Alt/Shift the client's
    forwarded key down/up stream says are held. If Control is held it
    presses the bare `c`/`x` instead of the chord, so Control stays down in
    Playwright (a chord press would release it, and a follow-up Ctrl+A would
    type a literal). If Meta (Cmd) is held it lifts Meta, presses
    `Control+c`/`Control+x`, then re-presses Meta. A `press` message naming a
    modifier (e.g. `Control+a`) clears it from the tracked state. General
    Cmd→Ctrl mapping for other chords is not done here.
  - `{type: "clipboard", text}` (server → client): the reply to the above,
    written to the host clipboard by the client only while the tab has
    focus.
  - **Main-frame only:** the selection read for copy/cut does not reach into
    a cross-origin iframe — see
    [issue #1477](https://github.com/s3ntin3l8/mullion-session-manager/issues/1477).
  - **By design, not a gap:** a page's own clipboard writes (e.g. its own
    `navigator.clipboard.writeText()` call, or an in-page "Copy" button) are
    never synced to the host — only an explicit Ctrl/Cmd+C/+X gesture inside
    the pane triggers a copy/cut read. See
    [issue #1478](https://github.com/s3ntin3l8/mullion-session-manager/issues/1478).

---

## 5. Configuration and stream settings

`BROWSER_ENABLED` (default off) gates the whole feature. Settings → Browser
adds two UI-configurable runtime knobs, each falling back to a server-side
env default:

- **Browser pool size** (`BROWSER_MAX_INSTANCES`, clamped 1–32) — most
  browsers running at once, one per project. Marked restart-required: takes
  effect after the server next restarts.
- **Stream frame rate** (`BROWSER_FRAMERATE`) — frames per second for the
  live display above. No restart needed, but only applies to a newly opened
  pane for a project on this (the primary's own) machine, not one already
  streaming and not a remote-hosted project's pane.

See [`configuration.md`](configuration.md) for the full env var reference.

## 6. CLI and MCP

The same actions are reachable outside the dashboard: `mullion browser
<action>` (over the control socket, like the rest of the CLI) and the
`use_browser`/`browser_action` MCP tools (over the per-session hook socket,
`src/mcp/client.mjs` — the same channel the agent hooks in
[`agent-hooks.md`](agent-hooks.md) speak, not the control socket) both mirror
this action set. See [`cli.md`](cli.md)'s `browser` command section for the
full action list.
