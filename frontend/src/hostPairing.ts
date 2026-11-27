import type { Host, HostPairingSummary } from "./api/index.js";

// Issue #2597 — GET /api/hosts reports `unclaimed: true` for a paired host whose
// agent never took delivery of its identity (retry window passed, credential
// never renewed, no channel ever connected). Absent from an older primary.
// Declared here rather than inline in api/types.ts, whose size ceiling is a
// ratchet (scripts/check-max-file-lines.mjs).
declare module "./api/types.js" {
  interface Host {
    unclaimed?: boolean;
  }
}

// Issue #2449 — the stages a pairing shows in the Hosts UI, kept
// distinct on purpose:
//   pending   — a code was issued and the agent has not redeemed it yet
//   paired    — the code was redeemed: the host has an identity and credential
//   connected — paired AND the primary can reach it (heartbeat says online)
// "Paired" is not "connected": while the outbound-channel rollout is incomplete
// a paired host can be perfectly valid yet unreachable from the primary.
//   unclaimed — paired, but the agent never took delivery (issue #2597): the
//               retry window passed with no credential renewal and no channel
//   expired   — the code expired before it was redeemed
//   revoked   — a cancelled code, or a host whose machine identity an operator
//               revoked; Re-pair re-arms the host row
export type PairingStage = "pending" | "paired" | "unclaimed" | "connected" | "expired" | "revoked";

export function derivePairingStage(
  pairing: Pick<HostPairingSummary, "state" | "host_id">,
  hosts: Pick<Host, "id" | "health" | "unclaimed" | "machineIdentityRevoked">[],
): PairingStage {
  if (pairing.state !== "paired") return pairing.state;
  const host = hosts.find((h) => h.id === pairing.host_id);
  if (host?.machineIdentityRevoked === true) return "revoked";
  if (host?.unclaimed) return "unclaimed";
  return host?.health === "online" ? "connected" : "paired";
}

export const PAIRING_STAGE_LABEL: Record<PairingStage, string> = {
  pending: "waiting for the agent",
  paired: "paired · not reachable yet",
  unclaimed: "Paired, never connected",
  connected: "connected",
  expired: "expired",
  revoked: "revoked",
};

export const HELPER_DOWNLOAD_URL = "https://github.com/s3ntin3l8/mullion-helper/releases/latest";
