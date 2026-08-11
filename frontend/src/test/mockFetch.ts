import { vi } from "vitest";

// A declarative route table for mocking global `fetch`, generalizing the
// hand-rolled `vi.fn((input, init) => { ... })` big-if-chain that ~96 call
// sites across this suite each rebuild from scratch, plus
// Settings.hosts.test.tsx's own `unexpectedCalls` array + "assert empty in
// afterEach" pattern (the one file that already catches a request no test
// explicitly stubbed for, rather than only surfacing it as a swallowed
// promise rejection somewhere inside the component under test).

export interface MockFetchCtx {
  method: string;
  /** The full request URL exactly as passed to `fetch`, query string
   * included (e.g. `/api/hosts/remote-1?cascade=true`). */
  url: string;
  /** The path portion only, query string stripped. */
  path: string;
  /** Values captured from `:param` segments in the route pattern. */
  params: Record<string, string>;
  /** Parsed query string — `query.get("cascade")` rather than hand-rolling
   * a regex against the raw URL. */
  query: URLSearchParams;
  init?: RequestInit;
}

export type MockFetchHandler = (ctx: MockFetchCtx) => Response | Promise<Response>;

/** Keyed `"METHOD /path/:withParams"`, e.g. `"GET /api/projects"` or
 * `"DELETE /api/hosts/:id"`. A `:segment` matches exactly one path segment
 * (no `/`) and is passed to the handler via `ctx.params`; every other
 * character matches literally. The query string (if any) is never part of
 * route matching — inspect `ctx.query`/`ctx.url` inside the handler for
 * routes that branch on it (mirrors Settings.hosts.test.tsx's original
 * `?cascade=true` check, now `query.get("cascade") === "true"`). */
export type RouteTable = Record<string, MockFetchHandler>;

export interface MockFetchResult {
  fetchMock: ReturnType<typeof vi.fn>;
  /** Every `"METHOD url"` this mock received that didn't match any route in
   * the table. Assert this is `[]` in `afterEach` (see resetStore.ts's own
   * "generalizes a Settings.hosts.test.tsx pattern" precedent) to catch a
   * request the test forgot to stub — otherwise the only symptom is
   * whatever the app happened to do with a rejected fetch promise. */
  unexpectedCalls: string[];
}

interface CompiledRoute {
  method: string;
  regex: RegExp;
  paramNames: string[];
  handler: MockFetchHandler;
}

function compileRoute(key: string, handler: MockFetchHandler): CompiledRoute {
  const spaceIndex = key.indexOf(" ");
  if (spaceIndex === -1) {
    throw new Error(`mockFetch route key must be "METHOD /path", got: ${JSON.stringify(key)}`);
  }
  const method = key.slice(0, spaceIndex);
  const pattern = key.slice(spaceIndex + 1);
  const paramNames: string[] = [];
  const regexSource = pattern
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        paramNames.push(segment.slice(1));
        return "([^/?]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { method, regex: new RegExp(`^${regexSource}$`), paramNames, handler };
}

export function mockFetch(routes: RouteTable): MockFetchResult {
  const compiled = Object.entries(routes).map(([key, handler]) => compileRoute(key, handler));
  const unexpectedCalls: string[] = [];

  // `input` is assumed to be a string or URL, per this suite's actual call
  // sites (api.ts's `request<T>` always calls `fetch` with a relative
  // string path, never a Request object) — a Request input would stringify
  // to "[object Request]" and fail to match any route, landing in
  // `unexpectedCalls` with a useless key rather than a hard crash. Pin this
  // contract before extending mockFetch to a caller that might not hold it.
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const queryIndex = url.indexOf("?");
    const path = queryIndex === -1 ? url : url.slice(0, queryIndex);
    const query = new URLSearchParams(queryIndex === -1 ? "" : url.slice(queryIndex + 1));

    for (const route of compiled) {
      if (route.method !== method) continue;
      const match = route.regex.exec(path);
      if (!match) continue;
      const params: Record<string, string> = {};
      try {
        route.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(match[i + 1]);
        });
      } catch {
        // A malformed percent-encoded segment (e.g. a literal "%" in a
        // path param) throws URIError — route through the same
        // unexpectedCalls path as a genuinely unmatched route rather than
        // letting the exception escape the mock and fail the test with an
        // unrelated-looking stack trace.
        unexpectedCalls.push(`${method} ${url}`);
        return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
      }
      return Promise.resolve(route.handler({ method, url, path, params, query, init }));
    }

    unexpectedCalls.push(`${method} ${url}`);
    return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
  });

  return { fetchMock, unexpectedCalls };
}
