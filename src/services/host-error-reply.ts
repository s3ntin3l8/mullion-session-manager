// Issue #431 — a remote host's 4xx (symlink refusal, oversized content, an
// unknown target) used to be flattened into the same 503 "Host unreachable"
// as a genuine connectivity failure. The host isn't unreachable here — it
// responded and said no — so forward its real status and the reason it
// gave, the same way a local-host failure already does.
//
// Originally defined in routes/agent-rules.ts (Hermes review, PR #458) and
// exported from there; routes/skills.ts and routes/hosts.ts already
// imported that export, but routes/dock-config.ts couldn't (agent-rules.ts
// wasn't a route it could import from without an awkward route-to-route
// dependency) and so carried a byte-for-byte duplicate of the function
// instead. Extracted to this services/ module to give every consumer —
// including agent-rules.ts itself — a shared, dependency-direction-correct
// home, and to retire dock-config.ts's duplicate.
import type { FastifyReply } from "fastify";
import type { HostRequestError } from "./remote-host-client.js";

export function forwardHostRequestError(reply: FastifyReply, err: HostRequestError) {
  // Independent review, PR #458 — a 401/403 from the agent means its own
  // bearer-token check rejected us (a rotated MULLION_AGENT_TOKEN, e.g.) —
  // an infrastructure/config problem, not something about THIS specific
  // edit. Forwarding it raw would read to a browser like "you need to log
  // in," which it isn't (and no other RemoteHostClient caller in this repo
  // forwards a HostRequestError's status verbatim at all — this is the
  // first place that does, precisely because the OTHER 4xx classes here
  // genuinely are request-specific and worth showing as-is).
  if (err.statusCode === 401 || err.statusCode === 403) {
    return reply.serviceUnavailable("Host rejected the request — check its agent token");
  }
  let message = err.message;
  try {
    const parsed: unknown = JSON.parse(err.body);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { message?: unknown }).message === "string"
    ) {
      message = (parsed as { message: string }).message;
    }
  } catch {
    // Not a JSON body — fall back to HostRequestError's own message.
  }
  return reply.code(err.statusCode).send({ message });
}
