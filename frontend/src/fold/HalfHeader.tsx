import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Half } from "../lib/foldHalves.js";
import { CloseIcon } from "../ui/icons.js";

export interface HalfHeaderProps {
  side: Half;
  title: string;
  projectName: string | null;
  /** Moves the pane to the other half; null hides the button (the pane
   *  cannot move, e.g. a non-terminal pane, or it is the left's only one). */
  onMove: (() => void) | null;
  /** Right half only: closes the right half (the session keeps running). */
  onClose?: () => void;
  focused: boolean;
  /** The pane's menu (rename, close the pane, end the session …). Given the
   *  function that starts renaming in place, as the phone picker does. */
  renderActions?: (startRename: () => void) => ReactNode;
  onRenameCommit?: (title: string) => void;
}

// The one header each half shows between 800 and 1099px (#3010), in place of
// dockview's tab strip, which is hidden there: the pane's title and project,
// the button that moves it to the other half (design frame 2d), and the
// pane's menu, which is how a pane is closed or renamed here.
export function HalfHeader({
  side,
  title,
  projectName,
  onMove,
  onClose,
  focused,
  renderActions,
  onRenameCommit,
}: HalfHeaderProps) {
  const other = side === "left" ? "right" : "left";
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!renaming) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [renaming]);
  const startRename = () => {
    setDraft(title);
    setRenaming(true);
  };
  const commit = () => {
    setRenaming(false);
    const value = draft.trim();
    if (value && value !== title) onRenameCommit?.(value);
  };
  return (
    <div className={`half-header${focused ? " focused" : ""}`} data-half={side}>
      {renaming ? (
        <input
          ref={inputRef}
          className="half-header-rename"
          aria-label="Pane name"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setRenaming(false);
          }}
        />
      ) : (
        <span
          className="half-header-title"
          title={projectName ? `${title} — ${projectName}` : title}
        >
          {title}
          {projectName && <span className="half-header-project"> · {projectName}</span>}
        </span>
      )}
      {onMove && (
        <button
          type="button"
          className="half-header-btn"
          onClick={onMove}
          aria-label={`Move to the ${other} half`}
          title={`Move to the ${other} half`}
        >
          {side === "left" ? "To right ⇥" : "⇤ To left"}
        </button>
      )}
      {renderActions?.(startRename)}
      {onClose && (
        <button
          type="button"
          className="half-header-btn half-header-close"
          onClick={onClose}
          aria-label="Close the right half"
          title="Close the right half (the session keeps running)"
        >
          <CloseIcon size={13} />
        </button>
      )}
    </div>
  );
}
