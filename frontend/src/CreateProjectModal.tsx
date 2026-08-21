import { useRef, useState } from "react";
import { FolderIcon, CloseIcon, GlobeIcon, HostsIcon, BotIcon } from "./ui/icons.js";
import { api, ApiError, LOCAL_HOST_ID, normalizeAgentId } from "./api/index.js";
import type { Host, Launcher } from "./api/index.js";
import { useAsyncData } from "./hooks/useAsyncData.js";
import { useDashboardStore } from "./store/index.js";
import { Dropdown } from "./ui/primitives.js";

// Empty string represents "unset" (fall through to the next precedence
// tier) in the Dropdown below, which is string-only — converted to/from
// `null` at the CreateProjectModal boundary.
const UNSET_AGENT = "";

// The one 400 `code` (see project-dir.ts / projects.ts) that unlocks the
// "Create folder" affordance below — every other code (parent missing, path
// is a file, symlink, permission denied, remote-host-unsupported) is a dead
// end shown as plain error text, deliberately: offering to build a
// directory tree for a typo'd path is exactly what leaf-only creation is
// meant to prevent.
const CREATE_DIR_CODE = "PROJECT_DIR_MISSING";

interface CreateProjectModalProps {
  onClose: () => void;
  // `hostId` is only ever passed to `onCreate` in "create" mode (see the
  // host selector below) — a project's host can't change after creation
  // (issue #26: cwd is host-specific), so "edit" callers ignore it.
  // `devServerUrl` is the reverse: only ever meaningful in "edit" mode (see
  // the field below) — `null` clears a previously-set value, `undefined`
  // (create mode) means "not applicable, ignore this argument".
  //
  // A single options object rather than positional params: `createDir`/
  // `gitInit` (confirm-first directory creation) made an already-six-deep
  // positional list untenable.
  onCreate: (values: {
    name: string;
    cwd: string;
    hostId?: string;
    devServerUrl?: string | null;
    // Phase 6 Task Master (6.5/#218) — agent-selection precedence tiers 2
    // (defaultAgent) and the review agent's only tier (defaultReviewAgent).
    // Edit mode only, same "not applicable in create mode" framing as
    // devServerUrl above.
    defaultAgent?: string | null;
    defaultReviewAgent?: string | null;
    // Merge-on-approve / auto-approve — per-project only, no install-wide
    // tier, same edit-mode-only framing as the two fields above. `null`/
    // `false` both mean off; the modal always sends a plain boolean.
    mergeOnApprove?: boolean | null;
    autoApprove?: boolean | null;
    // #756 — per-project override of the auto-return round cap. `null`
    // means "use the install default" — the modal sends `null` when the
    // field is left blank, never `0` (the API rejects a cap below 1).
    maxAutoReturnRounds?: number | null;
    // Confirm-first directory creation — only ever sent once the user has
    // clicked "Create folder" below, in response to a PROJECT_DIR_MISSING
    // rejection. `gitInit` only has an effect when `createDir` is also set.
    createDir?: boolean;
    gitInit?: boolean;
  }) => Promise<{ dirCreated?: boolean; gitInitialized?: boolean } | undefined>;
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
  initialMergeOnApprove?: boolean | null;
  initialAutoApprove?: boolean | null;
  initialMaxAutoReturnRounds?: number | null;
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
  initialMergeOnApprove = null,
  initialAutoApprove = null,
  initialMaxAutoReturnRounds = null,
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
  const [mergeOnApprove, setMergeOnApprove] = useState(initialMergeOnApprove ?? false);
  const [autoApprove, setAutoApprove] = useState(initialAutoApprove ?? false);
  // String state, not number — an empty field means "use the install
  // default" (sent as `null`, never `0`/NaN), and a controlled number
  // input can't natively represent "no value typed yet" the way a string
  // one can.
  const [maxAutoReturnRounds, setMaxAutoReturnRounds] = useState(
    initialMaxAutoReturnRounds !== null ? String(initialMaxAutoReturnRounds) : "",
  );
  const [agentLaunchers, setAgentLaunchers] = useState<Launcher[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  // Only rendered inside the PROJECT_DIR_MISSING confirm block below — it's
  // the only moment it has any effect, and a permanently-visible checkbox
  // that usually does nothing invites "why didn't it init?" reports.
  const [gitInit, setGitInit] = useState(false);
  // Distinct from `error`: the project WAS created successfully, but the
  // git-init the user asked for as part of that failed — a non-blocking
  // notice, not a rejected submit.
  const [gitInitFailed, setGitInitFailed] = useState(false);
  // Hermes review, PR #477 — a failed fetch used to leave both dropdowns
  // silently showing only "Use global default"/"None" with no indication
  // anything went wrong, and (independently) a saved defaultAgent that
  // wasn't among the currently-detected launchers had no matching <option>
  // at all — the <select> would then display its first option while state
  // still held the real, different value, misleading the user into thinking
  // "Use global default" was already selected.
  const [launchersLoadError, setLaunchersLoadError] = useState(false);
  const [launchersRetryToken, setLaunchersRetryToken] = useState(0);
  const isEdit = mode === "edit";
  const pathInputRef = useRef<HTMLInputElement>(null);
  const remoteHosts = hosts.filter((h) => h.id !== LOCAL_HOST_ID);
  // #741 — the install-wide review-agent default this project's own unset
  // option falls through to (TaskMasterSection's Default review agent),
  // shown in the "Use global default (…)" label below.
  const globalDefaultReviewAgent =
    useDashboardStore((s) => s.settings?.taskMaster?.defaultReviewAgent) || "none";

  useAsyncData(
    () => {
      // Guarded by `enabled` below — `projectId` is always defined here.
      if (projectId === undefined) return Promise.reject(new Error("unreachable: no projectId"));
      return api.listProjectActions(projectId);
    },
    (launchers) => setAgentLaunchers(launchers.filter((l) => l.kind === "agent")),
    () => setLaunchersLoadError(true),
    [isEdit, projectId, launchersRetryToken],
    {
      enabled: isEdit && projectId !== undefined,
      // Clears a stale error from a previous fetch/retry before this one
      // resolves — same "reset then fetch" shape as SkillsPanel.tsx's own
      // fetchSkills effect.
      onStart: () => setLaunchersLoadError(false),
    },
  );

  // Deduped by the bare agent name (KNOWN_AGENTS-shaped) — a project can
  // define its own launcher with the same underlying binary as a detected
  // one (e.g. a custom .crs/actions.json override), and defaultAgent stores
  // only the bare name, not a launcher id.
  const agentOptions = Array.from(
    new Map(agentLaunchers.map((l) => [normalizeAgentId(l.id), l.title])).entries(),
  ).map(([value, label]) => ({ value, label }));

  // Ensures the <select>'s current value always has a matching <option> —
  // otherwise a saved value the fetch above didn't happen to return (a
  // detection miss, a load failure, or an agent since uninstalled) makes the
  // browser silently fall back to displaying the first option while state
  // still holds the real value underneath.
  function optionsWithCurrentValue(
    options: { value: string; label: string }[],
    current: string,
  ): { value: string; label: string }[] {
    if (current === UNSET_AGENT || options.some((o) => o.value === current)) return options;
    return [...options, { value: current, label: `${current} (not detected)` }];
  }

  const trailingSegment = (p: string) => p.replace(/\/+$/, "").split("/").pop() || "my-project";

  const handlePathInput = (value: string) => {
    setPath(value);
    setNamePlaceholder(trailingSegment(value));
    // A stale "Create folder" affordance (or git-init-failed notice) must
    // never apply to a newly typed path.
    setError(null);
    setGitInitFailed(false);
    setGitInit(false);
  };

  const browse = () => {
    if (!path) {
      handlePathInput(initialPath || "~/code/");
      pathInputRef.current?.focus();
    }
  };

  const confirm = async (opts?: { createDir?: boolean }) => {
    if (submitting) return;
    const trimmedPath = path.trim();
    if (!trimmedPath) {
      pathInputRef.current?.focus();
      return;
    }
    const finalName = name.trim() || trailingSegment(trimmedPath);
    const trimmedDevServerUrl = devServerUrl.trim();
    setSubmitting(true);
    setError(null);
    try {
      const result = await onCreate({
        name: finalName,
        cwd: trimmedPath,
        hostId: isEdit ? undefined : hostId,
        devServerUrl: isEdit
          ? trimmedDevServerUrl === ""
            ? null
            : trimmedDevServerUrl
          : undefined,
        defaultAgent: isEdit ? (defaultAgent === UNSET_AGENT ? null : defaultAgent) : undefined,
        defaultReviewAgent: isEdit
          ? defaultReviewAgent === UNSET_AGENT
            ? null
            : defaultReviewAgent
          : undefined,
        mergeOnApprove: isEdit ? mergeOnApprove : undefined,
        autoApprove: isEdit ? autoApprove : undefined,
        maxAutoReturnRounds: isEdit
          ? maxAutoReturnRounds.trim() === ""
            ? null
            : Number(maxAutoReturnRounds)
          : undefined,
        ...(opts?.createDir ? { createDir: true, gitInit } : {}),
      });
      // `gitInitialized: false` alone is ambiguous — it also means "never
      // attempted" (the directory already existed, e.g. a concurrent
      // create between the initial 400 and this retry, so the backend
      // skips git init entirely). `dirCreated` disambiguates: git init only
      // ever runs when this request actually created the directory, so
      // `dirCreated && gitInitialized === false` is specifically "attempted
      // and failed".
      if (opts?.createDir && gitInit && result?.dirCreated && result.gitInitialized === false) {
        setSubmitting(false);
        setGitInitFailed(true);
        return;
      }
      // Reset before onClose rather than relying on the parent to unmount
      // this component synchronously — it usually does, but nothing here
      // should depend on that to avoid a stuck disabled button.
      setSubmitting(false);
      onClose();
    } catch (err) {
      setSubmitting(false);
      setError({
        message: err instanceof ApiError ? err.message : "Could not add project",
        code: err instanceof ApiError ? err.code : undefined,
      });
    }
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
                  if (e.key === "Enter") void confirm();
                }}
              />
              <button type="button" className="create-modal-browse-btn" onClick={browse}>
                Browse…
              </button>
            </span>
          </label>

          {error && (
            <div className="create-modal-dir-confirm">
              <span className="create-modal-field-hint error">{error.message}</span>
              {error.code === CREATE_DIR_CODE && (
                <>
                  <label className="create-modal-dir-confirm-checkbox">
                    <input
                      type="checkbox"
                      checked={gitInit}
                      onChange={(e) => setGitInit(e.target.checked)}
                    />
                    Initialize a git repository
                  </label>
                  <button
                    type="button"
                    className="create-modal-dir-confirm-btn"
                    disabled={submitting}
                    onClick={() => void confirm({ createDir: true })}
                  >
                    Create folder and add project
                  </button>
                </>
              )}
            </div>
          )}

          {gitInitFailed && (
            <span className="create-modal-field-hint error">
              {isEdit ? "Project updated" : "Project added"}, but `git init` failed — you can
              initialize it manually later.
            </span>
          )}

          <label className="create-modal-field">
            <span className="create-modal-field-label">Display name</span>
            <span className="create-modal-input-row">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={namePlaceholder}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void confirm();
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
                    if (e.key === "Enter") void confirm();
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
                  options={optionsWithCurrentValue(
                    [{ value: UNSET_AGENT, label: "Use global default" }, ...agentOptions],
                    defaultAgent,
                  )}
                />
              </span>
              <span className="create-modal-field-hint">
                Which agent Phase 6 task claims spawn for this project, overriding the global
                default.
              </span>
              {launchersLoadError && (
                <span className="create-modal-field-hint error">
                  Couldn't load this project's detected agents — only the currently configured value
                  is shown.{" "}
                  <button
                    type="button"
                    className="create-modal-detected-devserver"
                    onClick={() => setLaunchersRetryToken((t) => t + 1)}
                  >
                    Retry
                  </button>
                </span>
              )}
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
                  options={optionsWithCurrentValue(
                    [
                      {
                        value: UNSET_AGENT,
                        label: `Use global default (${globalDefaultReviewAgent})`,
                      },
                      ...agentOptions,
                    ],
                    defaultReviewAgent,
                  )}
                />
              </span>
              <span className="create-modal-field-hint">
                Optional advisory agent that reviews a task's diff once its worker's turn ends.
              </span>
            </label>
          )}

          {isEdit && (
            <label className="create-modal-field">
              <span className="create-modal-field-label">Merge on approve</span>
              <label className="create-modal-dir-confirm-checkbox">
                <input
                  type="checkbox"
                  checked={mergeOnApprove}
                  onChange={(e) => setMergeOnApprove(e.target.checked)}
                />
                Merge a task's PR automatically once it's approved
              </label>
              <span className="create-modal-field-hint">
                Approving a task requests a merge; it lands once GitHub's checks are green and the
                branch is up to date. Off by default — approving still just opens the PR otherwise.
              </span>
            </label>
          )}

          {isEdit && (
            <label className="create-modal-field">
              <span className="create-modal-field-label">Auto-approve</span>
              <label className="create-modal-dir-confirm-checkbox">
                <input
                  type="checkbox"
                  checked={autoApprove}
                  onChange={(e) => setAutoApprove(e.target.checked)}
                />
                Approve a task automatically on a clean review and green CI
              </label>
              <span className="create-modal-field-hint">
                Needs a review agent configured above — no review agent means no verdict, so a task
                never auto-approves. Combined with merge on approve, a task can go from claimed to
                merged with no human click.
              </span>
            </label>
          )}

          {isEdit && (
            <label className="create-modal-field">
              <span className="create-modal-field-label">Max automatic rounds</span>
              <input
                type="number"
                min={1}
                placeholder="2 (install default)"
                value={maxAutoReturnRounds}
                onChange={(e) => setMaxAutoReturnRounds(e.target.value)}
              />
              <span className="create-modal-field-hint">
                How many times a task may be sent back to its worker automatically — a
                changes-requested review, a red required CI check, or an unresolved PR comment.
                Blank uses the install default (currently 2).
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
          {gitInitFailed ? (
            <button className="create-modal-submit" onClick={onClose}>
              Close
            </button>
          ) : (
            <>
              <button className="create-modal-cancel" disabled={submitting} onClick={onClose}>
                Cancel
              </button>
              <button
                className="create-modal-submit"
                disabled={submitting}
                onClick={() => void confirm()}
              >
                {submitting
                  ? isEdit
                    ? "Saving…"
                    : "Adding…"
                  : isEdit
                    ? "Save changes"
                    : "Add project"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
