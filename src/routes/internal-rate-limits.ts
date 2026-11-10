// Not a public rate limit exemption — a distinct, higher ceiling. A primary
// polling this agent's bulk live-status/liveness endpoints at the reconcile
// cadence (a follow-up PR) is legitimate, frequent traffic from a single
// caller, unlike the public-facing default (security.ts's RATE_LIMIT_MAX,
// tuned for a browser). Still bounded, since the token alone doesn't prove
// the caller is well-behaved.
export const INTERNAL_RATE_LIMIT = { config: { rateLimit: { max: 1000, timeWindow: "1 minute" } } };

// Issue #1101 — mirrors routes/project-setup.ts's own GENERATE_RATE_LIMIT
// reasoning: POST /internal/run-generation-turn spawns a real, costly agent
// CLI turn on THIS agent's own filesystem, a different cost class than the
// rest of this file's cheap filesystem/git-plumbing routes
// (INTERNAL_RATE_LIMIT's 1000/min above). A confused or malicious primary
// hammering this route could otherwise burn real tokens/time on this host
// with no independent guard beyond whatever the primary's own route
// enforces. Module-scope, same as INTERNAL_RATE_LIMIT above — every other
// per-route rate-limit export const in this file lives here, not inside
// internalRoutes() itself.
// Issue #1951 follow-up — PUT /internal/projects-roots moves the containment
// barrier of this agent's file and git routes, so it gets its own tight limit
// instead of INTERNAL_RATE_LIMIT's 1000/min: a person edits this a few times,
// never in a loop.
export const PROJECTS_ROOTS_RATE_LIMIT = {
  config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
};

// A clone is the heaviest thing an agent runs on request (up to 10 minutes of
// git over the network and a directory it creates), so it gets a tight limit
// like PROJECTS_ROOTS_RATE_LIMIT rather than INTERNAL_RATE_LIMIT's 1000/min.
export const GIT_CLONE_RATE_LIMIT = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

export const GENERATION_TURN_RATE_LIMIT = {
  config: { rateLimit: { max: 5, timeWindow: "10 minutes" } },
};
