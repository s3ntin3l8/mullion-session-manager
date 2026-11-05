import type { FastifyInstance, FastifyRequest } from "fastify";
import { timingSafeTokenMatch } from "./crypto-utils.js";
import { AGENT_CHANNEL_AUTH_HEADER } from "./agent-channel-tunnel.js";

/**
 * Whether `request` presents a credential that needs no signature: the static
 * MULLION_AGENT_TOKEN as a bearer, or (issue #2451) the process-local token a
 * request replayed from the outbound agent channel carries. The channel itself
 * was authenticated by the machine credential, so it presents no bearer; the
 * token is minted per process and only ever set by the in-process replay
 * (services/agent-channel-tunnel.ts).
 */
export function matchesStaticAgentCredential(
  app: FastifyInstance,
  request: FastifyRequest,
  bearer: string,
): boolean {
  const channelAuth = request.headers[AGENT_CHANNEL_AUTH_HEADER];
  const channelToken = app.agentChannelRequestToken ?? "";
  if (
    typeof channelAuth === "string" &&
    channelToken.length >= 32 &&
    timingSafeTokenMatch(channelAuth, channelToken)
  ) {
    return true;
  }
  // Issue #1059 — both fixed-length tokens (MULLION_AGENT_TOKEN is
  // server-configured; the inbound bearer is the same value);
  // timingSafeTokenMatch's length-side-channel is fine here. See
  // crypto-utils.ts for the full constraint.
  return (
    app.config.MULLION_AGENT_TOKEN.trim() !== "" &&
    timingSafeTokenMatch(bearer, app.config.MULLION_AGENT_TOKEN)
  );
}
