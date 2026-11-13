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
export interface BlockingAlertsResponse {
  alerts: BlockingAlertEntry[];
}
