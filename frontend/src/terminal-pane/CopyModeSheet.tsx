import { useEffect, useRef, useState } from "react";
import { BottomSheet } from "../ui/BottomSheet.js";

// Touch has no way to select text inside xterm's canvas/DOM renderer, so
// "Copy" (key bar) or a long-press on the terminal opens this: the buffer as
// plain text in a read-only textarea, where the platform's own selection
// handles and copy menu work. Scrolled to the bottom on open (the most
// recent output is almost always what's wanted), with a Copy-all shortcut.
// Built on ui/BottomSheet.tsx (issue #1435) — this stays a fresh-mount-per-
// open component (its own call site conditionally mounts it, unlike
// BottomSheet's other three callers), so `open` is a literal `true` here,
// matching this component's own pre-extraction `useFocusTrap({active: true,
// ...})`.
export function CopyModeSheet({ text, onClose }: { text: string; onClose: () => void }) {
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
      title="Select text to copy"
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
