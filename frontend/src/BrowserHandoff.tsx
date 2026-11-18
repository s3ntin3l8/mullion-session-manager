// The Browser pane's ⇄ button (#3373, docs/design/one-browser-pane/note.md,
// "Open this address in the other one"): opens the current address in the
// other mode and switches to it. What it would open comes from
// hooks/useBrowserHandoff.ts; BrowserShell owns the switching.

export function HandoffButton({
  target,
  address,
  disabledReason,
  onClick,
}: {
  /** The mode ⇄ opens. */
  target: "agent" | "preview";
  /** What it opens, named in the tooltip. */
  address: string | null;
  disabledReason: string | null;
  onClick: () => void;
}) {
  const where = target === "agent" ? "the agent's browser" : "the preview";
  const title = disabledReason ?? `Open ${address ?? "this address"} in ${where}`;
  // aria-disabled, like the mode switch: a disabled button shows no tooltip,
  // and the tooltip is where the reason is.
  return (
    <button
      type="button"
      className="browser-panel-reload browser-handoff"
      aria-label={`Open in ${where}`}
      aria-disabled={disabledReason != null || undefined}
      title={title}
      onClick={() => {
        if (disabledReason == null) onClick();
      }}
    >
      ⇄
    </button>
  );
}
