import http from "node:http";
import type { AddressInfo } from "node:net";

// A tiny, real HTTP server (not a static file) serving one fixture page for
// browser-actions.e2e.test.ts (and reused by multi-host.e2e.test.ts for a
// single `navigate`) — issue #407's checklist item "all 19 browser actions
// against a real page". Deliberately plain http.createServer, not a file://
// URL: browser-automation.ts's isSafeNavigationUrl() only allows http(s), so
// a real fixture must be actually served, not just present on disk.
//
// Every interactive element below has a stable CSS id, used as `selector` in
// browser-actions.e2e.test.ts rather than a `data-mullion-ref` — refs are
// re-tagged by executeBrowserAction's snapshot fold-in on EVERY action
// (browser-automation.ts's snapshotPage() call at the end of every branch),
// so a ref captured from action N is already stale by action N+1. Selectors
// stay valid across the whole sequence.
const FIXTURE_HTML = `<!doctype html>
<html>
<head>
<title>Fixture Page</title>
</head>
<body>
  <h1 id="heading">Fixture Heading</h1>

  <button id="click-btn" onclick="document.getElementById('click-result').textContent = 'clicked'">Click me</button>
  <span id="click-result"></span>

  <input id="text-input" type="text" placeholder="text-input-placeholder" />
  <input id="type-input" type="text" />
  <input id="press-input" type="text" onkeydown="document.getElementById('press-result').textContent += event.key" />
  <span id="press-result"></span>

  <select id="select-input">
    <option value="option1">One</option>
    <option value="option2">Two</option>
  </select>

  <input id="check-input" type="checkbox" />

  <div id="hover-target" onmouseenter="document.getElementById('hover-result').textContent = 'hovered'" style="width:100px;height:100px;">hover target</div>
  <span id="hover-result"></span>

  <button id="confirm-btn" onclick="document.getElementById('confirm-result').textContent = String(confirm('Are you sure?'))">Confirm</button>
  <span id="confirm-result"></span>

  <button id="prompt-btn" onclick="document.getElementById('prompt-result').textContent = String(prompt('Name?'))">Prompt</button>
  <span id="prompt-result"></span>

  <label for="labeled-input">A labeled field</label>
  <input id="labeled-input" aria-label="A labeled field" />
  <div data-testid="testid-target">testid target</div>

  <!-- Issue #382 (3.11) — a real, separate-document iframe for the frame
       field's e2e coverage. Its own document lives at /frame (below), a
       distinct HTTP response, not this same HTML re-served — the whole
       point is a genuinely separate Playwright Frame/document tree. -->
  <iframe id="frame-host" src="/frame" title="fixture iframe"></iframe>

  <!-- Issue #381 (3.10) — a real file download, exercised end to end by
       browser-actions.e2e.test.ts's "download" action test. A plain <a>
       navigation (not fetch/blob) so Chromium's real download machinery
       (Download.suggestedFilename/saveAs) is what's actually exercised,
       not just a same-page script. -->
  <a id="download-link" href="/download">Download CSV</a>

  <div style="height: 3000px;">tall spacer so scroll-to-bottom is observable</div>
  <div id="bottom-marker">bottom</div>

  <script>
    console.log("fixture-console-log");
    setTimeout(() => {
      throw new Error("fixture-thrown-error");
    }, 0);
  </script>
</body>
</html>`;

// Issue #382 (3.11) — the iframe's own document, served at /frame. Has its
// own <button>/<input> with ids that intentionally COLLIDE with none of the
// top-level page's ids, plus its own distinct heading, so tests can assert
// an action scoped via `frame: "#frame-host"` genuinely landed inside this
// document rather than the top-level one.
const FRAME_HTML = `<!doctype html>
<html>
<head>
<title>Fixture Frame</title>
</head>
<body>
  <h2 id="frame-heading">Fixture Frame Heading</h2>
  <button id="frame-click-btn" onclick="document.getElementById('frame-click-result').textContent = 'frame-clicked'">Click me (in frame)</button>
  <span id="frame-click-result"></span>
  <input id="frame-text-input" type="text" />
</body>
</html>`;

// Issue #381 (3.10) — a real file download response: a Content-Disposition
// "attachment" header is what actually makes Chromium treat this as a
// download instead of just navigating/rendering it inline, which is the
// whole reason this is a distinct route rather than reusing FIXTURE_HTML.
export const DOWNLOAD_CSV_FILENAME = "fixture-download.csv";
export const DOWNLOAD_CSV_CONTENTS = "name,value\nfixture,1\n";

export interface FixturePageServer {
  url: string;
  close: () => Promise<void>;
}

/** Starts a real HTTP server on an ephemeral port serving the fixture page
 * above at `/`, its nested-iframe document at `/frame`, and a real
 * Content-Disposition download at `/download`. Callers must `close()` it in
 * an `afterAll`. */
export function startFixturePageServer(): Promise<FixturePageServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/download") {
        res.writeHead(200, {
          "content-type": "text/csv",
          "content-disposition": `attachment; filename="${DOWNLOAD_CSV_FILENAME}"`,
        });
        res.end(DOWNLOAD_CSV_CONTENTS);
        return;
      }
      const html = req.url === "/frame" ? FRAME_HTML : FIXTURE_HTML;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
