import { useRef, useState } from "react";
import { FolderIcon, CloseIcon } from "./icons.js";

interface CreateProjectModalProps {
  onClose: () => void;
  onCreate: (name: string, cwd: string) => Promise<unknown>;
  // Phase 4d: this same modal doubles as "Edit project" (kebab menu on a
  // project row), pre-filled with the project's current name/cwd — a
  // project has no edit surface otherwise. `onCreate` still fires with
  // (name, cwd) either way; the caller decides create vs. update.
  mode?: "create" | "edit";
  initialName?: string;
  initialPath?: string;
}

// Ported 1:1 from the design's "Add project" modal (Cmux Redesign.dc.html):
// a top-anchored centered overlay (not the Settings modal's vertically-
// centered one), triggered by the "+" inline with the sidebar's "Projects"
// section title — replaces the old NewProjectForm inline form. Field
// semantics match the design's DCLogic exactly: `apPathInput` keeps the
// Display-name field's *placeholder* in sync with the path's trailing
// segment (never overwrites a real typed value); "Browse…" is the design's
// own stub (seeds ~/code/ and focuses) since a web app can't invoke a real
// OS folder picker without the user-gesture-gated File System Access API —
// this is a platform limitation, not an unported interaction.
export function CreateProjectModal({
  onClose,
  onCreate,
  mode = "create",
  initialName = "",
  initialPath = "",
}: CreateProjectModalProps) {
  const [path, setPath] = useState(initialPath);
  const [name, setName] = useState(initialName);
  const [namePlaceholder, setNamePlaceholder] = useState("my-project");
  const isEdit = mode === "edit";
  const pathInputRef = useRef<HTMLInputElement>(null);

  const trailingSegment = (p: string) => p.replace(/\/+$/, "").split("/").pop() || "my-project";

  const handlePathInput = (value: string) => {
    setPath(value);
    setNamePlaceholder(trailingSegment(value));
  };

  const browse = () => {
    if (!path) {
      handlePathInput("~/code/");
      pathInputRef.current?.focus();
    }
  };

  const confirm = () => {
    const trimmedPath = path.trim();
    if (!trimmedPath) {
      pathInputRef.current?.focus();
      return;
    }
    const finalName = name.trim() || trailingSegment(trimmedPath);
    void onCreate(finalName, trimmedPath).then(onClose);
  };

  return (
    <div className="create-modal-backdrop" onClick={onClose}>
      <div className="create-modal" onClick={(e) => e.stopPropagation()}>
        <div className="create-modal-header">
          <span className="create-modal-icon">
            <FolderIcon size={16} />
          </span>
          <span className="create-modal-header-text">
            <span className="create-modal-title">{isEdit ? "Edit project" : "Add project"}</span>
            <span className="create-modal-subtitle">
              {isEdit ? "Update this project's name or path." : "Point cmux at a local repository."}
            </span>
          </span>
          <button className="create-modal-close" onClick={onClose}>
            <CloseIcon size={15} />
          </button>
        </div>

        <div className="create-modal-body">
          <label className="create-modal-field">
            <span className="create-modal-field-label">Repository path</span>
            <span className="create-modal-input-row">
              <FolderIcon size={15} style={{ color: "var(--muted)", flexShrink: 0 }} />
              <input
                ref={pathInputRef}
                className="mono"
                value={path}
                onChange={(e) => handlePathInput(e.target.value)}
                placeholder="~/code/my-project"
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirm();
                }}
              />
              <button type="button" className="create-modal-browse-btn" onClick={browse}>
                Browse…
              </button>
            </span>
          </label>

          <label className="create-modal-field">
            <span className="create-modal-field-label">Display name</span>
            <span className="create-modal-input-row">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={namePlaceholder}
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirm();
                }}
              />
            </span>
            <span className="create-modal-field-hint">
              Defaults to the folder name if left blank.
            </span>
          </label>
        </div>

        <div className="create-modal-footer">
          <span className="create-modal-footer-hint">
            {isEdit
              ? "Already-open sessions keep their current directory until restarted."
              : "cmux will scan for launchers & tasks after adding."}
          </span>
          <button className="create-modal-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="create-modal-submit" onClick={confirm}>
            {isEdit ? "Save changes" : "Add project"}
          </button>
        </div>
      </div>
    </div>
  );
}
