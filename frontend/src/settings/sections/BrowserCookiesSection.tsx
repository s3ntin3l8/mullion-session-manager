import { useEffect, useState } from "react";
import { useDashboardStore } from "../../store/index.js";
import { api, ApiError } from "../../api/index.js";
import type { BrowserCookieProfile } from "../../api/index.js";
import {
  Dropdown,
  GroupHeading,
  ListRow,
  Row,
  SecondaryButton,
  StyledList,
} from "../../ui/primitives.js";
import { ErrorText } from "../../ui/ErrorText.js";

// Phase 3, issue #184 — lets an operator import cookies from a host Chrome
// or Firefox profile so a project's pooled browser (see browser-manager.ts)
// launches already signed in. Per-project: a project's browser pane is one
// pooled Chromium instance, so cookies apply at that scope, not per-session.
export function BrowserCookiesSection() {
  const { projects } = useDashboardStore();
  const [projectId, setProjectId] = useState<number | null>(projects[0]?.id ?? null);
  const [profiles, setProfiles] = useState<BrowserCookieProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [browserType, setBrowserType] = useState<"chrome" | "firefox">("chrome");
  const [importMethod, setImportMethod] = useState<"path" | "upload">("path");
  const [profilePath, setProfilePath] = useState("");
  const [fileBase64, setFileBase64] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [label, setLabel] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (projectId == null) return;
    api
      .listBrowserCookieProfiles(projectId)
      .then(setProfiles)
      .catch(() => setProfiles([]))
      .finally(() => setLoading(false));
  }, [projectId]);

  // Only for re-fetching after a user action (project switch, import,
  // delete) — unlike the mount/switch effect above, it's fine for this to
  // set `loading` synchronously since it's always called from an event
  // handler, never from inside an effect.
  const refresh = (id: number) => {
    setLoading(true);
    api
      .listBrowserCookieProfiles(id)
      .then(setProfiles)
      .catch(() => setProfiles([]))
      .finally(() => setLoading(false));
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // Strip the "data:<mime>;base64," prefix to get raw base64
      const base64 = dataUrl.split(",", 2)[1] ?? "";
      setFileBase64(base64);
    };
    reader.readAsDataURL(file);
  };

  const doImport = () => {
    if (projectId == null) return;
    const lbl = label.trim();
    if (!lbl) return;
    setError(null);
    setImporting(true);

    if (importMethod === "path") {
      const path = profilePath.trim();
      if (!path) {
        setImporting(false);
        return;
      }
      api
        .importBrowserCookieProfile(projectId, {
          browser: browserType,
          profilePath: path,
          label: lbl,
        })
        .then(() => {
          setProfilePath("");
          setLabel("");
          refresh(projectId);
        })
        .catch((err: unknown) => {
          setError(err instanceof ApiError ? err.message : "Could not import cookies");
        })
        .finally(() => setImporting(false));
    } else {
      if (!fileBase64) {
        setImporting(false);
        return;
      }
      api
        .uploadBrowserCookieProfile(projectId, {
          browser: browserType,
          fileBase64,
          label: lbl,
        })
        .then(() => {
          setFileBase64(null);
          setFileName("");
          setLabel("");
          refresh(projectId);
        })
        .catch((err: unknown) => {
          setError(err instanceof ApiError ? err.message : "Could not import cookies");
        })
        .finally(() => setImporting(false));
    }
  };

  const doDelete = (id: number) => {
    if (projectId == null) return;
    setError(null);
    void api
      .deleteBrowserCookieProfile(projectId, id)
      .then(() => setProfiles((prev) => prev.filter((p) => p.id !== id)))
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Could not delete cookie profile");
      });
  };

  return (
    <>
      <GroupHeading
        title="Import Browser Cookies"
        desc="Import cookies from a host Chrome or Firefox profile so a project's browser pane launches already signed in."
      />

      <Row label="Project">
        <Dropdown
          options={projects.map((p) => ({ value: String(p.id), label: p.name }))}
          value={projectId != null ? String(projectId) : ""}
          onChange={(v) => setProjectId(Number(v))}
        />
      </Row>

      {projectId != null && (
        <>
          <StyledList>
            {loading ? (
              <ListRow title="Loading…" />
            ) : profiles.length === 0 ? (
              <ListRow title="No cookie profiles imported yet" />
            ) : (
              profiles.map((profile) => (
                <ListRow
                  key={profile.id}
                  testId={`browser-cookie-profile-${profile.id}`}
                  title={profile.label}
                  subtitle={`${profile.browser} · ${profile.cookieCount} cookie${profile.cookieCount === 1 ? "" : "s"}`}
                  trailing={
                    <SecondaryButton onClick={() => doDelete(profile.id)}>Delete</SecondaryButton>
                  }
                />
              ))
            )}
          </StyledList>

          <div style={{ marginTop: 10 }}>
            <Row label="Browser">
              <Dropdown
                options={[
                  { value: "chrome", label: "Chrome" },
                  { value: "firefox", label: "Firefox" },
                ]}
                value={browserType}
                onChange={setBrowserType}
              />
            </Row>
            <Row label="Import source">
              <Dropdown
                options={[
                  { value: "path", label: "Filesystem path" },
                  { value: "upload", label: "File upload" },
                ]}
                value={importMethod}
                onChange={(v) => setImportMethod(v as "path" | "upload")}
              />
            </Row>
            {importMethod === "path" ? (
              <Row
                label="Cookies file path"
                desc="Path on this host to the browser profile's Cookies (Chrome) or cookies.sqlite (Firefox) file."
                align="start"
              >
                <div className="settings-numberfield" style={{ width: 260 }}>
                  <input
                    style={{ flex: 1, textAlign: "left", width: "auto" }}
                    placeholder="~/.config/google-chrome/Default/Cookies"
                    value={profilePath}
                    onChange={(e) => setProfilePath(e.target.value)}
                  />
                </div>
              </Row>
            ) : (
              <Row
                label="Upload cookies file"
                desc="Select the Cookies (Chrome) or cookies.sqlite (Firefox) file to upload."
                align="start"
              >
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <input
                    id="cookie-file-upload"
                    type="file"
                    style={{ display: "none" }}
                    onChange={handleFileChange}
                  />
                  <SecondaryButton
                    onClick={() => document.getElementById("cookie-file-upload")?.click()}
                  >
                    Choose file…
                  </SecondaryButton>
                  {fileName && <span style={{ fontSize: 12, color: "var(--fg)" }}>{fileName}</span>}
                </div>
              </Row>
            )}
            <Row label="Label">
              <div className="settings-numberfield" style={{ width: 260 }}>
                <input
                  style={{ flex: 1, textAlign: "left", width: "auto" }}
                  placeholder="work"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") doImport();
                  }}
                />
              </div>
            </Row>
            <div style={{ marginTop: 8 }}>
              <SecondaryButton
                onClick={doImport}
                disabled={
                  importing ||
                  (importMethod === "path" ? !profilePath.trim() : !fileBase64) ||
                  !label.trim()
                }
              >
                {importing ? "Importing…" : "Import"}
              </SecondaryButton>
            </div>
          </div>

          {error && <ErrorText style={{ marginTop: 8 }}>{error}</ErrorText>}
        </>
      )}
    </>
  );
}
