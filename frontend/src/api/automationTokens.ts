import { request } from "./client.js";
import type { AutomationTokenCreated, AutomationTokenSummary } from "../../../src/shared/types.js";

export type {
  AutomationTokenCreated,
  AutomationTokenState,
  AutomationTokenSummary,
} from "../../../src/shared/types.js";

export interface CreateAutomationTokenOpts {
  label: string;
  scopes: ("enroll" | "repair")[];
  expiresInDays?: number;
  allowedCidrs?: string | null;
  requireApproval?: boolean;
}

export const automationTokensApi = {
  createAutomationToken: (opts: CreateAutomationTokenOpts) =>
    request<AutomationTokenCreated>("/api/automation-tokens", {
      method: "POST",
      body: JSON.stringify(opts),
    }),

  listAutomationTokens: () => request<AutomationTokenSummary[]>("/api/automation-tokens"),

  revokeAutomationToken: (id: string) =>
    request<void>(`/api/automation-tokens/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
