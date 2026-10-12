// FileEditorPanel.tsx's backend surface: list a project directory, read one
// text file, write one text file (routes/project-files.ts). Paths are always
// project-relative; the backend contains them to the project root.
import { request } from "./client.js";
import type { ProjectDirListing, ProjectFileContent, ProjectFileWriteResult } from "./types.js";

function sessionQuery(sessionId: number | undefined): string {
  return sessionId === undefined ? "" : `&sessionId=${sessionId}`;
}

export const filesApi = {
  // Every call takes an optional trailing `sessionId`: the editor is then
  // rooted at that session's cwd (a worktree session's own checkout) instead
  // of the project's.
  listProjectFiles: (projectId: number, dirPath = "", sessionId?: number) =>
    request<ProjectDirListing>(
      `/api/projects/${projectId}/files?path=${encodeURIComponent(dirPath)}${sessionQuery(sessionId)}`,
    ),

  readProjectFile: (projectId: number, filePath: string, sessionId?: number) =>
    request<ProjectFileContent>(
      `/api/projects/${projectId}/file?path=${encodeURIComponent(filePath)}${sessionQuery(sessionId)}`,
    ),

  // `expectedMtimeMs` makes the write fail with 409 (code "conflict") if the
  // file changed on disk since it was loaded; `create` makes it fail with
  // 409 if the file already exists, and is the only way to create one.
  writeProjectFile: (
    projectId: number,
    filePath: string,
    content: string,
    opts: { expectedMtimeMs?: number; create?: boolean } = {},
    sessionId?: number,
  ) =>
    request<ProjectFileWriteResult>(`/api/projects/${projectId}/file`, {
      method: "PUT",
      body: JSON.stringify({ path: filePath, content, ...opts, sessionId }),
    }),
};
