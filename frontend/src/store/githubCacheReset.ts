// Test-reset seam for the GitHub client cache (store/slices/github.ts). Kept
// in its own dependency-free module because testSetup.ts runs before a test
// file's vi.mock()s are registered: importing the slice itself from there
// would load the real api module first and defeat every test's api mock.
let reset: (() => void) | null = null;

export function registerGithubCacheReset(fn: () => void): void {
  reset = fn;
}

/** Test hook: drops the cache and in-flight requests (module-scoped state). */
export function __resetGithubCacheForTests(): void {
  reset?.();
}
