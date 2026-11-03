import type { Host, PlacementConstraints, PlacementPreview } from "../api/types.js";
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
  // Never registered: the server refuses a target it has not seen online.
  if (host.health === "pending") return "pending";
  return null;
}

/**
 * Issue #2241 — why the project's platform flag rules a host out, or null. A
 * host that has not reported a platform is left selectable: the server decides.
 */
function platformFlagViolation(
  host: Host | undefined,
  constraints: PlacementConstraints | undefined,
): string | null {
  const allowed = constraints?.platform ?? [];
  const reported = host?.platform?.toLowerCase();
  if (allowed.length === 0 || !reported) return null;
  return allowed.some((p) => p === reported)
    ? null
    : `project allows only ${allowed.join(" or ")} hosts`;
}

/**
 * Issue #2306 — why a required capability rules a host out, or null. Only a
 * host KNOWN to lack one counts: a host that has not reported its capabilities
 * (null/absent) is left selectable, the server decides. Unlike the platform
 * flag, this applies to a pinned project's explicit target too.
 */
function capabilityFlagViolation(
  host: Host | undefined,
  constraints: PlacementConstraints | undefined,
): string | null {
  const lacking = (constraints?.capabilities ?? []).find((c) => !host?.capabilities?.includes(c));
  if (!host?.capabilities || lacking === undefined) return null;
  return `host lacks capability: ${lacking}`;
}

/**
 * The options for a project: its own host first (the default, "this server"
 * when it is local), each `hostCwds` host by name, then Auto. The project's
 * own host is never disabled — it is what the launcher does anyway.
 */
export function buildHostTargetOptions(
  project: {
    hostId: string;
    placement?: string;
    hostCwds?: Record<string, string> | null;
    placementConstraints?: PlacementConstraints;
  },
  hosts: readonly Host[],
): HostTargetOption[] {
  const byId = new Map(hosts.map((h) => [h.id, h]));
  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  const own = project.hostId;
  // The own host is what the launcher does anyway on a pinned project (no
  // target is sent, so the flags do not apply); on an auto project choosing it
  // is an explicit target, which the server checks against the flags.
  const ownViolation =
    project.placement === "auto"
      ? (platformFlagViolation(byId.get(own), project.placementConstraints) ??
        capabilityFlagViolation(byId.get(own), project.placementConstraints))
      : null;
  const ownLabel = own === LOCAL_HOST_ID ? "this server" : nameOf(own);
  const options: HostTargetOption[] = [
    {
      value: OWN_HOST_VALUE,
      label: ownViolation ? `${ownLabel} (${ownViolation})` : ownLabel,
      disabled: ownViolation !== null,
    },
  ];
  for (const id of Object.keys(project.hostCwds ?? {})) {
    if (id === own) continue;
    const state =
      unavailableState(byId.get(id)) ??
      platformFlagViolation(byId.get(id), project.placementConstraints) ??
      capabilityFlagViolation(byId.get(id), project.placementConstraints);
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
 * The effective choice for a project. Nothing remembered means the project's
 * own host for a pinned project, but Auto for a project stored as `auto`: the
 * server applies the stored mode to a launch that names nothing, so the chip
 * must say so rather than claim "this server". Picking the own host of an auto
 * project is remembered as that host id and sent as an explicit target.
 *
 * A remembered "auto" is ignored for a pinned project (the configured host
 * stays the default; Auto is opt-in per launch).
 *
 * A remembered choice that no longer means anything falls back to that default:
 * a host the project has left, or one that is now offline/parked.
 */
export function resolveHostChoice(
  remembered: string | undefined,
  project: {
    hostId: string;
    placement?: string;
    hostCwds?: Record<string, string> | null;
    placementConstraints?: PlacementConstraints;
  },
  hosts: readonly Host[] = [],
  inSession = false,
): HostChoice {
  const fallback: HostChoice = project.placement === "auto" ? AUTO_VALUE : null;
  if (remembered === undefined) return fallback;
  // Auto is honoured only for a project that is itself `auto` (where it is the
  // fallback). On a pinned project it is a per-launch opt-in: it lives in the
  // launcher's memory for this open session, so it is passed as `inSession`.
  if (remembered === AUTO_VALUE)
    return project.placement === "auto" || inSession ? AUTO_VALUE : fallback;
  if (remembered === project.hostId) return project.placement === "auto" ? remembered : null;
  if (!Object.hasOwn(project.hostCwds ?? {}, remembered)) return fallback;
  const host = hosts.find((h) => h.id === remembered);
  // Issue #2241 — a host the project's platform flag now forbids is as gone as an offline one.
  const usable =
    unavailableState(host) === null &&
    platformFlagViolation(host, project.placementConstraints) === null &&
    capabilityFlagViolation(host, project.placementConstraints) === null;
  return usable ? remembered : fallback;
}

/** The remembered map after picking `value` for `project`: the pinned project's own host is the default, so it is forgotten. */
export function rememberHostChoice(
  map: Record<string, string>,
  project: { id: number; hostId: string; placement?: string },
  value: string,
): Record<string, string> {
  const next = { ...map };
  const own = value === OWN_HOST_VALUE;
  if (own && project.placement !== "auto") delete next[String(project.id)];
  else next[String(project.id)] = own ? project.hostId : value;
  return next;
}

/** Drop Auto from a persisted map: Auto is never replayed across launcher sessions. */
export function withoutAutoChoices(map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).filter(([, v]) => v !== AUTO_VALUE));
}

/** The "chosen host, reason, excluded" lines under the chip for Auto. */
export function describeAutoPreview(preview: PlacementPreview, hosts: readonly Host[]): string {
  const nameOf = (id: string) => hosts.find((h) => h.id === id)?.name ?? id;
  // A refused Auto has no host to name: `hostId` is only the pinned fallback.
  const lines = [
    preview.refusal
      ? `Auto cannot place this: ${preview.reason}`
      : `${nameOf(preview.hostId)}: ${preview.reason}`,
  ];
  if (preview.excluded.length > 0) {
    lines.push(
      `not considered: ${preview.excluded.map((e) => `${nameOf(e.hostId)} (${e.reason})`).join(", ")}`,
    );
  }
  return lines.join(" · ");
}
