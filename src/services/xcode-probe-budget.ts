/**
 * The Xcode capability probe's time budget (#3511), in its own module so the
 * primary's client (remote-host-client-core.ts) can size its request to the
 * agent's worst case without importing host-capabilities.ts, which the test
 * suites mock wholesale.
 */

// Per probe step. `xcodebuild -checkFirstLaunchStatus` takes ~6 s and `simctl
// list` ~2 s on an idle Mac, and over 10 s under load, so the bound has real
// headroom.
export const XCRUN_TIMEOUT_MS = 30_000;

/**
 * `xcrun --find simctl`, `xcodebuild -checkFirstLaunchStatus`, `simctl list`.
 * host-capabilities.test.ts pins this against the commands probeXcode runs,
 * so a new step cannot leave the client's budget short of the real worst case.
 */
export const XCODE_PROBE_STEPS = 3;
/** An inconclusive probe is retried once. */
export const XCODE_PROBE_ATTEMPTS = 2;

/** The longest one capabilities read can take on the agent: every step timing out. */
export const XCODE_PROBE_WORST_CASE_MS =
  XCODE_PROBE_ATTEMPTS * XCODE_PROBE_STEPS * XCRUN_TIMEOUT_MS;
