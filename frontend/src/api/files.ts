// FileEditorPanel.tsx's backend surface: list a project directory, read one
// text file, write one text file (routes/project-files.ts). Paths are always
// project-relative; the backend contains them to the project root.
import { request } from "./client.js";
import type { ProjectDirListing, ProjectFileContent, ProjectFileWriteResult } from "./types.js";

export const filesApi = {
  listProjectFiles: (projectId: number, dirPath = "") =>
    request<ProjectDirListing>(
      `/api/projects/${projectId}/files?path=${encodeURIComponent(dirPath)}`,
    ),

  readProjectFile: (projectId: number, filePath: string) =>
    request<ProjectFileContent>(
      `/api/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`,
    ),

  // `expectedMtimeMs` makes the write fail with 409 (code "conflict") if the
  // file changed on disk since it was loaded; `create` makes it fail with
  // 409 if the file already exists, and is the only way to create one.
  writeProjectFile: (
    projectId: number,
    filePath: string,
    content: string,
    opts: { expectedMtimeMs?: number; create?: boolean } = {},
  ) =>
    request<ProjectFileWriteResult>(`/api/projects/${projectId}/file`, {
      method: "PUT",
      body: JSON.stringify({ path: filePath, content, ...opts }),
    }),
};
