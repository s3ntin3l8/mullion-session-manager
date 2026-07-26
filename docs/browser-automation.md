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
- **`eval`**: Execute arbitrary JavaScript in page context. Scoped to the page frame.
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
  "limit": 10
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
