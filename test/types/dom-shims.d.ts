// The DOM's `RequestInfo` — the type the tests' fetch mocks are written
// against (`(input: RequestInfo | URL, init?: RequestInit) => ...`).
//
// @types/node provides `Request`, `RequestInit` and `URL` (undici's), but
// NOT `RequestInfo` — the DOM's own alias for "a URL or a Request". It is
// declared here rather than pulling the whole DOM lib into the test
// program: the DOM lib would change `RequestInit`, `BodyInit` and
// `ReadableStream` for `src/` too, and those files are CLEAN under the
// main tsconfig (which has no DOM lib) — adding it there breaks src/
// rather than fixing the tests.
//
// The DOM's own definition, verbatim:
//
//     type RequestInfo = Request | string;
//
type RequestInfo = Request | string;
