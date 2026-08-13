// Toast-notification overlays for TerminalPane — "Copied" (Ctrl+Insert /
// copy-on-select / OSC 52) and the image-upload state (issue #68). Extracted
// verbatim from TerminalPane.tsx (PR 35, Wave 6 of
// .claude/plans/can-we-do-a-warm-cocke.md); this component is pure render —
// the state itself (`copied`/`copyToastKey`/`uploadState`) stays owned by
// TerminalPane, since it's set from inside the mount effect's closures
// (copyToClipboard, uploadAndInjectImage), which stays intact and untouched
// (see that file's own comment on why).
export interface TerminalToastsProps {
  copied: boolean;
  // Bumped on every successful copy so the "Copied" toast remounts (via this
  // key) instead of reusing the same DOM node — see TerminalPane.tsx's own
  // comment on why `copied` alone can't do this (a second copy while the
  // first toast is still showing is a true->true no-op React skips, so the
  // CSS fade animation wouldn't restart).
  copyToastKey: number;
  uploadState: "idle" | "uploading" | "error";
}

export function TerminalToasts({ copied, copyToastKey, uploadState }: TerminalToastsProps) {
  return (
    <>
      {copied && (
        <div key={copyToastKey} className="terminal-copy-indicator">
          Copied
        </div>
      )}
      {uploadState !== "idle" && (
        <div className={`terminal-upload-indicator ${uploadState === "error" ? "error" : ""}`}>
          {uploadState === "uploading" ? "Uploading image…" : "Image upload failed"}
        </div>
      )}
    </>
  );
}
