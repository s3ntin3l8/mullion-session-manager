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
// Built on ui/BottomSheet.tsx (issue #1435). TerminalPane keeps it mounted
// and drives `open` (#3019), keeping the last text and title while it is
// closed, so the sheet leaves on the spring the way it came — a thrown
// drag-dismiss carries on out instead of stopping dead — with its content
// still in it. `open` defaults to true for a caller that mounts it per open.
export function CopyModeSheet({
  open = true,
  text,
  title,
  onClose,
}: {
  open?: boolean;
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
  // Each open starts afresh: a reopen (even one that catches the sheet while
  // it leaves) must not still say "Copied" from the last one. Adjusted during
  // render when `open` turns true, React's pattern for state derived from a
  // prop change.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setCopied("idle");
  }

  // Scrolled to the newest output on every open, not only the first mount.
  useEffect(() => {
    if (!open) return;
    const el = textareaRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open]);

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
      open={open}
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
