// #2998 — `GET /api/tasks/:id/blocking-alerts` (src/services/code-scanning.ts).
export type BlockingAlertCanDismiss = { ok: true } | { ok: false; reason: string };
export interface BlockingAlertDetail {
  rule: {
    id: string;
    description: string;
    severity: string | null;
    securitySeverity: string | null;
  };
  location: { path: string; startLine: number; endLine: number } | null;
  message: string | null;
  commitSha: string | null;
  state: string;
  htmlUrl: string;
}
export interface BlockingAlertSnippetLine {
  number: number;
  text: string;
  flagged: boolean;
}
export interface BlockingAlertPriorDismissal {
  number: number;
  path: string | null;
  reason: string | null;
  comment: string | null;
  dismissedBy: string | null;
  url: string;
}
export type BlockingAlertEntry =
  | {
      number: number;
      alert: BlockingAlertDetail;
      snippet: BlockingAlertSnippetLine[] | null;
      priorDismissals: { dismissals: BlockingAlertPriorDismissal[]; otherPathCount: number } | null;
      canDismiss: BlockingAlertCanDismiss;
    }
  | { number: number; error: string; canDismiss: BlockingAlertCanDismiss };
// #2999 — one audit row: an alert a human dismissed from the task.
export type BlockingAlertDismissReason = "false positive" | "won't fix" | "used in tests";
export interface BlockingAlertDismissal {
  alertNumber: number;
  ruleId: string;
  path: string | null;
  reason: string;
  comment: string;
  dismissedBy: string | null;
  threadResolved: boolean;
  createdAt: string;
}
export interface BlockingAlertsResponse {
  alerts: BlockingAlertEntry[];
  dismissals: BlockingAlertDismissal[];
}
export interface DismissBlockingAlertResponse {
  dismissed: true;
  threadResolved: boolean;
  warning?: string;
  dismissal: BlockingAlertDismissal;
}
