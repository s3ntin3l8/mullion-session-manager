import type { Host, PlacementPreview } from "../api/types.js";
import { LOCAL_HOST_ID } from "../../../src/shared/constants.js";

// Issue #2237 — the launcher's host target. The choice is one of:
//   - null    the project's own host (the DEFAULT: nothing is sent, so a
//             launch with no interaction is exactly what it was before)
//   - "auto"  the Auto placement policy, for this launch only
//   - a host id the project has a path on (`hostCwds`)
export type HostChoice = string | null;

export interface HostTargetOption {
  value: string;
  label: string;
  disabled: boolean;
}

/** The sentinel option value for the project's own host (the default). */
export const OWN_HOST_VALUE = "__own__";
export const AUTO_VALUE = "auto";

/** A host that cannot take a new session right now, and why (null = usable). */
function unavailableState(host: Host | undefined): string | null {
  if (!host) return null;
  if (host.drained) return "parked";
  if (host.health === "offline") return "offline";
  return null;
}

/**
 * The options for a project: its own host first (the default, "this server"
 * when it is local), each `hostCwds` host by name, then Auto. The project's
 * own host is never disabled — it is what the launcher does anyway.
 */
export function buildHostTargetOptions(
  project: { hostId: string; hostCwds?: Record<string, string> | null },
  hosts: readonly Host[],
): HostTargetOption[] {
  const byId = new Map(hosts.map((h) => [h.id, h]));
  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  const own = project.hostId;
  const options: HostTargetOption[] = [
    {
      value: OWN_HOST_VALUE,
      label: own === LOCAL_HOST_ID ? "this server" : nameOf(own),
      disabled: false,
    },
  ];
  for (const id of Object.keys(project.hostCwds ?? {})) {
    if (id === own) continue;
    const state = unavailableState(byId.get(id));
    options.push({
      value: id,
      label: state ? `${nameOf(id)} (${state})` : nameOf(id),
      disabled: state !== null,
    });
  }
  options.push({ value: AUTO_VALUE, label: "Auto", disabled: false });
  return options;
}

/**
 * Whether a remembered choice still means something for this project: Auto
 * always does; a host only while the project still has a path on it. Anything
 * else falls back to the default (null).
 */
export function resolveHostChoice(
  remembered: string | undefined,
  project: { hostId: string; hostCwds?: Record<string, string> | null },
): HostChoice {
  if (remembered === undefined || remembered === project.hostId) return null;
  if (remembered === AUTO_VALUE) return AUTO_VALUE;
  return Object.hasOwn(project.hostCwds ?? {}, remembered) ? remembered : null;
}

/** The "chosen host, reason, excluded" lines under the chip for Auto. */
export function describeAutoPreview(preview: PlacementPreview, hosts: readonly Host[]): string {
  const nameOf = (id: string) => hosts.find((h) => h.id === id)?.name ?? id;
  const lines = [`${nameOf(preview.hostId)}: ${preview.reason}`];
  if (preview.excluded.length > 0) {
    lines.push(
      `not considered: ${preview.excluded.map((e) => `${nameOf(e.hostId)} (${e.reason})`).join(", ")}`,
    );
  }
  return lines.join(" · ");
}
