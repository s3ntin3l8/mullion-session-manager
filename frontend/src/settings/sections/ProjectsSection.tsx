import { useEffect, useState } from "react";
import { useDashboardStore } from "../../store.js";
import { api } from "../../api.js";
import type { ServerInfo } from "../../api.js";
import { CloseIcon, FolderIcon, PlusIcon, RefreshIcon } from "../../icons.js";
import { GroupHeading, ListRow, Row, SecondaryButton, StyledList } from "../../ui/primitives.js";

export function ProjectsSection() {
  const { settings, updateSettings, projects } = useDashboardStore();
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [rescanStatus, setRescanStatus] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);

  useEffect(() => {
    api
      .getServerInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  const roots = settings.projectRoots;
  const [addingRoot, setAddingRoot] = useState(false);
  const [newRootPath, setNewRootPath] = useState("");

  const commitAddRoot = () => {
    const path = newRootPath.trim();
    if (path) updateSettings({ projectRoots: [...roots, path] });
    setNewRootPath("");
    setAddingRoot(false);
  };

  const removeRoot = (path: string) => {
    updateSettings({ projectRoots: roots.filter((r) => r !== path) });
  };

  const rescan = () => {
    setRescanning(true);
    api
      .discoverProjects()
      .then((found) =>
        setRescanStatus(`${found.length} project${found.length === 1 ? "" : "s"} found`),
      )
      .catch(() => setRescanStatus("Rescan failed"))
      .finally(() => setRescanning(false));
  };

  return (
    <>
      <GroupHeading title="Project roots" desc="Directories scanned for auto-discovery." />
      <StyledList>
        {roots.map((root) => (
          <ListRow
            key={root}
            icon={<FolderIcon size={15} />}
            title={
              <span style={{ fontFamily: "Geist Mono, monospace", fontSize: 12.5 }}>{root}</span>
            }
            trailing={
              <span
                onClick={() => removeRoot(root)}
                style={{ cursor: "pointer", display: "flex", color: "var(--dim)" }}
                title="Remove"
              >
                <CloseIcon size={14} />
              </span>
            }
          />
        ))}
        {roots.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--dim)", padding: "4px 2px" }}>
            No roots configured — falling back to the server's PROJECTS_ROOTS env default (
            {info?.projectsRoots || "empty"}).
          </div>
        )}
      </StyledList>
      <div style={{ marginTop: 7 }}>
        {addingRoot ? (
          <div className="settings-numberfield" style={{ width: "100%" }}>
            <input
              autoFocus
              style={{ flex: 1, textAlign: "left", width: "auto" }}
              placeholder="~/work"
              value={newRootPath}
              onChange={(e) => setNewRootPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitAddRoot();
                if (e.key === "Escape") {
                  setNewRootPath("");
                  setAddingRoot(false);
                }
              }}
              onBlur={commitAddRoot}
            />
          </div>
        ) : (
          <button className="settings-add-btn" onClick={() => setAddingRoot(true)}>
            <PlusIcon size={13} />
            Add a root directory
          </button>
        )}
      </div>

      <Row label="Discover now" desc="Re-scan roots for new git repositories.">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {rescanStatus && (
            <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{rescanStatus}</span>
          )}
          <SecondaryButton onClick={rescan} disabled={rescanning} icon={<RefreshIcon size={13} />}>
            Rescan
          </SecondaryButton>
        </div>
      </Row>

      <Row label="Global config directory" desc="Where global launchers & dock defaults live.">
        <span className="settings-readonly-value">{info?.crsConfigDir ?? "…"}</span>
      </Row>

      <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 10 }}>
        {projects.length} project{projects.length === 1 ? "" : "s"} registered in total.
      </div>
    </>
  );
}
