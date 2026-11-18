import type { WebSocket as NodeWebSocket } from "ws";
import { browserTargetQuery, type BrowserTarget } from "./browser-manager.js";

// RemoteHostClient browser facet (issue #3289 / #3302; convention in
// remote-host-devices.ts).

/** The client's `request`, bound. An omitted timeout means the client default. */
export type BrowserRequest = <T>(
  path: string,
  init?: RequestInit,
  timeoutMs?: number,
) => Promise<T>;

export interface BrowserClientDeps {
  request: BrowserRequest;
  openInbound: (requestTarget: string) => NodeWebSocket;
}

export function createBrowserClient({ request, openInbound }: BrowserClientDeps) {
  function post(path: string, target: BrowserTarget, body?: unknown): Promise<unknown> {
    return request(`${path}?${browserTargetQuery(target)}`, {
      method: "POST",
      // No JSON content type without a body: Fastify refuses an empty body
      // under it, which failed every close against a real agent (#2688).
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  return {
    /** POST to an agent browser route, naming the target in the query. */
    post,

    action(sessionId: number, target: BrowserTarget, body: unknown): Promise<unknown> {
      return post(`/internal/sessions/${sessionId}/browser`, target, body);
    },

    find(sessionId: number, target: BrowserTarget, body: unknown): Promise<unknown> {
      return post(`/internal/sessions/${sessionId}/browser/find`, target, body);
    },

    openSocket(sessionId: number, target: BrowserTarget): NodeWebSocket {
      const requestTarget = `/internal/ws/browser/${sessionId}?${browserTargetQuery(target)}`;
      return openInbound(requestTarget);
    },
  };
}

export type BrowserClient = ReturnType<typeof createBrowserClient>;
