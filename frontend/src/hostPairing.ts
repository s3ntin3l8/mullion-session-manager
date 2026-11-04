import type { Host, HostPairingSummary } from "./api/index.js";

// Issue #2449 — the three states a pairing shows in the Hosts UI, kept
// distinct on purpose:
//   pending   — a code was issued and the Helper has not redeemed it yet
//   paired    — the code was redeemed: the host has an identity and credential
//   connected — paired AND the primary can reach it (heartbeat says online)
// "Paired" is not "connected": while the outbound-channel rollout is incomplete
// a paired host can be perfectly valid yet unreachable from the primary.
export type PairingStage = "pending" | "paired" | "connected" | "expired" | "revoked";

export function derivePairingStage(
  pairing: Pick<HostPairingSummary, "state" | "host_id">,
  hosts: Pick<Host, "id" | "health">[],
): PairingStage {
  if (pairing.state !== "paired") return pairing.state;
  const host = hosts.find((h) => h.id === pairing.host_id);
  return host?.health === "online" ? "connected" : "paired";
}

export const PAIRING_STAGE_LABEL: Record<PairingStage, string> = {
  pending: "waiting for the Helper",
  paired: "paired · not reachable yet",
  connected: "connected",
  expired: "expired",
  revoked: "cancelled",
};

export const HELPER_DOWNLOAD_URL = "https://github.com/s3ntin3l8/mullion-helper/releases/latest";
