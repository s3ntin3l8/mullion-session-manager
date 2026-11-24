import type { ComposeService } from "./docker-service-detect.js";
import type { GitRequest } from "./remote-host-git.js";

// The `/internal/docker-*` and `/internal/dev-server-port` request builders of
// RemoteHostClient (issue #3427; convention in remote-host-git.ts). Each takes
// the client's own `request` (bound), so every call still goes through
// RemoteHostTransport.

export interface RemoteDockerServices {
  /** `docker compose` availability on the agent host (it picks the logs command). */
  composeAvailable: boolean;
  /** Every Compose service whose working directory is inside the asked cwd.
   * Empty on a host with no Docker. */
  services: ComposeService[];
}

export type DockerComposeAction = "restart" | "stop" | "start" | "check-update" | "will-recreate";

// `check-update` pulls an image: well beyond the client's 5 s default, and
// still under the agent's own compose timeouts.
const DOCKER_ACTION_TIMEOUT_MS = 180_000;

export function resolveDockerServices(
  request: GitRequest,
  cwd: string,
): Promise<RemoteDockerServices> {
  return request(`/internal/docker-services?cwd=${encodeURIComponent(cwd)}`);
}

export function runDockerComposeAction<T>(
  request: GitRequest,
  cwd: string,
  service: Pick<ComposeService, "composeProject" | "service">,
  action: DockerComposeAction,
): Promise<T> {
  return request<T>(
    "/internal/docker-compose-action",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd,
        composeProject: service.composeProject,
        service: service.service,
        action,
      }),
    },
    DOCKER_ACTION_TIMEOUT_MS,
  );
}

/** The dev-server port announced by the first of `sessionIds` (agent-side
 * sessions, whose ids are the primary's session ids) that has one, or null. */
export function resolveDevServerPort(
  request: GitRequest,
  sessionIds: string[],
): Promise<{ port: string | null }> {
  return request(
    `/internal/dev-server-port?sessionIds=${encodeURIComponent(sessionIds.join(","))}`,
  );
}
