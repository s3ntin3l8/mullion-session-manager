import {
  getComposeServices,
  inspectImageId,
  pullComposeImageQuietly,
  reconstructConfigHash,
  restartComposeService,
  startComposeService,
  stopComposeService,
  type ComposeService,
} from "./docker-service-detect.js";

// The synchronous, host-local Docker Compose operations on one discovered
// service. routes/project-docker.ts runs them for a local project; the agent's
// POST /internal/docker-compose-action (issue #3427) runs the same code for a
// remote one, so the two hosts cannot drift.

export type CheckUpdateResult =
  | { updateAvailable: false; reason: "build-only" | "pull-failed" }
  | {
      updateAvailable: boolean;
      currentImageId: string;
      latestImageId: string;
      imageRef: string;
      checkedAt: string;
    };

/** Pulls quietly and compares the new local image id with the running one. A
 * failed pull is `reason: "pull-failed"`, never an error ("can't check" is not
 * a server fault). */
export async function checkComposeUpdate(service: ComposeService): Promise<CheckUpdateResult> {
  if (!service.pullable) return { updateAvailable: false, reason: "build-only" };
  if (!(await pullComposeImageQuietly(service))) {
    return { updateAvailable: false, reason: "pull-failed" };
  }
  const latestImageId = await inspectImageId(service.imageRef);
  if (!latestImageId) return { updateAvailable: false, reason: "pull-failed" };
  return {
    updateAvailable: latestImageId !== service.imageId,
    currentImageId: service.imageId,
    latestImageId,
    imageRef: service.imageRef,
    checkedAt: new Date().toISOString(),
  };
}

/** Whether `up -d` would RECREATE the service's container; `null` = can't
 * tell. Advisory only. An empty recorded hash (a container predating the
 * label) is "can't tell", not "yes". */
export async function willRecreateOnApply(service: ComposeService): Promise<boolean | null> {
  if (service.configHash === "") return null;
  const currentHash = await reconstructConfigHash(service);
  if (currentHash === null) return null;
  return currentHash !== service.configHash;
}

export const SERVICE_LIFECYCLE_ACTIONS = {
  restart: restartComposeService,
  stop: stopComposeService,
  start: startComposeService,
} as const;

export type ServiceLifecycleAction = keyof typeof SERVICE_LIFECYCLE_ACTIONS;

/** Runs a per-service lifecycle action and, on success, refreshes the
 * discovery cache so the next poll sees the new state. */
export async function runServiceLifecycleAction(
  action: ServiceLifecycleAction,
  service: ComposeService,
): Promise<boolean> {
  const success = await SERVICE_LIFECYCLE_ACTIONS[action](service);
  if (success) await getComposeServices(true);
  return success;
}
