import type { FastifyRequest } from "fastify";

// Shared accessor for a pattern that now appears at four security-relevant
// call sites (security.ts's rate-limit allowList, preview-proxy.ts's
// preview-auth failure counter and its onRequest hook, and — as of AS7 —
// enrollment.ts's CIDR gate on `hosts` row creation): read the connecting
// socket's own remote address, never Fastify's `request.ip`. `.ip` becomes
// forgeable via `X-Forwarded-For` the moment `trustProxy` is enabled (this
// app's Traefik deployment makes that plausible — see CLAUDE.md), at which
// point any external client could set that header to whatever it likes.
// `request.raw.socket.remoteAddress` is never influenced by trustProxy/XFF
// parsing, so every one of those checks reads it directly instead. This
// module only introduces the shared accessor for *new* call sites (see
// enrollment.ts) — the three pre-existing sites keep their own inline
// `request.raw.socket.remoteAddress` expressions rather than being
// refactored to call this, out of scope for the PR that added it.
export function getRawRemoteAddress(request: FastifyRequest): string {
  return request.raw.socket.remoteAddress ?? "";
}
