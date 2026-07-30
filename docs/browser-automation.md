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
`console`, and `errors` — these are page-or-manager-level by nature (there's
no per-frame navigation, screenshot, dialog queue, or console/error buffer).

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

To facilitate logging into corporate or personal staging environments, users can import cookies from their real browser profile (Chrome or Firefox) on the host.

- **Storage & Retrieval:** Profile paths and metadata are saved in the `browser_cookies` table. Actual cookies are loaded directly into the Playwright browser context at startup.
- **Endpoints:**
  - **`GET /api/projects/:projectId/browser-cookies`**: List imported cookie profiles for a project. Returns metadata summaries only; decrypted cookie values are **never** returned.
  - **`POST /api/projects/:projectId/browser-cookies/import`**: Synchronously parse and import a browser profile's cookies.
    ```json
    {
      "browser": "chrome",
      "profilePath": "/home/user/.config/google-chrome/Default",
      "label": "My Dev Profile"
    }
    ```
  - **`DELETE /api/projects/:projectId/browser-cookies/:id`**: Remove an imported cookie profile.

---

## 4. WebSocket Streaming Endpoint

The frontend `BrowserPane` attaches to the browser's live display via a dedicated WebSocket pipeline:

```
GET /ws/sessions/:id/browser
```

- **Binary Frame Streaming:** Playwright captures page screenshot frames (`page.screenshot()`) and streams them down to the client as raw JPEG binary blobs.
- **Backpressure Handling:** To prevent network flooding and buffering lag, Mullion monitors socket queue size (`BACKPRESSURE_MAX_BUFFERED_BYTES = 4MB`). If client rendering falls behind, newer frames are dropped rather than queued.
- **Event Proxying:** Mouse clicks, movements, scroll wheels, and key events are serialized in the frontend and sent up to the WebSocket server, which replays them using Playwright's `page.mouse` and `page.keyboard` input APIs.
