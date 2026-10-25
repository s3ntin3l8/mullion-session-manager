// The DOM's `RequestInfo` — the type the tests' fetch mocks are written
// against (`(input: RequestInfo | URL, init?: RequestInit) => ...`).
//
// Node HAS a `RequestInfo`: `undici-types/fetch.d.ts` exports it as
// `string | URL | Request`. It is simply not exposed GLOBALLY, and the
// DOM's own alias is `Request | string` — a different union. So the type
// the tests are missing is a global one.
//
// It is declared here rather than pulling the whole DOM lib into the test
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
