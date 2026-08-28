// SSH-agent bridge registry (issue #820, PR7b/PR7c) — pairing, listing, and
// revoking a laptop/PC "helper" bridge. Split out the same way hosts.ts is:
// one file per backend route module.
import { request } from "./client.js";
import type { BridgePairingResponse, BridgeSummary } from "./types.js";

export const bridgesApi = {
  listBridges: () => request<BridgeSummary[]>("/api/bridges"),

  pairBridge: () => request<BridgePairingResponse>("/api/bridges", { method: "POST" }),

  revokeBridge: (id: string) =>
    request<void>(`/api/bridges/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
