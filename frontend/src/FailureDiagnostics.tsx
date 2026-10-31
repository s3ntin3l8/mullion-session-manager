/** Collapsible snapshot captured when the no-commits gate failed a task. */
export function FailureDiagnostics({ text }: { text: string }) {
  return (
    <details className="task-detail-failure-diagnostics">
      <summary>Failure diagnostics</summary>
      <pre>{text}</pre>
    </details>
  );
}
