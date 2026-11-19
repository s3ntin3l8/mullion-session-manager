// Issue #1954 — a task can say WHERE it has to run.
//
// Two optional directives in the issue body, next to `Agent:` / `Model:`:
//
//   Platform: darwin     any eligible host of that platform
//   Host: <host id>      exactly that host
//   Capability: a,b      the host must have these capabilities (xcode, android-emulator)
//
// Both may be given ("that host, and it must be a Mac"). The requirement is
// a HARD one, unlike the usual placement: see `dispatchClaimedTask`, which
// refuses the claim, with a recorded reason, when no eligible host matches,
// instead of falling back to the project's own host.
//
// Same matching rules as the other directives (`task-agent-resolve.ts`,
// `task-model-resolve.ts`): the key is matched case-insensitively, at the
// start of a line, and the value is a single token — so an `Agent:`-looking
// phrase in prose does not count. The first occurrence wins.

import type { PlacementTarget } from "./placement.js";
import { PLACEMENT_CAPABILITIES } from "../shared/constants.js";
import { stripFencedCode } from "./issue-body-directives.js";

const PLATFORM_LINE_RE = /^\s*Platform:\s*(\S+)\s*$/im;
const CAPABILITY_LINE_RE = /^\s*Capability:\s*(\S+)\s*$/im;
const HOST_LINE_RE = /^\s*Host:\s*(\S+)\s*$/im;

function directive(body: string | null, re: RegExp): string | null {
  if (body === null) return null;
  const match = re.exec(stripFencedCode(body));
  return match ? match[1] : null;
}

/**
 * The placement requirement an issue body carries, or null when it carries
 * none (placement then behaves exactly as it always did).
 *
 * The platform is lower-cased so `Platform: Darwin` and `Platform: darwin`
 * mean the same thing; a host id is an opaque identifier and is kept as typed.
 * The value is not checked against a list of known platforms: a typo
 * (`Platform: mac`) simply matches no host, and the claim is refused naming it.
 */
export function parsePlacementRequirement(body: string | null): PlacementTarget | null {
  const platform = directive(body, PLATFORM_LINE_RE)?.toLowerCase() ?? null;
  const hostId = directive(body, HOST_LINE_RE);
  const capabilityNames = (directive(body, CAPABILITY_LINE_RE)?.toLowerCase() ?? "")
    .split(",")
    .filter((name) => name !== "");
  const capabilities = PLACEMENT_CAPABILITIES.filter((c) => capabilityNames.includes(c));
  const unknownCapabilities = [
    ...new Set(
      capabilityNames.filter(
        (name) => !(PLACEMENT_CAPABILITIES as readonly string[]).includes(name),
      ),
    ),
  ];
  const capabilityPart = {
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...(unknownCapabilities.length > 0 ? { unknownCapabilities } : {}),
  };
  const hasCapability = capabilities.length > 0 || unknownCapabilities.length > 0;
  if (hostId !== null) {
    return { hostId, ...(platform === null ? {} : { platform }), ...capabilityPart };
  }
  if (platform !== null) return { platform, ...capabilityPart };
  return hasCapability ? { ...capabilityPart } : null;
}

/** The requirement as stored on the task (`tasks.placementRequirement`). */
export function serializePlacementRequirement(target: PlacementTarget | null): string | null {
  return target === null ? null : JSON.stringify(target);
}

/**
 * Which issue-body line(s) a requirement came from, for a refusal's reason:
 * `Host:` is an everyday word (an HTTP example, `Host: localhost`), so a task
 * refused for a requirement its author never meant has to be able to see
 * where it came from.
 */
export function describeRequirementSource(target: PlacementTarget): string {
  const lines: string[] = [];
  if (target.hostId !== undefined) lines.push("`Host:`");
  if (target.platform !== undefined) lines.push("`Platform:`");
  if (target.capabilities !== undefined || target.unknownCapabilities !== undefined) {
    lines.push("`Capability:`");
  }
  return `the ${lines.join(" and ")} line${lines.length > 1 ? "s" : ""} in its issue body`;
}
