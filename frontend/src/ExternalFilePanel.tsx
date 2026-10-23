import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api/index.js";
import type { ProjectFileContent } from "./api/index.js";
import { CodeEditor } from "./components/CodeEditor.js";
import { FileTextIcon } from "./ui/icons.js";
import { EmptyStateNote } from "./ui/EmptyState.js";

export interface ExternalFilePanelParams {
  projectId: number;
  /** Absolute or `~/` path to open on mount; empty shows just the path bar. */
  path?: string;
  /** 1-based line to scroll to (terminal `file:line` links). */
  line?: number;
  /** Bumped when an already-open panel is re-targeted at the same path, so
   * the new `line` is revealed again. */
  rev?: number;
}

function noteFor(err: unknown, path: string): string {
  if (!(err instanceof ApiError)) return `Couldn't open ${path}`;
  switch (err.code) {
    case "not_allowlisted":
      return `${path} isn't in a readable folder. Add its folder under Settings → Projects & discovery → Readable paths to open it.`;
    case "too_large":
      return `${path} is over the 1 MiB limit — too large to view here.`;
    case "binary":
      return `${path} isn't a UTF-8 text file — it can't be viewed here.`;
    default:
      return err.message;
  }
}

// Read-only viewer for a file outside the project (an agent's plan under
// ~/.claude/plans, ...). Reads go through GET /api/projects/:id/external-file,
// whose Settings allowlist is the only gate; there is no save path. The path
// bar lets you paste a path a TUI wrapped across lines (so it never became a
// single terminal link).
export function ExternalFilePanel({ params }: { params: ExternalFilePanelParams }) {
  const { projectId } = params;
  const [input, setInput] = useState(params.path ?? "");
  const [file, setFile] = useState<ProjectFileContent | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const openSeq = useRef(0);

  const open = useCallback(
    async (rawPath: string) => {
      // A TUI box hard-wraps a long path across rows; pasting it brings the
      // line breaks (and indentation) along.
      const path = rawPath.replace(/\s+/g, "");
      if (!path) return;
      const seq = ++openSeq.current;
      try {
        const loaded = await api.readExternalFile(projectId, path);
        if (seq !== openSeq.current) return;
        setNote(null);
        setFile({ ...loaded, path });
      } catch (err) {
        if (seq !== openSeq.current) return;
        setFile(null);
        setNote(noteFor(err, path));
      }
    },
    [projectId],
  );

  useEffect(() => {
    void (async () => {
      if (params.path) await open(params.path);
    })();
  }, [open, params.path]);

  // Scroll target for a terminal `file:line` link — only for the file that
  // link named (params.path), and memoized so typing in the path bar doesn't
  // re-fire CodeEditor's reveal (its scroll effect is keyed on this object).
  const revealLine = useMemo(
    () =>
      params.line && file?.path === params.path
        ? { line: params.line, token: params.rev ?? 0 }
        : undefined,
    [params.line, params.rev, params.path, file?.path],
  );

  return (
    <div className="agent-rules-panel external-file-panel">
      <div className="agent-rules-panel-editor file-editor-main">
        <form
          className="agent-rules-panel-editor-header"
          onSubmit={(e) => {
            e.preventDefault();
            void open(input);
          }}
        >
          <input
            className="file-editor-new-input"
            style={{ flex: 1 }}
            autoFocus={!params.path}
            value={input}
            placeholder="~/.claude/plans/plan.md"
            aria-label="File path"
            spellCheck={false}
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit" className="git-panel-fetch-btn" disabled={!input.trim()}>
            Open
          </button>
          <span className="agent-rules-panel-row-meta">read-only</span>
        </form>
        {file ? (
          <CodeEditor
            key={file.path}
            value={file.content}
            fileName={file.path}
            readOnly
            revealLine={revealLine}
            ariaLabel={`Viewing ${file.path}`}
          />
        ) : (
          <EmptyStateNote>
            <FileTextIcon size={20} />
            <div>{note ?? "Paste the path of a file to view it."}</div>
          </EmptyStateNote>
        )}
      </div>
    </div>
  );
}
