// One-time execution-host pairing (issue #2449) — generate a `mullion://pair`
// link for the desktop Helper, list pairing codes and their state, and cancel
// a pending one. Mirrors src/routes/host-pairing.ts.
import { request } from "./client.js";

// Issue #2449 — one-time execution-host pairing (src/routes/host-pairing.ts).
export type HostPairingState = "pending" | "paired" | "expired" | "revoked";

export interface HostPairingCreated {
  id: string;
  /** `mullion://pair?url=…&code=…` — the primary URL and one-time code only. */
  pairing_link: string;
  url: string;
  code: string;
  expires_at: string;
}

export interface HostPairingSummary {
  id: string;
  label: string | null;
  state: HostPairingState;
  expires_at: string;
  created_at: string;
  host_id: string | null;
}

export const hostPairingsApi = {
  createHostPairing: (label?: string) =>
    request<HostPairingCreated>("/api/host-pairings", {
      method: "POST",
      body: JSON.stringify(label ? { label } : {}),
    }),

  listHostPairings: () => request<HostPairingSummary[]>("/api/host-pairings"),

  cancelHostPairing: (id: string) =>
    request<void>(`/api/host-pairings/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
