import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useDashboardStore } from "../store/index.js";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
import { CloseIcon } from "../ui/icons.js";

// Touch has no way to select text inside xterm's canvas/DOM renderer, so
// "Copy" (key bar) or a long-press on the terminal opens this: the buffer as
// plain text in a read-only textarea, where the platform's own selection
// handles and copy menu work. Scrolled to the bottom on open (the most
// recent output is almost always what's wanted), with a Copy-all shortcut.
export function CopyModeSheet({ text, onClose }: { text: string; onClose: () => void }) {
  const theme = useDashboardStore((s) => s.theme);
  const sheetRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pressedBackdropRef = useRef(false);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const { onKeyDown: onTrapKeyDown } = useFocusTrap({
    active: true,
    containerRef: sheetRef,
    initialFocusRef: textareaRef,
  });

  useEffect(() => {
    const el = textareaRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    onTrapKeyDown(e);
  };

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

  return createPortal(
    <div
      className={`cmux-root${theme === "light" ? " light" : ""} copy-mode-backdrop`}
      // Only a press AND release on the backdrop itself closes — a text
      // selection drag that ends outside the sheet must not.
      onPointerDown={(e) => {
        pressedBackdropRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (pressedBackdropRef.current && e.target === e.currentTarget) onClose();
        pressedBackdropRef.current = false;
      }}
    >
      <div
        ref={sheetRef}
        className="copy-mode-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Copy terminal text"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="copy-mode-header">
          <span>Select text to copy</span>
          <button className="mobile-tab-btn" aria-label="Close copy view" onClick={onClose}>
            <CloseIcon size={14} />
          </button>
        </div>
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
      </div>
    </div>,
    document.body,
  );
}
