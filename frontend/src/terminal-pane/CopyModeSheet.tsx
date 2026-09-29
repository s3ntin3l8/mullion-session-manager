import { useEffect, useRef, useState } from "react";
import { BottomSheet } from "../ui/BottomSheet.js";

// Touch has no way to select text inside xterm's canvas/DOM renderer, so
// "Copy" (key bar) or a long-press on the terminal opens this: the session's
// scrollback as plain text in a read-only textarea, where the platform's own
// selection handles and copy menu work. Scrolled to the bottom on open (the
// most recent output is almost always what's wanted), with a Copy-all
// shortcut.
//
// The textarea is fed `term.buffer.normal` by TerminalPane — the same buffer
// that holds the inline transcript + scrollback when the program is on the
// main screen, AND keeps holding that same transcript while the program has
// switched to the alternate screen. That's the load-bearing bit for the
// Codex-question-during-dialog use case: there's no other way to reach
// history that xterm has parked behind a TUI, because `term.buffer.active`
// is the dialog itself and xterm has no public API to display the normal
// buffer while the program owns the alternate one.
//
// Built on ui/BottomSheet.tsx (issue #1435) — this stays a fresh-mount-per-
// open component (its own call site conditionally mounts it, unlike
// BottomSheet's other three callers), so `open` is a literal `true` here,
// matching this component's own pre-extraction `useFocusTrap({active: true,
// ...})`.
export function CopyModeSheet({
  text,
  title,
  onClose,
}: {
  text: string;
  // `undefined` keeps the historical "Select text to copy" header — the
  // sheet predates the scrollback case and a normal-screen session still
  // opens it for the same reason (touch has no in-xterm selection), so
  // that's the right default to preserve.
  title?: string;
  onClose: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");

  useEffect(() => {
    const el = textareaRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const copyAll = () => {
    const write = navigator.clipboard?.writeText(text);
    if (!write) {
      setCopied("failed");
      return;
    }
    write.then(
      () => setCopied("done"),
      () => setCopied("failed"),
    );
  };

  return (
    <BottomSheet
      open={true}
      onClose={onClose}
      label="Copy terminal text"
      closeLabel="Close copy view"
      title={title ?? "Select text to copy"}
      backdropClassName="copy-mode-backdrop"
      sheetClassName="copy-mode-sheet"
      backdropClose="press-release"
      initialFocusRef={textareaRef}
    >
      <textarea
        ref={textareaRef}
        className="copy-mode-text"
        readOnly
        value={text}
        aria-label="Terminal text"
        spellCheck={false}
      />
      <div className="copy-mode-actions">
        <button className="copy-mode-btn" onClick={copyAll}>
          {copied === "done" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy all"}
        </button>
        <button className="copy-mode-btn" onClick={onClose}>
          Done
        </button>
      </div>
    </BottomSheet>
  );
}
