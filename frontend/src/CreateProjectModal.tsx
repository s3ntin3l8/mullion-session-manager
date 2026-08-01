import { useEffect, useRef, useState } from "react";
import { FolderIcon, CloseIcon, GlobeIcon, HostsIcon, BotIcon } from "./icons.js";
import { api, LOCAL_HOST_ID, normalizeAgentId } from "./api.js";
import type { Host, Launcher } from "./api.js";
import { Dropdown } from "./settings/primitives.js";

// Empty string represents "unset" (fall through to the next precedence
// tier) in the Dropdown below, which is string-only — converted to/from
// `null` at the CreateProjectModal boundary.
const UNSET_AGENT = "";

interface CreateProjectModalProps {
  onClose: () => void;
  // `hostId` is only ever passed to `onCreate` in "create" mode (see the
  // host selector below) — a project's host can't change after creation
  // (issue #26: cwd is host-specific), so "edit" callers ignore it.
  // `devServerUrl` is the reverse: only ever meaningful in "edit" mode (see
  // the field below) — `null` clears a previously-set value, `undefined`
  // (create mode) means "not applicable, ignore this argument".
  onCreate: (
    name: string,
    cwd: string,
    hostId?: string,
    devServerUrl?: string | null,
    // Phase 6 Task Master (6.5/#218) — agent-selection precedence tiers 2
    // (defaultAgent) and the review agent's only tier (defaultReviewAgent).
    // Edit mode only, same "not applicable in create mode" framing as
    // devServerUrl above.
    defaultAgent?: string | null,
    defaultReviewAgent?: string | null,
  ) => Promise<unknown>;
  // Phase 4d: this same modal doubles as "Edit project" (kebab menu on a
  // project row), pre-filled with the project's current name/cwd — a
  // project has no edit surface otherwise. `onCreate` still fires with
  // (name, cwd) either way; the caller decides create vs. update.
  mode?: "create" | "edit";
  initialName?: string;
  initialPath?: string;
  // Issue #28 — pre-fills the dev-server field, edit mode only (a brand-new
  // project has nothing running yet to point this at).
  initialDevServerUrl?: string | null;
  // Issue #28 phase 7 — a port the backend spotted in a running dock
  // session's own startup banner. Only ever offered as a one-click
  // suggestion (see the button below); never written into `devServerUrl`
  // without the user clicking it, even when this prop changes underneath
  // an already-open modal.
  detectedDevServerPort?: string | null;
  // Registered hosts (issue #26) — the selector only renders in "create"
  // mode, and only once a remote host actually exists, so a single-host
  // deployment sees no extra UI at all.
  hosts?: Host[];
  // Phase 6 Task Master (6.5/#218) — edit mode only. `projectId` is needed
  // to fetch this project's own detected agent launchers for the two
  // dropdowns below; a brand-new project has no launchers detected yet.
  projectId?: number;
  initialDefaultAgent?: string | null;
  initialDefaultReviewAgent?: string | null;
}

// Ported 1:1 from the design's "Add project" modal (Cmux Redesign.dc.html):
// a top-anchored centered overlay (not the Settings modal's vertically-
// centered one), triggered by the "+" inline with the sidebar's "Projects"
// section title — replaces the old NewProjectForm inline form. Field
// semantics match the design's DCLogic exactly: `apPathInput` keeps the
// Display-name field's *placeholder* in sync with the path's trailing
// segment (never overwrites a real typed value); "Browse…" is the design's
// own stub (seeds the sidebar's default project root and focuses) since a
// web app can't invoke a real OS folder picker without the user-gesture-
// gated File System Access API — this is a platform limitation, not an
// unported interaction.
export function CreateProjectModal({
  onClose,
  onCreate,
  mode = "create",
  initialName = "",
  initialPath = "",
  initialDevServerUrl = null,
  detectedDevServerPort = null,
  hosts = [],
  projectId,
  initialDefaultAgent = null,
  initialDefaultReviewAgent = null,
}: CreateProjectModalProps) {
  const [path, setPath] = useState(initialPath);
  const [name, setName] = useState(initialName);
  const [namePlaceholder, setNamePlaceholder] = useState("my-project");
  const [hostId, setHostId] = useState(LOCAL_HOST_ID);
  const [devServerUrl, setDevServerUrl] = useState(initialDevServerUrl ?? "");
  const [defaultAgent, setDefaultAgent] = useState(initialDefaultAgent ?? UNSET_AGENT);
  const [defaultReviewAgent, setDefaultReviewAgent] = useState(
    initialDefaultReviewAgent ?? UNSET_AGENT,
  );
  const [agentLaunchers, setAgentLaunchers] = useState<Launcher[]>([]);
  const isEdit = mode === "edit";
  const pathInputRef = useRef<HTMLInputElement>(null);
  const remoteHosts = hosts.filter((h) => h.id !== LOCAL_HOST_ID);

  useEffect(() => {
    if (!isEdit || projectId === undefined) return;
    let cancelled = false;
    void api
      .listProjectActions(projectId)
      .then((launchers) => {
        if (!cancelled) setAgentLaunchers(launchers.filter((l) => l.kind === "agent"));
      })
      .catch(() => {
        // Best-effort — the two dropdowns just show only "Use global
        // default"/"None" if this fails, same as an install with no
        // detected agents at all.
      });
    return () => {
      cancelled = true;
    };
  }, [isEdit, projectId]);

  // Deduped by the bare agent name (KNOWN_AGENTS-shaped) — a project can
  // define its own launcher with the same underlying binary as a detected
  // one (e.g. a custom .crs/actions.json override), and defaultAgent stores
  // only the bare name, not a launcher id.
  const agentOptions = Array.from(
    new Map(agentLaunchers.map((l) => [normalizeAgentId(l.id), l.title])).entries(),
  ).map(([value, label]) => ({ value, label }));

  const trailingSegment = (p: string) => p.replace(/\/+$/, "").split("/").pop() || "my-project";

  const handlePathInput = (value: string) => {
    setPath(value);
    setNamePlaceholder(trailingSegment(value));
  };

  const browse = () => {
    if (!path) {
      handlePathInput(initialPath || "~/code/");
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
    const trimmedDevServerUrl = devServerUrl.trim();
    void onCreate(
      finalName,
      trimmedPath,
      isEdit ? undefined : hostId,
      isEdit ? (trimmedDevServerUrl === "" ? null : trimmedDevServerUrl) : undefined,
      isEdit ? (defaultAgent === UNSET_AGENT ? null : defaultAgent) : undefined,
      isEdit ? (defaultReviewAgent === UNSET_AGENT ? null : defaultReviewAgent) : undefined,
    ).then(onClose);
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
              {isEdit
                ? "Update this project's name or path."
                : "Point Mullion at a local repository."}
            </span>
          </span>
          <button className="create-modal-close" onClick={onClose}>
            <CloseIcon size={15} />
          </button>
        </div>

        <div className="create-modal-body">
          {!isEdit && remoteHosts.length > 0 && (
            <label className="create-modal-field">
              <span className="create-modal-field-label">Host</span>
              <span className="create-modal-input-row">
                <HostsIcon size={15} style={{ color: "var(--muted)", flexShrink: 0 }} />
                <Dropdown
                  value={hostId}
                  onChange={setHostId}
                  options={[
                    { value: LOCAL_HOST_ID, label: "This machine" },
                    ...remoteHosts.map((h) => ({ value: h.id, label: h.name })),
                  ]}
                />
              </span>
              <span className="create-modal-field-hint">
                The path below is resolved on the selected host, not this browser's machine.
              </span>
            </label>
          )}

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

          {isEdit && (
            <label className="create-modal-field">
              <span className="create-modal-field-label">Dev server</span>
              <span className="create-modal-input-row">
                <GlobeIcon size={15} style={{ color: "var(--muted)", flexShrink: 0 }} />
                <input
                  className="mono"
                  value={devServerUrl}
                  onChange={(e) => setDevServerUrl(e.target.value)}
                  placeholder="5173"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") confirm();
                  }}
                />
              </span>
              <span className="create-modal-field-hint">
                Port or full URL — powers the browser preview pane. Leave blank to clear.
              </span>
              {/* Derived at render time, not stored in state — a pure
                  comparison of two already-tracked values needs no effect,
                  and re-deriving on every render is what keeps this in sync
                  if `detectedDevServerPort` changes while the modal's open
                  (e.g. the dock session finishes starting up) without ever
                  touching `devServerUrl` itself. */}
              {detectedDevServerPort !== null &&
                detectedDevServerPort.trim() !== devServerUrl.trim() && (
                  <button
                    type="button"
                    className="create-modal-detected-devserver"
                    onClick={() => setDevServerUrl(detectedDevServerPort)}
                  >
                    Detected dev server on port {detectedDevServerPort} — use it?
                  </button>
                )}
            </label>
          )}

          {isEdit && (
            <label className="create-modal-field">
              <span className="create-modal-field-label">Default agent</span>
              <span className="create-modal-input-row">
                <BotIcon size={15} style={{ color: "var(--muted)", flexShrink: 0 }} />
                <Dropdown
                  value={defaultAgent}
                  onChange={setDefaultAgent}
                  options={[{ value: UNSET_AGENT, label: "Use global default" }, ...agentOptions]}
                />
              </span>
              <span className="create-modal-field-hint">
                Which agent Phase 6 task claims spawn for this project, overriding the global
                default.
              </span>
            </label>
          )}

          {isEdit && (
            <label className="create-modal-field">
              <span className="create-modal-field-label">Default review agent</span>
              <span className="create-modal-input-row">
                <BotIcon size={15} style={{ color: "var(--muted)", flexShrink: 0 }} />
                <Dropdown
                  value={defaultReviewAgent}
                  onChange={setDefaultReviewAgent}
                  options={[{ value: UNSET_AGENT, label: "None" }, ...agentOptions]}
                />
              </span>
              <span className="create-modal-field-hint">
                Optional advisory agent that reviews a task's diff once its worker's turn ends.
              </span>
            </label>
          )}
        </div>

        <div className="create-modal-footer">
          <span className="create-modal-footer-hint">
            {isEdit
              ? "Already-open sessions keep their current directory until restarted."
              : "Mullion will scan for launchers & tasks after adding."}
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
