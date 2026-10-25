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
  // A copy attempt that didn't land — clipboard API unavailable (a
  // non-secure-context deploy) or the browser rejected the write. Previously
  // silent (console.warn only); see TerminalPane.tsx's own comment on
  // copyFailedMessage for why that made a clobbered/rejected copy
  // undiagnosable from the UI. Holds the message text itself (Hermes
  // review) so the two situations read as distinct ("Clipboard unavailable"
  // vs. "Copy failed") rather than one undifferentiated failure; null means
  // no toast. Same remount-key shape as copyToastKey, same reason.
  copyFailedMessage: string | null;
  copyFailedToastKey: number;
  uploadState: "idle" | "uploading" | "error";
  // Informational note about a drop (cap hit / entries skipped); null = none.
  uploadNotice?: string | null;
  // Issue: small panes/floating windows ignoring input — true for as long as
  // this pane's viewport is smaller than the pty's applied grid (pty-
  // manager.ts's MIN_TERMINAL_COLS/ROWS floor), per TerminalPane's own
  // GeometryMessage handler. Unlike `copied`/`uploadState` above this is a
  // standing condition, not a one-shot event — it stays up for as long as
  // the mismatch does, rather than auto-dismissing on a timer.
  paneTooSmall: boolean;
  // Voice dictation error message (see voice/support.ts's voiceErrorMessage),
  // or null/undefined when there is none to show. Optional — this component
  // predates dictation and every other caller (e.g. Dock.tsx's terminal, if
  // any exists without voice wired up) shouldn't need to pass it. Unlike
  // uploadState === "error" below (whose auto-dismiss timer lives in
  // TerminalPane), this one's auto-dismiss lives inside
  // useVoiceDictation.ts itself (setErrorWithTimer) — the hook owns the
  // error's whole lifecycle, including clearing it early on the next
  // press(), so TerminalPane needs no timer of its own; this component
  // only renders whatever it's given, same as every other prop here.
  voiceError?: string | null;
}

export function TerminalToasts({
  copied,
  copyToastKey,
  copyFailedMessage,
  copyFailedToastKey,
  uploadState,
  uploadNotice,
  paneTooSmall,
  voiceError,
}: TerminalToastsProps) {
  return (
    // The live region.
    //
    // These toasts were previously silent to assistive technology: "Copied"
    // after a clipboard write, "Upload failed", a rejected copy, a voice
    // error — none of them were announced, so a screen-reader user had no
    // idea the copy had landed or failed.
    //
    // The wrapper has to be PERMANENT rather than the toast elements
    // carrying `role="status"` themselves: a live region only announces
    // content that CHANGES inside it, so a region inserted into the DOM
    // together with its content is not reliably announced. This element is
    // always mounted, and the toasts come and go inside it.
    //
    // `role="status"` implies `aria-live="polite"`; the error variants
    // below carry `role="alert"` (assertive) so a failure interrupts
    // rather than waiting for a pause.
    <div className="terminal-toasts" role="status" aria-live="polite">
      {copied && (
        <div key={copyToastKey} className="terminal-copy-indicator">
          Copied
        </div>
      )}
      {copyFailedMessage && (
        <div key={copyFailedToastKey} className="terminal-copy-indicator error" role="alert">
          {copyFailedMessage}
        </div>
      )}
      {uploadState !== "idle" && (
        <div
          className={`terminal-upload-indicator ${uploadState === "error" ? "error" : ""}`}
          role={uploadState === "error" ? "alert" : undefined}
        >
          {uploadState === "uploading" ? "Uploading…" : "Upload failed"}
        </div>
      )}
      {uploadNotice && <div className="terminal-upload-indicator notice">{uploadNotice}</div>}
      {voiceError && (
        <div
          className={`terminal-upload-indicator error${
            uploadState !== "idle" || uploadNotice ? " stacked" : ""
          }`}
          role="alert"
        >
          {voiceError}
        </div>
      )}
      {paneTooSmall && (
        <div
          className="terminal-too-small-indicator"
          title="Enlarge this pane to use it normally"
          role="alert"
        >
          Pane too small
        </div>
      )}
    </div>
  );
}
