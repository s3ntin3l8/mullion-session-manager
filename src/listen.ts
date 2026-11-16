import type { FastifyInstance } from "fastify";

/** The slice of the app `listenWithAgentFallback` needs; keeps it testable. */
export type ListenTarget = Pick<FastifyInstance, "listen" | "log"> & {
  config: { HOST: string; PORT: number; MULLION_ROLE: string };
};

const FALLBACK_HOST = "127.0.0.1";

function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1" || /^127\./.test(h);
}

/**
 * Bind the HTTP server. An agent whose configured HOST address is not on this
 * machine (EADDRNOTAVAIL: roaming laptop, down interface) falls back to
 * loopback instead of exiting: the outbound channel does not need the
 * listener. The fallback only ever narrows the bind; every other error and
 * every other role propagates unchanged.
 */
export async function listenWithAgentFallback(app: ListenTarget): Promise<string> {
  const { HOST, PORT, MULLION_ROLE } = app.config;
  try {
    return await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "EADDRNOTAVAIL" || MULLION_ROLE !== "agent" || isLoopbackHost(HOST)) {
      throw err;
    }
    app.log.warn(
      { host: HOST, port: PORT, fallback: FALLBACK_HOST },
      `Configured HOST ${HOST} is not available on this machine; listening on ${FALLBACK_HOST} instead (inbound LAN dialing is off until restart on a network that has the address)`,
    );
    return await app.listen({ port: PORT, host: FALLBACK_HOST });
  }
}
