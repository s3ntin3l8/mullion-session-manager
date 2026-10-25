import { describe, expect, it } from "vitest";
import { checkHookOrder, parseHookEntries } from "../../scripts/check-pre-push-hook-order.mjs";

const GOOD = `
repos:
  - repo: local
    hooks:
      - id: npm-test
        name: vitest (unit tests, backend)
        entry: npm run test:coverage
        always_run: false
        stages: [pre-push]
      - id: npm-test-frontend
        name: vitest (unit tests, frontend)
        entry: npm --prefix frontend run test:coverage
        stages: [pre-push]
      - id: patch-coverage
        name: patch test coverage (>= 75% on changed lines)
        entry: npm run check:patch-coverage
        always_run: true
        stages: [pre-push]
`;

describe("check-pre-push-hook-order", () => {
  it("parses hook entries in file order", () => {
    // The parser is plain JS, so TypeScript infers its `fields` as `{}` —
    // it really stores `{ key: value }` string pairs, so state the shape
    // the parser produces.
    const entries = parseHookEntries(GOOD) as Array<{
      id: string;
      fields: Record<string, string>;
    }>;
    expect(entries.map((e) => e.id)).toEqual(["npm-test", "npm-test-frontend", "patch-coverage"]);
    expect(entries[0].fields.entry).toBe("npm run test:coverage");
    expect(entries[2].fields["always_run"]).toBe("true");
  });

  it("accepts the intact wiring", () => {
    expect(checkHookOrder(GOOD)).toEqual([]);
  });

  it("fails when a hook is added after the patch-coverage hook", () => {
    // pre-commit runs hooks in file order, so a hook after patch-coverage
    // would have run FIRST and read a stale coverage report.
    const broken =
      GOOD + "\n      - id: something-else\n        entry: echo hi\n        stages: [pre-push]\n";
    const problems = checkHookOrder(broken);
    expect(problems.some((p) => p.includes("must be the LAST hook"))).toBe(true);
  });

  it("fails when the test hooks run plain 'test' instead of the coverage variant", () => {
    const broken = GOOD.replace("npm run test:coverage", "npm run test");
    const problems = checkHookOrder(broken);
    expect(problems.some((p) => p.includes("coverage variant"))).toBe(true);
  });

  it("fails when the patch-coverage hook loses always_run", () => {
    const broken = GOOD.replace("        always_run: true\n", "");
    const problems = checkHookOrder(broken);
    expect(problems.some((p) => p.includes("always_run"))).toBe(true);
  });

  it("fails when the patch-coverage hook is missing entirely", () => {
    const broken = GOOD.replace(/ {6}- id: patch-coverage[\s\S]*$/, "");
    const problems = checkHookOrder(broken);
    expect(problems.some((p) => p.includes("No 'patch-coverage' hook"))).toBe(true);
  });
});
