import { useRef, useState } from "react";
import { TextInput } from "./primitives.js";

// The in-place rename field for a workspace or a group: Enter commits,
// Escape cancels, clicking away commits a changed name. Used by the
// sidebar's switcher and the rail's workspace picker (#3048).
export function InlineRenameInput({
  name,
  onCommit,
  onDone,
  ariaLabel,
}: {
  name: string;
  onCommit: (name: string) => void;
  // Leaves rename mode, after a commit or a cancel.
  onDone: () => void;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(name);
  // Unmounting the focused input (onDone) fires a native blur before this
  // render's closure sees the new state — so without this guard, Enter's
  // commit would double-fire via onBlur's own "still differs" check, and
  // Escape's onBlur would see the typed text and commit the very rename the
  // user just cancelled. Both keydown branches arm it so onBlur only ever
  // runs for an actual click-away.
  const suppressBlurRef = useRef(false);
  return (
    <TextInput
      small
      autoFocus
      className="workspace-rename-input"
      aria-label={ariaLabel}
      value={draft}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          // The field unmounts and focus can land on a button (the picker's
          // actions); without this the same keypress would also click it.
          e.preventDefault();
          suppressBlurRef.current = true;
          if (draft.trim()) onCommit(draft.trim());
          onDone();
        } else if (e.key === "Escape") {
          // Cancels the rename only, not whatever popover or sheet holds it.
          e.stopPropagation();
          suppressBlurRef.current = true;
          onDone();
        }
      }}
      onBlur={() => {
        if (!suppressBlurRef.current && draft.trim() && draft !== name) {
          onCommit(draft.trim());
        }
        onDone();
      }}
    />
  );
}
