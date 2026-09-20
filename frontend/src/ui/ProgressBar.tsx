// Indeterminate progress bar with animated CSS stripes. Used for long-running
// SDK operations (system image install/uninstall, license acceptance) where
// no percentage is available from the underlying tool.
//
// Renders a thin bar with moving diagonal stripes — immediately signals
// "something is happening" without implying a completion percentage.

export function ProgressBar({ className }: { className?: string }) {
  return (
    <div className={className ? `ui-progress-bar ${className}` : "ui-progress-bar"}>
      <div className="ui-progress-bar-indeterminate" />
    </div>
  );
}
