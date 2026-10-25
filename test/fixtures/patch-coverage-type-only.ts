// A type-only module, for the patch-coverage fallback's tests.
//
// Every line here is a type declaration or an import, so the file has NO
// executable line — which is exactly the case the fallback used to get
// wrong: it skipped a type declaration's FIRST line and its closing brace,
// and counted the body in between as uncovered executable code.
//
// Not part of any tsconfig `include`, so it is never compiled; it exists to
// be READ by the coverage tool's fallback path.
import type { CloneHealth, GitPullResult } from "../../src/shared/types.js";

export interface TypeOnlyFixture {
  a: string;
  b: number;
}

export type TypeOnlyAlias = {
  c: boolean;
};

export type { CloneHealth, GitPullResult };
