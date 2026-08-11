// Shared version of a helper that used to be hand-copied, byte-for-byte,
// into 20+ test files (`function jsonResponse(status, body) { return new
// Response(JSON.stringify(body), { status, headers: {"content-type":
// "application/json"} }); }`) — every mocked `fetch` response in this test
// suite is built through this one shape, so it's worth a single shared
// definition rather than a redefine-per-file convention.
//
// A couple of files had grown a slightly richer variant that special-cases
// `status === 204` (no body, no content-type header, matching what a real
// 204 response looks like) — that variant is a strict superset of the
// plain one (every existing `jsonResponse(200, x)`/`jsonResponse(404, x)`
// call site behaves identically either way; the only call sites this
// changes are `jsonResponse(204, undefined)`, which already worked by
// accident before since `JSON.stringify(undefined)` is `undefined`, itself
// a valid empty-body `Response` argument). So this shared version adopts
// the 204-aware behavior unconditionally instead of keeping both.
export function jsonResponse(status: number, body?: unknown): Response {
  if (status === 204 || body === undefined) {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
