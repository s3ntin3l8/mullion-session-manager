// Phase 4 (#185) — control-socket.ts dispatches its ops by re-entering
// Fastify via app.inject() (see that file's doc comment for why: it gives
// the socket transport the exact same ajv validation, multi-host proxying,
// and side effects as the real REST routes, for free). @fastify/rate-limit's
// app-wide 100/min-per-IP gate (src/plugins/security.ts) would otherwise
// throttle a `mullion ps` polling loop the same way it throttles a hostile
// client, since app.inject() calls still flow through the normal request
// pipeline.
//
// This sentinel is passed as `remoteAddress` on every control-socket-driven
// app.inject() call and matched by security.ts's own rate-limit `allowList`
// predicate to exempt it. security.ts checks it against
// request.raw.socket.remoteAddress specifically, NOT Fastify's own
// request.ip — the latter is XFF-derived whenever trustProxy is configured,
// which would let any external HTTP client forge this string via an
// X-Forwarded-For header the moment that's ever enabled. The raw socket
// value light-my-request's own `remoteAddress` inject option sets is never
// influenced by trustProxy/XFF parsing, so a real network client can't
// present this string as its own connection address regardless of that
// future config — see security.ts's own comment at the allowList call site.
// Lives in its own module, rather than being decorated by either plugin
// onto `app`, because security.ts registers before control-socket.ts (see
// src/app.ts) and so cannot read a decorator the latter would otherwise
// supply.
export const CONTROL_SOCKET_ADDR = "mullion-control-socket";
