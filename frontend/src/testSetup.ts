import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// vitest.config.ts doesn't set `test.globals: true` (this repo's convention
// is explicit `import { describe, it, ... } from "vitest"` everywhere), so
// Testing Library's own auto-cleanup — which only registers itself when it
// detects an ambient global `afterEach` — never fires. Without this, a
// component left mounted by one test's render() is still in the DOM for
// the next test in the same file, breaking any query that expects a single
// match (e.g. getByLabelText across multiple `it()`s).
afterEach(cleanup);
