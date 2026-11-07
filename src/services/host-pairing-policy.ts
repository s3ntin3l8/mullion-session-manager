// The pairing code's two policy windows.
//
// They live in their own module because both the pairing flow
// (services/host-pairing.ts) and the host registry
// (services/host-registry.ts, which reads the retry window when it reports
// a host as unclaimed) need them, and the registry used to import the
// pairing module for the sake of one constant — an import cycle between two
// services that have nothing else to do with each other (issue #2414).

// How long a pairing code stays valid.
export const HOST_PAIRING_TTL_MS = 10 * 60 * 1000;
// After a successful redeem the code stays matchable this long, but only for
// the SAME request id: a Helper whose response was lost retries onto the same
// host instead of leaving an orphan and needing a new code.
export const HOST_PAIRING_RETRY_WINDOW_MS = 10 * 60 * 1000;
