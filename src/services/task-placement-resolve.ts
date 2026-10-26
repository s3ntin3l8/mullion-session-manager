// Issue #1954 — a task can say WHERE it has to run.
//
// Two optional directives in the issue body, next to `Agent:` / `Model:`:
//
//   Platform: darwin     any eligible host of that platform
//   Host: <host id>      exactly that host
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

const PLATFORM_LINE_RE = /^\s*Platform:\s*(\S+)\s*$/im;
const HOST_LINE_RE = /^\s*Host:\s*(\S+)\s*$/im;

function directive(body: string | null, re: RegExp): string | null {
  if (body === null) return null;
  const match = re.exec(body);
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
  if (hostId !== null) return platform === null ? { hostId } : { hostId, platform };
  if (platform !== null) return { platform };
  return null;
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
  if (!("hostId" in target)) return "the `Platform:` line in its issue body";
  return target.platform === undefined
    ? "the `Host:` line in its issue body"
    : "the `Host:` and `Platform:` lines in its issue body";
}
