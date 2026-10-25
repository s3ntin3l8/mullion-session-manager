import { useRef, useState } from "react";
import { GridIcon } from "./ui/icons.js";
import { Modal } from "./ui/Modal.js";

interface CreateGroupModalProps {
  onClose: () => void;
  onCreate: (name: string, color: string) => Promise<unknown>;
  // Phase 4d: this same modal doubles as "Edit group" (kebab menu on a
  // group header), pre-filled with the group's current name/color.
  // `onCreate` still fires with (name, color) either way; the caller
  // decides create vs. update.
  mode?: "create" | "edit";
  initialName?: string;
  initialColor?: string;
}

// Ported 1:1 from the design's "New workspace group" modal
// (Cmux Redesign.dc.html) — triggered by the "+" inline with the sidebar's
// "Workspaces" section title, replacing the old NewGroupForm inline form.
// Confirmed via the design's own field shape (name + color, submit "Create
// group") that this modal maps onto this app's *Group* concept (color-coded
// container for workspaces), not the separate Workspace/layout concept the
// design doesn't model — see the plan's Phase 4c notes. Swatch order/colors
// ported verbatim; footer copy kept verbatim too ("Add sessions by dragging
// or via ⌘K" describes drag-add, which is out of scope here — ⌘K launch-
// into-a-workspace already works, drag choreography doesn't yet).
const SWATCHES: Array<{ color: string; title: string }> = [
  { color: "var(--b)", title: "Blue" },
  { color: "var(--p)", title: "Purple" },
  { color: "var(--g)", title: "Green" },
  { color: "var(--o)", title: "Orange" },
  { color: "var(--c)", title: "Cyan" },
  { color: "var(--y)", title: "Amber" },
];

export function CreateGroupModal({
  onClose,
  onCreate,
  mode = "create",
  initialName = "",
  initialColor,
}: CreateGroupModalProps) {
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState(initialColor ?? SWATCHES[0].color);
  const isEdit = mode === "edit";
  // The name field is the one control the user came here to fill in, so it
  // takes initial focus. The shared Modal's focus trap would otherwise land
  // on the close button, which precedes it in DOM order.
  //
  // Deliberately NOT `autoFocus`: React applies `autoFocus` during the
  // commit phase, which is BEFORE `useFocusTrap`'s effect captures
  // `document.activeElement` — so the hook would capture the input as
  // "what was focused before the dialog opened" and restore focus to a
  // detached node on close. `initialFocusRef` gives the same result without
  // breaking focus restoration.
  const nameRef = useRef<HTMLInputElement>(null);

  const confirm = () => {
    const finalName = name.trim() || "New group";
    void onCreate(finalName, color).then(onClose);
  };

  return (
    <Modal
      onClose={onClose}
      icon={<GridIcon size={16} />}
      title={isEdit ? "Edit workspace group" : "New workspace group"}
      subtitle={
        isEdit ? "Update this group's name or color." : "Group related sessions under one label."
      }
      initialFocusRef={nameRef}
      footer={
        <>
          <span className="create-modal-footer-hint">
            {isEdit
              ? "Member workspaces keep their current order."
              : "Add sessions by dragging or via ⌘K."}
          </span>
          <button className="create-modal-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="create-modal-submit" onClick={confirm}>
            {isEdit ? "Save changes" : "Create group"}
          </button>
        </>
      }
    >
      <label className="create-modal-field">
        <span className="create-modal-field-label">Workspace name</span>
        <span className="create-modal-input-row">
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Active PRs"
            onKeyDown={(e) => {
              if (e.key === "Enter") confirm();
            }}
          />
        </span>
      </label>

      <div className="create-modal-field">
        <span className="create-modal-field-label">Color</span>
        <div className="create-modal-swatches">
          {SWATCHES.map((s) => (
            <button
              key={s.color}
              type="button"
              className={`color-swatch${color === s.color ? " selected" : ""}`}
              style={{ background: s.color }}
              title={s.title}
              onClick={() => setColor(s.color)}
            />
          ))}
        </div>
      </div>
    </Modal>
  );
}
