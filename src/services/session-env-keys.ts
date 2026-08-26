// Issue #822 — the reserved-key predicate shared by dock-config.ts's write
// path (throws on a reserved key) and project-config.ts's read path (drops
// one leniently). One function, not two independently-maintained lists: a
// key reserved here is unconditionally reserved, regardless of whether
// MULLION_SSH_AUTH_SOCK happens to be configured on the host resolving this
// config — a dock control is per-project and may be read on a host with
// different config than the one that will eventually launch it.
//
// Not enforced in launch-plan.ts's buildLaunchPlan: by the time env reaches
// there, it's meant to already be clean — this is the one gate, applied at
// the point a dock config is written or read, not scattered across every
// producer of a session's env.
const VALID_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isReservedSessionEnvKey(key: string): boolean {
  if (key.length === 0) return true;
  if (!VALID_ENV_KEY_PATTERN.test(key)) return true;
  if (key.startsWith("MULLION_")) return true;
  // SSH_AUTH_SOCK (issue #819) — the one non-MULLION_-prefixed var Mullion's
  // own launch-plan.ts conditionally injects. Reserved unconditionally, not
  // just when MULLION_SSH_AUTH_SOCK happens to be configured — see this
  // module's own header comment.
  if (key === "SSH_AUTH_SOCK") return true;
  return false;
}
