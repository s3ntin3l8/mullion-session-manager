// The workflow-change approval gate's payload (`tasks.workflowChange`, set by
// the backend's task-workflow-gate.ts while a push waits on the operator).

export interface WorkflowChange {
  sha: string;
  files: string[];
}

export function parseWorkflowChange(raw: string | null | undefined): WorkflowChange | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<WorkflowChange>;
    if (typeof v.sha === "string" && Array.isArray(v.files)) {
      return { sha: v.sha, files: v.files.filter((f): f is string => typeof f === "string") };
    }
  } catch {
    // a corrupt value reads as "nothing waiting"
  }
  return null;
}
