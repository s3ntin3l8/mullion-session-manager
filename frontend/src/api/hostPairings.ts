// One-time execution-host pairing (issue #2449) — generate a `mullion://pair`
// link for the desktop Helper, list pairing codes and their state, and cancel
// a pending one. Mirrors src/routes/host-pairing.ts.
import { request } from "./client.js";
import type { HostPairingCreated, HostPairingSummary } from "../../../src/shared/types.js";
export type {
  HostPairingState,
  HostPairingCreated,
  HostPairingSummary,
} from "../../../src/shared/types.js";

export const hostPairingsApi = {
  createHostPairing: (opts: { label?: string; hostId?: string } = {}) =>
    request<HostPairingCreated>("/api/host-pairings", {
      method: "POST",
      body: JSON.stringify(opts),
    }),

  listHostPairings: () => request<HostPairingSummary[]>("/api/host-pairings"),

  cancelHostPairing: (id: string) =>
    request<void>(`/api/host-pairings/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
