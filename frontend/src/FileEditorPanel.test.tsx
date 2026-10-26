// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileEditorPanel } from "./FileEditorPanel.js";
import { api, ApiError, type ProjectDirEntry } from "./api/index.js";
import { jsonResponse } from "./test/jsonResponse.js";
import { useDashboardStore } from "./store/index.js";
import { makeProject } from "./test/fixtures.js";
import { hasDirtyFileUnder } from "./lib/dirtyFiles.js";
import { activeFileDrag, endFileDrag } from "./lib/fileDrag.js";
import { subscribeFilePathGone, type FilePathGone } from "./lib/filePathEvents.js";

// CodeMirror is exercised for real in components/CodeEditor.test.tsx; here a
// textarea stands in so the panel's own behaviour is the thing under test.
vi.mock("./components/CodeEditor.js", () => ({
  CodeEditor: ({
    value,
    onChange,
    onSave,
    fileName,
    revealLine,
  }: {
    value: string;
    onChange?: (v: string) => void;
    onSave?: () => void;
    fileName?: string;
    revealLine?: { line: number; token: number };
  }) => (
    <textarea
      aria-label={`editor:${fileName}`}
      data-reveal-line={revealLine?.line ?? ""}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "s" && e.ctrlKey) onSave?.();
      }}
    />
  ),
}));

const file = (name: string, size = 1): ProjectDirEntry => ({ name, kind: "file", size });
const dir = (name: string): ProjectDirEntry => ({ name, kind: "dir", size: 0 });

const ROOT = [dir("src"), file(".env"), file("big.bin")];
const SRC = [file("index.ts")];

interface Handlers {
  extra?: (method: string, url: string, body?: Record<string, unknown>) => Response | undefined;
  write?: (body: Record<string, unknown>) => Response;
  rootError?: boolean;
}

function mockFetch(h: Handlers = {}) {
  const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : undefined;
    calls.push({ method, url, body });
    const extra = h.extra?.(method, url, body);
    if (extra) return Promise.resolve(extra);
    if (method === "GET" && url.includes("/files?path=")) {
      const p = new URL(url, "http://x").searchParams.get("path") ?? "";
      if (p === "" && h.rootError)
        return Promise.resolve(jsonResponse(503, { message: "Host down" }));
      if (p === "")
        return Promise.resolve(jsonResponse(200, { path: "", entries: ROOT, truncated: false }));
      if (p === "src")
        return Promise.resolve(jsonResponse(200, { path: "src", entries: SRC, truncated: false }));
    }
    if (method === "GET" && url.includes("/file?path=")) {
      const p = new URL(url, "http://x").searchParams.get("path") ?? "";
      if (p === ".env") {
        return Promise.resolve(
          jsonResponse(200, { path: ".env", content: "A=1\n", size: 4, mtimeMs: 100 }),
        );
      }
      if (p === "src/index.ts") {
        return Promise.resolve(
          jsonResponse(200, {
            path: "src/index.ts",
            content: "x",
            size: 1,
            mtimeMs: 5,
            symlinkTarget: "src/real.ts",
          }),
        );
      }
      if (p === "big.bin") {
        return Promise.resolve(jsonResponse(415, { message: "not text", code: "binary" }));
      }
    }
    if (method === "PUT" && url.endsWith("/file")) {
      return Promise.resolve(
        h.write ? h.write(body!) : jsonResponse(200, { size: 4, mtimeMs: 200 }),
      );
    }
    return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
  });
  return { fn, calls };
}

describe("FileEditorPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows loading, then the root listing; retries a failed root load", async () => {
    let first = true;
    const { fn } = mockFetch();
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (first) {
        first = false;
        return Promise.resolve(jsonResponse(503, { message: "Host down" }));
      }
      return fn(input, init);
    });
    const user = userEvent.setup();
    render(<FileEditorPanel params={{ projectId: 1 }} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(await screen.findByText("Host down")).toBeInTheDocument();
    await user.click(screen.getByText("Retry"));
    expect(await screen.findByText(".env")).toBeInTheDocument();
  });

  it("editor mode shows only the editor — no tree, no root listing fetch", async () => {
    const { fn, calls } = mockFetch();
    vi.stubGlobal("fetch", fn);
    const { container } = render(
      <FileEditorPanel params={{ projectId: 1, path: ".env", mode: "editor" }} />,
    );
    expect(await screen.findByLabelText("editor:.env")).toHaveValue("A=1\n");
    expect(container.querySelector(".file-editor-tree")).toBeNull();
    expect(screen.queryByText("New file")).toBeNull();
    expect(calls.some((c) => c.url.includes("/files?path="))).toBe(false);
  });

  it("opens a file, edits it, saves with the loaded mtime, and clears dirty", async () => {
    const { fn, calls } = mockFetch();
    vi.stubGlobal("fetch", fn);
    const user = userEvent.setup();
    render(<FileEditorPanel params={{ projectId: 1 }} />);
    await user.click(await screen.findByText(".env"));
    const editor = await screen.findByLabelText("editor:.env");
    expect(editor).toHaveValue("A=1\n");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(editor, { target: { value: "A=2\n" } });
    expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByLabelText("Unsaved changes")).toBeNull());
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({ path: ".env", content: "A=2\n", expectedMtimeMs: 100 });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("saves via the editor's Ctrl+S handler", async () => {
    const { fn, calls } = mockFetch();
    vi.stubGlobal("fetch", fn);
    const user = userEvent.setup();
    render(<FileEditorPanel params={{ projectId: 1 }} />);
    await user.click(await screen.findByText(".env"));
    const editor = await screen.findByLabelText("editor:.env");
    fireEvent.change(editor, { target: { value: "B=1" } });
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
  });

  it("blocks switching files while dirty; Discard reverts and unblocks", async () => {
    const { fn } = mockFetch();
    vi.stubGlobal("fetch", fn);
    const user = userEvent.setup();
    render(<FileEditorPanel params={{ projectId: 1 }} />);
    await user.click(await screen.findByText(".env"));
    fireEvent.change(await screen.findByLabelText("editor:.env"), { target: { value: "changed" } });

    expect(screen.getByText("big.bin").closest("button")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByLabelText("editor:.env")).toHaveValue("A=1\n");
    expect(screen.getByText("big.bin").closest("button")).not.toBeDisabled();
  });

  it("disables New file while there are unsaved edits", async () => {
    const { fn } = mockFetch();
    vi.stubGlobal("fetch", fn);
    const user = userEvent.setup();
    render(<FileEditorPanel params={{ projectId: 1 }} />);
    await user.click(await screen.findByText(".env"));
    expect(screen.getByText("New file")).not.toBeDisabled();
    fireEvent.change(await screen.findByLabelText("editor:.env"), { target: { value: "x" } });
    expect(screen.getByText("New file")).toBeDisabled();
  });

  it("does not replace an unsaved draft when params.path changes", async () => {
    const { fn } = mockFetch();
    vi.stubGlobal("fetch", fn);
    const user = userEvent.setup();
    const { rerender } = render(<FileEditorPanel params={{ projectId: 1 }} />);
    await user.click(await screen.findByText(".env"));
    fireEvent.change(await screen.findByLabelText("editor:.env"), { target: { value: "mine" } });
    rerender(<FileEditorPanel params={{ projectId: 1, path: "src/index.ts" }} />);
    await waitFor(() => expect(screen.getByText("index.ts")).toBeInTheDocument());
    expect(screen.getByLabelText("editor:.env")).toHaveValue("mine");
  });

  describe("root picker (session / worktree roots)", () => {
    const seed = (sessions: Array<Record<string, unknown>>) =>
      useDashboardStore.setState({
        projects: [{ id: 1, name: "p", cwd: "/proj" }] as never,
        sessions: sessions as never,
      });

    afterEach(() => {
      useDashboardStore.setState({ projects: [], sessions: [] });
    });

    it("shows no picker when every session runs in the project directory", async () => {
      seed([{ id: 7, projectId: 1, status: "active", cwd: "/proj" }]);
      const { fn } = mockFetch();
      vi.stubGlobal("fetch", fn);
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await screen.findByText(".env");
      expect(screen.queryByText("Root")).toBeNull();
    });

    it("lists a worktree session and re-roots the tree on selection", async () => {
      seed([
        { id: 7, projectId: 1, status: "active", cwd: "/elsewhere/feat-x" },
        { id: 8, projectId: 1, status: "killed", cwd: "/elsewhere/dead" },
        { id: 9, projectId: 2, status: "active", cwd: "/other/proj" },
      ]);
      const { fn, calls } = mockFetch();
      vi.stubGlobal("fetch", fn);
      const user = userEvent.setup();
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await screen.findByText(".env");
      expect(screen.getByRole("option", { name: "Worktree: feat-x" })).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: /dead/ })).toBeNull();
      expect(screen.queryByRole("option", { name: /proj$/ })).toBeNull();

      await user.selectOptions(screen.getByRole("combobox"), "7");
      await waitFor(() =>
        expect(calls.some((c) => c.url.includes("/files?path=&sessionId=7"))).toBe(true),
      );
      await user.click(await screen.findByText(".env"));
      await waitFor(() =>
        expect(calls.some((c) => c.url.includes("/file?path=.env&sessionId=7"))).toBe(true),
      );

      fireEvent.change(await screen.findByLabelText("editor:.env"), { target: { value: "x" } });
      expect(screen.getByRole("combobox")).toBeDisabled();
      await user.click(screen.getByRole("button", { name: "Save" }));
      const put = calls.find((c) => c.method === "PUT")!;
      expect(put.body).toMatchObject({ path: ".env", sessionId: 7 });
    });

    it("starts rooted at params.sessionId even when the store doesn't know the session", async () => {
      seed([]);
      const { fn, calls } = mockFetch();
      vi.stubGlobal("fetch", fn);
      render(<FileEditorPanel params={{ projectId: 1, sessionId: 42 }} />);
      await screen.findByText(".env");
      expect(calls[0].url).toContain("sessionId=42");
      expect(screen.getByRole("option", { name: "Session 42" })).toBeInTheDocument();
    });

    it("a re-target back to the project wins over a hand-picked worktree root", async () => {
      seed([{ id: 7, projectId: 1, status: "active", cwd: "/elsewhere/feat-x" }]);
      const { fn, calls } = mockFetch();
      vi.stubGlobal("fetch", fn);
      const user = userEvent.setup();
      const { rerender } = render(<FileEditorPanel params={{ projectId: 1, rev: 1 }} />);
      await screen.findByText(".env");
      await user.selectOptions(screen.getByRole("combobox"), "7");
      await waitFor(() => expect(calls.some((c) => c.url.includes("sessionId=7"))).toBe(true));

      // e.g. the git panel's Edit: project-relative path, no sessionId, new rev
      const before = calls.length;
      rerender(<FileEditorPanel params={{ projectId: 1, path: ".env", rev: 2 }} />);
      expect(await screen.findByLabelText("editor:.env")).toBeInTheDocument();
      expect(screen.getByRole("combobox")).toHaveValue("");
      const after = calls.slice(before).filter((c) => c.url.includes("/file?path=.env"));
      expect(after.length).toBeGreaterThan(0);
      expect(after.every((c) => !c.url.includes("sessionId"))).toBe(true);
    });

    it("follows a re-target to another session, but not over unsaved edits", async () => {
      seed([]);
      const { fn, calls } = mockFetch();
      vi.stubGlobal("fetch", fn);
      const user = userEvent.setup();
      const { rerender } = render(<FileEditorPanel params={{ projectId: 1, sessionId: 42 }} />);
      await user.click(await screen.findByText(".env"));
      fireEvent.change(await screen.findByLabelText("editor:.env"), { target: { value: "dirty" } });
      rerender(<FileEditorPanel params={{ projectId: 1, sessionId: 43 }} />);
      expect(screen.getByLabelText("editor:.env")).toHaveValue("dirty");
      expect(calls.some((c) => c.url.includes("sessionId=43"))).toBe(false);

      await user.click(screen.getByRole("button", { name: "Discard changes" }));
      rerender(<FileEditorPanel params={{ projectId: 1, sessionId: 44 }} />);
      await waitFor(() => expect(calls.some((c) => c.url.includes("sessionId=44"))).toBe(true));
    });
  });

  describe("folders, rename, delete", () => {
    it("creates a folder in the selected folder and refreshes the tree", async () => {
      let created = false;
      const { fn, calls } = mockFetch({
        extra: (method, url, body) => {
          if (method === "POST" && url.endsWith("/files/mkdir")) {
            created = true;
            return jsonResponse(200, { path: body!.path });
          }
          if (created && url.includes("/files?path=src")) {
            return jsonResponse(200, {
              path: "src",
              entries: [dir("newdir"), file("index.ts")],
              truncated: false,
            });
          }
        },
      });
      vi.stubGlobal("fetch", fn);
      const user = userEvent.setup();
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await user.click(await screen.findByText("src"));
      await screen.findByText("index.ts");
      await user.click(screen.getByText("New folder"));
      await user.type(screen.getByLabelText("New folder name"), "newdir{Enter}");
      expect(await screen.findByText("newdir")).toBeInTheDocument();
      expect(calls.find((c) => c.url.endsWith("/files/mkdir"))!.body).toMatchObject({
        path: "src/newdir",
      });
    });

    it("renames a file inline and reopens it when it was the open file", async () => {
      let renamed = false;
      const { fn, calls } = mockFetch({
        extra: (method, url, body) => {
          if (method === "POST" && url.endsWith("/files/rename")) {
            renamed = true;
            return jsonResponse(200, { path: body!.to });
          }
          if (renamed && url.includes("/files?path=")) {
            return jsonResponse(200, {
              path: "",
              entries: [dir("src"), file(".env.local"), file("big.bin")],
              truncated: false,
            });
          }
          if (renamed && url.includes("/file?path=.env.local")) {
            return jsonResponse(200, {
              path: ".env.local",
              content: "A=1\n",
              size: 4,
              mtimeMs: 100,
            });
          }
        },
      });
      vi.stubGlobal("fetch", fn);
      const user = userEvent.setup();
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await user.click(await screen.findByText(".env"));
      await screen.findByLabelText("editor:.env");
      await user.click(screen.getByLabelText("Rename .env"));
      const input = screen.getByRole("textbox", { name: "Rename .env" });
      await user.clear(input);
      await user.type(input, ".env.local{Enter}");
      expect(await screen.findByLabelText("editor:.env.local")).toBeInTheDocument();
      expect(calls.find((c) => c.url.endsWith("/files/rename"))!.body).toMatchObject({
        from: ".env",
        to: ".env.local",
      });
    });

    it("rejects a path as the new name, and Escape cancels a rename", async () => {
      const { fn, calls } = mockFetch();
      vi.stubGlobal("fetch", fn);
      const user = userEvent.setup();
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await screen.findByText("big.bin");
      await user.click(screen.getByLabelText("Rename big.bin"));
      const input = screen.getByRole("textbox", { name: "Rename big.bin" });
      await user.clear(input);
      await user.type(input, "a/b{Enter}");
      expect(await screen.findByText("Enter a name, not a path.")).toBeInTheDocument();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("textbox", { name: "Rename big.bin" })).toBeNull();
      expect(calls.some((c) => c.url.endsWith("/files/rename"))).toBe(false);
    });

    it("deletes with a confirm click and clears the editor if it was the open file", async () => {
      let deleted = false;
      const { fn, calls } = mockFetch({
        extra: (method, url) => {
          if (method === "DELETE") {
            deleted = true;
            return jsonResponse(200, { path: ".env" });
          }
          if (deleted && url.endsWith("/files?path=")) {
            return jsonResponse(200, {
              path: "",
              entries: [dir("src"), file("big.bin")],
              truncated: false,
            });
          }
        },
      });
      vi.stubGlobal("fetch", fn);
      const user = userEvent.setup();
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await user.click(await screen.findByText(".env"));
      await screen.findByLabelText("editor:.env");
      const del = screen.getAllByTitle(/Delete \.env\?/)[0];
      await user.click(del);
      expect(calls.some((c) => c.method === "DELETE")).toBe(false);
      await user.click(screen.getAllByTitle(/Delete \.env\?|Confirm/i)[0] ?? del);
      await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
      expect(await screen.findByText(".env was deleted.")).toBeInTheDocument();
      expect(screen.queryByLabelText("editor:.env")).toBeNull();
    });

    it("shows the server's message when a non-empty folder can't be deleted", async () => {
      const { fn } = mockFetch({
        extra: (method) =>
          method === "DELETE"
            ? jsonResponse(409, { message: '"src" is not empty', code: "not_empty" })
            : undefined,
      });
      vi.stubGlobal("fetch", fn);
      const user = userEvent.setup();
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await screen.findByText("src");
      const del = screen.getAllByTitle(/Delete src\?/)[0];
      await user.click(del);
      await user.click(screen.getAllByTitle(/Delete src\?|Confirm/i)[0] ?? del);
      expect(
        await screen.findByText("src isn't empty — only empty folders can be deleted"),
      ).toBeInTheDocument();
    });

    it("blocks rename/delete of the open file while it has unsaved edits", async () => {
      const { fn } = mockFetch();
      vi.stubGlobal("fetch", fn);
      const user = userEvent.setup();
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await user.click(await screen.findByText(".env"));
      fireEvent.change(await screen.findByLabelText("editor:.env"), { target: { value: "x" } });
      expect(screen.getByLabelText("Rename .env")).toBeDisabled();
      expect(screen.getByLabelText("Delete .env")).toBeDisabled();
      expect(screen.getByLabelText("Rename big.bin")).not.toBeDisabled();
    });
  });

  describe("file search (quick open)", () => {
    const searchMock = (
      results: Array<{ path: string }>,
      opts: { truncated?: boolean; fail?: boolean } = {},
    ) =>
      mockFetch({
        extra: (method, url) => {
          if (method === "GET" && url.includes("/files/search")) {
            if (opts.fail) return jsonResponse(503, { message: "Host down" });
            const q = new URL(url, "http://x").searchParams.get("q") ?? "";
            return jsonResponse(200, {
              results: results.filter((r) => r.path.includes(q)),
              truncated: opts.truncated ?? false,
            });
          }
        },
      });

    it("replaces the tree with ranked results, opens one, and reveals it in the tree", async () => {
      const { fn, calls } = searchMock([{ path: "src/index.ts" }, { path: "src/util.ts" }]);
      vi.stubGlobal("fetch", fn);
      const user = userEvent.setup();
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await screen.findByText(".env");
      await user.type(screen.getByLabelText("Search files"), "src/");
      const list = await screen.findByRole("listbox", { name: "Search results" });
      expect(await within(list).findByText("index.ts")).toBeInTheDocument();
      expect(screen.queryByText(".env")).toBeNull();
      expect(calls.filter((c) => c.url.includes("/files/search")).length).toBeGreaterThanOrEqual(1);

      await user.click(within(list).getByText("index.ts"));
      expect(await screen.findByLabelText("editor:src/index.ts")).toBeInTheDocument();
      // query cleared, tree back with the file's folder expanded
      expect(screen.getByLabelText("Search files")).toHaveValue("");
      expect(screen.getByText(".env")).toBeInTheDocument();
      expect(screen.getAllByText("index.ts").length).toBeGreaterThan(0);
    });

    it("navigates with arrow keys, opens the active result on Enter, Escape clears", async () => {
      const { fn } = searchMock([{ path: "a.ts" }, { path: "b.ts" }]);
      vi.stubGlobal("fetch", fn);
      const user = userEvent.setup();
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await screen.findByText(".env");
      const input = screen.getByLabelText("Search files");
      await user.type(input, ".ts");
      await screen.findByText("b.ts");
      await user.keyboard("{ArrowDown}");
      expect(screen.getByRole("option", { name: /b\.ts/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await user.keyboard("{ArrowUp}{ArrowDown}{Enter}");
      // opening goes through readProjectFile, which the base mock 404s -> note shown
      await waitFor(() => expect(screen.getByLabelText("Search files")).toHaveValue(""));

      await user.type(input, ".ts");
      await screen.findByText("a.ts");
      await user.keyboard("{Escape}");
      expect(input).toHaveValue("");
      expect(screen.getByText(".env")).toBeInTheDocument();
    });

    it("shows empty, truncated and error states", async () => {
      const empty = searchMock([]);
      vi.stubGlobal("fetch", empty.fn);
      const user = userEvent.setup();
      const { unmount } = render(<FileEditorPanel params={{ projectId: 1 }} />);
      await screen.findByText(".env");
      await user.type(screen.getByLabelText("Search files"), "zzz");
      expect(await screen.findByText("No matching files")).toBeInTheDocument();
      unmount();

      const trunc = searchMock([{ path: "x.ts" }], { truncated: true });
      vi.stubGlobal("fetch", trunc.fn);
      const second = render(<FileEditorPanel params={{ projectId: 1 }} />);
      await screen.findByText(".env");
      await user.type(screen.getByLabelText("Search files"), "x");
      expect(await screen.findByText(/Search stopped early/)).toBeInTheDocument();
      second.unmount();

      const failing = searchMock([], { fail: true });
      vi.stubGlobal("fetch", failing.fn);
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await screen.findByText(".env");
      await user.type(screen.getByLabelText("Search files"), "x");
      expect(await screen.findByText("Host down")).toBeInTheDocument();
    });

    it("disables results while there are unsaved edits, and Ctrl+P focuses the search box", async () => {
      const { fn } = searchMock([{ path: "x.ts" }]);
      vi.stubGlobal("fetch", fn);
      const user = userEvent.setup();
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await user.click(await screen.findByText(".env"));
      const editor = await screen.findByLabelText("editor:.env");
      fireEvent.change(editor, { target: { value: "dirty" } });
      await user.type(screen.getByLabelText("Search files"), "x");
      expect(await screen.findByRole("option", { name: /x\.ts/ })).toBeDisabled();

      screen.getByLabelText("Search files").blur();
      fireEvent.keyDown(editor, { key: "p", ctrlKey: true });
      expect(screen.getByLabelText("Search files")).toHaveFocus();
    });

    it("drops a stale response when the query changed meanwhile", async () => {
      let release: (() => void) | undefined;
      const slow = new Promise<void>((r) => (release = r));
      const base = searchMock([{ path: "fast.ts" }, { path: "slow.ts" }]);
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("q=slow")) await slow;
        return base.fn(input, init);
      });
      const user = userEvent.setup();
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await screen.findByText(".env");
      const input = screen.getByLabelText("Search files");
      await user.type(input, "slow");
      await user.clear(input);
      await user.type(input, "fast");
      expect(await screen.findByText("fast.ts")).toBeInTheDocument();
      release?.();
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByText("slow.ts")).toBeNull();
    });
  });

  it("passes params.line to the editor only for the file the link named", async () => {
    const { fn } = mockFetch();
    vi.stubGlobal("fetch", fn);
    const user = userEvent.setup();
    render(<FileEditorPanel params={{ projectId: 1, path: ".env", line: 3, rev: 1 }} />);
    const editor = await screen.findByLabelText("editor:.env");
    expect(editor).toHaveAttribute("data-reveal-line", "3");
    await user.click(screen.getByText("big.bin"));
    await user.click(screen.getByText("src"));
    await user.click(await screen.findByText("index.ts"));
    expect(await screen.findByLabelText("editor:src/index.ts")).toHaveAttribute(
      "data-reveal-line",
      "",
    );
  });

  it("reopens params.path when a re-target bumps rev, even after navigating elsewhere", async () => {
    const { fn, calls } = mockFetch();
    vi.stubGlobal("fetch", fn);
    const user = userEvent.setup();
    const { rerender } = render(
      <FileEditorPanel params={{ projectId: 1, path: ".env", rev: 1 }} />,
    );
    expect(await screen.findByLabelText("editor:.env")).toBeInTheDocument();
    await user.click(screen.getByText("big.bin"));
    await screen.findByText(/Not a UTF-8 text file/);
    const before = calls.filter((c) => c.url.includes("/file?path=.env")).length;

    rerender(<FileEditorPanel params={{ projectId: 1, path: ".env", rev: 2 }} />);
    expect(await screen.findByLabelText("editor:.env")).toBeInTheDocument();
    expect(calls.filter((c) => c.url.includes("/file?path=.env")).length).toBe(before + 1);
  });

  it("expands directories lazily, and shows a symlink target in the header", async () => {
    const { fn, calls } = mockFetch();
    vi.stubGlobal("fetch", fn);
    const user = userEvent.setup();
    render(<FileEditorPanel params={{ projectId: 1 }} />);
    expect(calls.some((c) => c.url.includes("path=src"))).toBe(false);
    await user.click(await screen.findByText("src"));
    await user.click(await screen.findByText("index.ts"));
    expect(await screen.findByText("→ src/real.ts")).toBeInTheDocument();
    // collapse
    await user.click(screen.getByText("src"));
    expect(screen.queryByText("index.ts")).toBeNull();
  });

  it("shows a note instead of an editor for a binary file", async () => {
    const { fn } = mockFetch();
    vi.stubGlobal("fetch", fn);
    const user = userEvent.setup();
    render(<FileEditorPanel params={{ projectId: 1 }} />);
    await user.click(await screen.findByText("big.bin"));
    expect(await screen.findByText(/Not a UTF-8 text file/)).toBeInTheDocument();
  });

  it("handles a 409 conflict: Overwrite re-saves without the mtime guard", async () => {
    let attempt = 0;
    const { fn, calls } = mockFetch({
      write: () => {
        attempt++;
        return attempt === 1
          ? jsonResponse(409, { message: "changed", code: "conflict" })
          : jsonResponse(200, { size: 4, mtimeMs: 300 });
      },
    });
    vi.stubGlobal("fetch", fn);
    const user = userEvent.setup();
    render(<FileEditorPanel params={{ projectId: 1 }} />);
    await user.click(await screen.findByText(".env"));
    fireEvent.change(await screen.findByLabelText("editor:.env"), { target: { value: "mine" } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/changed on disk since you opened it/)).toBeInTheDocument();

    await user.click(screen.getByText("Overwrite"));
    await waitFor(() => expect(screen.queryByText(/changed on disk/)).toBeNull());
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts[1].body).toEqual({ path: ".env", content: "mine" });
  });

  it("Reload from disk re-reads the file after a conflict", async () => {
    const { fn, calls } = mockFetch({
      write: () => jsonResponse(409, { message: "changed", code: "conflict" }),
    });
    vi.stubGlobal("fetch", fn);
    const user = userEvent.setup();
    render(<FileEditorPanel params={{ projectId: 1 }} />);
    await user.click(await screen.findByText(".env"));
    fireEvent.change(await screen.findByLabelText("editor:.env"), { target: { value: "mine" } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(await screen.findByText("Reload from disk"));
    await waitFor(() => expect(screen.getByLabelText("editor:.env")).toHaveValue("A=1\n"));
    expect(calls.filter((c) => c.url.includes("/file?path=.env")).length).toBe(2);
  });

  it("surfaces a non-conflict save error", async () => {
    const { fn } = mockFetch({ write: () => jsonResponse(503, { message: "Permission denied" }) });
    vi.stubGlobal("fetch", fn);
    const user = userEvent.setup();
    render(<FileEditorPanel params={{ projectId: 1 }} />);
    await user.click(await screen.findByText(".env"));
    fireEvent.change(await screen.findByLabelText("editor:.env"), { target: { value: "x" } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Permission denied")).toBeInTheDocument();
  });

  it("creates a new file with create:true and opens it", async () => {
    const { fn, calls } = mockFetch({ write: () => jsonResponse(200, { size: 0, mtimeMs: 1 }) });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "GET" && url.includes("/file?path=notes.txt")) {
        return Promise.resolve(
          jsonResponse(200, { path: "notes.txt", content: "", size: 0, mtimeMs: 1 }),
        );
      }
      return fn(input, init);
    });
    const user = userEvent.setup();
    render(<FileEditorPanel params={{ projectId: 1 }} />);
    await user.click(await screen.findByText("New file"));
    await user.type(screen.getByLabelText("New file name"), "notes.txt{Enter}");
    expect(await screen.findByLabelText("editor:notes.txt")).toBeInTheDocument();
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({ path: "notes.txt", content: "", create: true });
  });

  it("rejects a nested path for a new file instead of creating an invisible one", async () => {
    const { fn, calls } = mockFetch();
    vi.stubGlobal("fetch", fn);
    const user = userEvent.setup();
    render(<FileEditorPanel params={{ projectId: 1 }} />);
    await user.click(await screen.findByText("New file"));
    await user.type(screen.getByLabelText("New file name"), "a/b.txt{Enter}");
    expect(await screen.findByText(/Enter a name, not a path/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("opens params.path on mount, expanding its parent directories", async () => {
    const { fn } = mockFetch();
    vi.stubGlobal("fetch", fn);
    render(<FileEditorPanel params={{ projectId: 1, path: "src/index.ts" }} />);
    expect(await screen.findByLabelText("editor:src/index.ts")).toBeInTheDocument();
    expect(screen.getByText("index.ts")).toBeInTheDocument();
  });

  it("Refresh re-lists expanded directories", async () => {
    const { fn, calls } = mockFetch();
    vi.stubGlobal("fetch", fn);
    const user = userEvent.setup();
    render(<FileEditorPanel params={{ projectId: 1 }} />);
    await user.click(await screen.findByText("Refresh"));
    await waitFor(() =>
      expect(calls.filter((c) => c.url.endsWith("/files?path=")).length).toBeGreaterThanOrEqual(2),
    );
  });

  describe("transfer", () => {
    it("offers a Download for an open text file and for each file row (not folders)", async () => {
      const { fn } = mockFetch();
      vi.stubGlobal("fetch", fn);
      const user = userEvent.setup();
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await user.click(await screen.findByText(".env"));
      await screen.findByLabelText("editor:.env");
      const header = screen.getByRole("link", { name: "Download file" });
      expect(header).toHaveAttribute("href", "/api/projects/1/files/download?path=.env");
      expect(header).toHaveAttribute("download");
      expect(screen.getByRole("link", { name: "Download .env" })).toHaveAttribute(
        "href",
        "/api/projects/1/files/download?path=.env",
      );
      expect(screen.queryByRole("link", { name: "Download src" })).toBeNull();
    });

    it("carries the session on download links when rooted at a session", async () => {
      const { fn } = mockFetch();
      vi.stubGlobal("fetch", fn);
      render(<FileEditorPanel params={{ projectId: 1, sessionId: 9, path: ".env" }} />);
      await screen.findByLabelText("editor:.env");
      expect(screen.getByRole("link", { name: "Download file" })).toHaveAttribute(
        "href",
        "/api/projects/1/files/download?path=.env&sessionId=9",
      );
    });

    it("a binary file gets a download and a note instead of an editor", async () => {
      const { fn } = mockFetch();
      vi.stubGlobal("fetch", fn);
      const user = userEvent.setup();
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await user.click(await screen.findByText("big.bin"));
      expect(await screen.findByText(/Not a UTF-8 text file/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Download file" })).toHaveAttribute(
        "href",
        "/api/projects/1/files/download?path=big.bin",
      );
      expect(screen.queryByRole("img")).toBeNull();
    });

    it("a file over the edit limit says so and still offers a download", async () => {
      const { fn } = mockFetch({
        extra: (method, url) =>
          method === "GET" && url.includes("/file?path=big.bin")
            ? jsonResponse(413, { message: "too big", code: "too_large" })
            : undefined,
      });
      vi.stubGlobal("fetch", fn);
      const user = userEvent.setup();
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await user.click(await screen.findByText("big.bin"));
      expect(await screen.findByText(/too large to edit here/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Download file" })).toBeInTheDocument();
    });

    describe("image preview", () => {
      const withPng = (downloadResponse: () => Response) =>
        mockFetch({
          extra: (method, url) => {
            if (method !== "GET") return undefined;
            if (
              url.includes("/files?path=") &&
              new URL(url, "http://x").searchParams.get("path") === ""
            )
              return jsonResponse(200, { path: "", entries: [file("pic.png")], truncated: false });
            if (url.includes("/file?path=pic.png"))
              return jsonResponse(415, { message: "not text", code: "binary" });
            if (url.includes("/files/download?path=pic.png")) return downloadResponse();
            return undefined;
          },
        });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it("renders an image inline via a blob URL and revokes it on leaving", async () => {
        const create = vi.fn(() => "blob:preview-1");
        const revoke = vi.fn();
        vi.stubGlobal(
          "URL",
          Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }),
        );
        const { fn } = withPng(
          () => new Response("PNGDATA", { status: 200, headers: { "content-length": "7" } }),
        );
        vi.stubGlobal("fetch", fn);
        const user = userEvent.setup();
        const { unmount } = render(<FileEditorPanel params={{ projectId: 1 }} />);
        await user.click(await screen.findByText("pic.png"));
        const img = await screen.findByRole("img", { name: "pic.png" });
        expect(img).toHaveAttribute("src", "blob:preview-1");
        const blob = (create.mock.calls[0] as unknown as [Blob])[0];
        expect(blob.type).toBe("image/png");
        unmount();
        expect(revoke).toHaveBeenCalledWith("blob:preview-1");
      });

      it("makes no object URL for a preview that resolves after the view is gone", async () => {
        const create = vi.fn(() => "blob:late");
        vi.stubGlobal(
          "URL",
          Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }),
        );
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const { fn } = withPng(() => new Response("PNGDATA", { status: 200 }));
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).includes("/files/download")) await gate;
          return fn(input, init);
        });
        const user = userEvent.setup();
        const { unmount } = render(<FileEditorPanel params={{ projectId: 1 }} />);
        await user.click(await screen.findByText("pic.png"));
        await screen.findByText(/Loading preview/);
        unmount();
        release();
        await new Promise((r) => setTimeout(r, 30));
        expect(create).not.toHaveBeenCalled();
      });

      it("says 'too large to preview' for an image over the preview cap", async () => {
        const { fn } = withPng(
          () =>
            new Response("x", {
              status: 200,
              headers: { "content-length": String(26 * 1024 * 1024) },
            }),
        );
        vi.stubGlobal("fetch", fn);
        const user = userEvent.setup();
        render(<FileEditorPanel params={{ projectId: 1 }} />);
        await user.click(await screen.findByText("pic.png"));
        expect(await screen.findByText(/Too large to preview/)).toBeInTheDocument();
        expect(screen.queryByRole("img")).toBeNull();
        expect(screen.getByRole("link", { name: "Download file" })).toBeInTheDocument();
      });

      it("falls back to a note when the preview can't be fetched", async () => {
        const { fn } = withPng(() => jsonResponse(500, { message: "boom" }));
        vi.stubGlobal("fetch", fn);
        const user = userEvent.setup();
        render(<FileEditorPanel params={{ projectId: 1 }} />);
        await user.click(await screen.findByText("pic.png"));
        expect(await screen.findByText(/Couldn't load a preview/)).toBeInTheDocument();
      });
    });

    it("deleting the open non-text file clears the view", async () => {
      let deleted = false;
      const { fn } = mockFetch({
        extra: (method, url) => {
          if (method === "DELETE") {
            deleted = true;
            return jsonResponse(200, { path: "big.bin" });
          }
          if (deleted && url.includes("/files?path=") && !url.includes("src"))
            return jsonResponse(200, {
              path: "",
              entries: [dir("src"), file(".env")],
              truncated: false,
            });
        },
      });
      vi.stubGlobal("fetch", fn);
      const user = userEvent.setup();
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await user.click(await screen.findByText("big.bin"));
      await screen.findByText(/Not a UTF-8 text file/);
      const del = screen.getAllByTitle(/Delete big\.bin\?/)[0];
      await user.click(del);
      await user.click(screen.getAllByTitle(/Delete big\.bin\?|Confirm/i)[0] ?? del);
      expect(await screen.findByText("big.bin was deleted.")).toBeInTheDocument();
      expect(screen.queryByText(/Not a UTF-8 text file/)).toBeNull();
    });

    it("renaming the open non-text file reopens it under the new name", async () => {
      let renamed = false;
      const { fn } = mockFetch({
        extra: (method, url) => {
          if (method === "POST" && url.endsWith("/files/rename")) {
            renamed = true;
            return jsonResponse(200, { path: "big2.bin" });
          }
          if (renamed && url.includes("/files?path=") && !url.includes("src"))
            return jsonResponse(200, {
              path: "",
              entries: [dir("src"), file("big2.bin")],
              truncated: false,
            });
          if (renamed && url.includes("/file?path=big2.bin"))
            return jsonResponse(415, { message: "not text", code: "binary" });
        },
      });
      vi.stubGlobal("fetch", fn);
      const user = userEvent.setup();
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await user.click(await screen.findByText("big.bin"));
      await screen.findByText(/Not a UTF-8 text file/);
      await user.click(screen.getByLabelText("Rename big.bin"));
      const input = screen.getByRole("textbox", { name: "Rename big.bin" });
      await user.clear(input);
      await user.type(input, "big2.bin{Enter}");
      await waitFor(() =>
        expect(screen.getByRole("link", { name: "Download file" })).toHaveAttribute(
          "href",
          "/api/projects/1/files/download?path=big2.bin",
        ),
      );
    });
  });

  describe("upload", () => {
    const fileEntry = (name: string, f: File) => ({
      isFile: true,
      isDirectory: false,
      name,
      file: (cb: (x: File) => void) => cb(f),
    });
    const dropOf = (entries: unknown[], files: File[]) => ({
      dataTransfer: {
        types: ["Files"],
        files,
        items: entries.map((entry) => ({
          kind: "file",
          getAsFile: () => files[0] ?? null,
          webkitGetAsEntry: () => entry,
        })),
        dropEffect: "none",
      },
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("uploads picked files into the selected folder and re-lists it", async () => {
      const upload = vi.spyOn(api, "uploadProjectFile").mockResolvedValue({ path: "x", size: 1 });
      const { fn, calls } = mockFetch();
      vi.stubGlobal("fetch", fn);
      const user = userEvent.setup();
      render(<FileEditorPanel params={{ projectId: 1, sessionId: 5 }} />);
      await user.click(await screen.findByText("src"));
      const f = new File(["x"], "new.ts");
      await user.upload(screen.getByLabelText("Upload files"), f);
      await waitFor(() =>
        expect(upload).toHaveBeenCalledWith(
          1,
          "src/new.ts",
          f,
          expect.objectContaining({ sessionId: 5 }),
        ),
      );
      await waitFor(() =>
        expect(calls.filter((c) => c.url.includes("/files?path=src")).length).toBeGreaterThan(1),
      );
    });

    it("the Upload buttons open the pickers", async () => {
      const { fn } = mockFetch();
      vi.stubGlobal("fetch", fn);
      const user = userEvent.setup();
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await screen.findByText("src");
      const files = screen.getByLabelText("Upload files") as HTMLInputElement;
      const folder = screen.getByLabelText("Upload folder") as HTMLInputElement;
      const clickFiles = vi.spyOn(files, "click");
      const clickFolder = vi.spyOn(folder, "click");
      await user.click(screen.getByRole("button", { name: "Upload" }));
      await user.click(screen.getByRole("button", { name: "Upload folder" }));
      expect(clickFiles).toHaveBeenCalledTimes(1);
      expect(clickFolder).toHaveBeenCalledTimes(1);
    });

    it("uploads a file dropped on a folder row into that folder", async () => {
      const upload = vi.spyOn(api, "uploadProjectFile").mockResolvedValue({ path: "x", size: 1 });
      const { fn } = mockFetch();
      vi.stubGlobal("fetch", fn);
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      const row = (await screen.findByText("src")).closest("button") as HTMLElement;
      const f = new File(["d"], "d.txt");
      fireEvent.dragOver(row, dropOf([fileEntry("d.txt", f)], [f]));
      expect(row.className).toContain("file-drop-target");
      fireEvent.drop(row, dropOf([fileEntry("d.txt", f)], [f]));
      await waitFor(() =>
        expect(upload).toHaveBeenCalledWith(1, "src/d.txt", f, expect.anything()),
      );
    });

    it("uploads a file dropped on a file row next to it, and on the tree background", async () => {
      const upload = vi.spyOn(api, "uploadProjectFile").mockResolvedValue({ path: "x", size: 1 });
      const { fn } = mockFetch();
      vi.stubGlobal("fetch", fn);
      const { container } = render(<FileEditorPanel params={{ projectId: 1 }} />);
      const row = (await screen.findByText(".env")).closest("button") as HTMLElement;
      const a = new File(["a"], "a.txt");
      fireEvent.drop(row, dropOf([fileEntry("a.txt", a)], [a]));
      await waitFor(() => expect(upload).toHaveBeenCalledWith(1, "a.txt", a, expect.anything()));
      await waitFor(() => expect(screen.queryByText(/Uploading/)).toBeNull());
      const b = new File(["b"], "b.txt");
      fireEvent.drop(
        container.querySelector(".file-editor-tree") as HTMLElement,
        dropOf([fileEntry("b.txt", b)], [b]),
      );
      await waitFor(() => expect(upload).toHaveBeenCalledWith(1, "b.txt", b, expect.anything()));
    });

    it("lists a refused name in the tree and lets it be dismissed", async () => {
      vi.spyOn(api, "uploadProjectFile").mockRejectedValue(new ApiError("exists", 409, "conflict"));
      const { fn } = mockFetch();
      vi.stubGlobal("fetch", fn);
      const user = userEvent.setup();
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await screen.findByText("src");
      await user.upload(screen.getByLabelText("Upload files"), new File(["x"], "dup.txt"));
      expect(await screen.findByText("dup.txt already exists")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Dismiss upload errors" }));
      expect(screen.queryByText("dup.txt already exists")).toBeNull();
    });
  });

  describe("drag to move, and shared edit state", () => {
    const fakeDt = () => {
      const data = new Map<string, string>();
      return {
        setData: (k: string, v: string) => void data.set(k, v),
        getData: (k: string) => data.get(k) ?? "",
        get types() {
          return [...data.keys()];
        },
        dropEffect: "none",
        effectAllowed: "all",
        items: [],
        files: [],
      };
    };
    // Only the tree's own rows: an open file's name is in the header too.
    const rowOf = (name: string) =>
      Array.from(
        document.querySelectorAll<HTMLElement>(".file-editor-tree .file-editor-rowwrap"),
      ).find(
        (r) => r.querySelector(".agent-rules-panel-row-name")?.textContent === name,
      ) as HTMLElement;
    beforeEach(() => {
      useDashboardStore.setState({ projects: [makeProject({ id: 1, cwd: "/work/app" })] });
    });
    afterEach(() => endFileDrag());

    const movable = () => {
      let moved = false;
      const m = mockFetch({
        extra: (method, url) => {
          if (method === "POST" && url.endsWith("/files/rename")) {
            moved = true;
            return jsonResponse(200, { path: "src/.env" });
          }
          if (moved && url.includes("/files?path=") && !url.includes("src")) {
            return jsonResponse(200, {
              path: "",
              entries: [dir("src"), file("big.bin")],
              truncated: false,
            });
          }
          if (moved && url.includes("/file?path=src%2F.env")) {
            return jsonResponse(200, { path: "src/.env", content: "A=1\n", size: 4, mtimeMs: 100 });
          }
        },
      });
      vi.stubGlobal("fetch", m.fn);
      return m;
    };

    it("moves a file onto a folder, announcing the old path as gone", async () => {
      const gone: FilePathGone[] = [];
      const off = subscribeFilePathGone((e) => gone.push(e));
      const { calls } = movable();
      render(<FileEditorPanel params={{ projectId: 1, sessionId: undefined }} />);
      await screen.findByText(".env");
      const dt = fakeDt();
      fireEvent.dragStart(rowOf(".env"), { dataTransfer: dt });
      expect(JSON.parse(dt.getData("application/x-mullion-file"))).toMatchObject({
        projectId: 1,
        sessionId: null,
        path: ".env",
        kind: "file",
      });
      fireEvent.dragOver(rowOf("src"), { dataTransfer: dt });
      expect(rowOf("src").querySelector(".file-drop-target")).toBeTruthy();
      fireEvent.drop(rowOf("src"), { dataTransfer: dt });
      await waitFor(() =>
        expect(calls.find((c) => c.url.endsWith("/files/rename"))!.body).toMatchObject({
          from: ".env",
          to: "src/.env",
        }),
      );
      expect(gone).toEqual([{ projectId: 1, sessionId: undefined, path: ".env" }]);
      off();
    });

    it("follows the open file when it is the one moved", async () => {
      const user = userEvent.setup();
      const { calls } = movable();
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await user.click(await screen.findByText(".env"));
      await screen.findByLabelText("editor:.env");
      const dt = fakeDt();
      fireEvent.dragStart(rowOf(".env"), { dataTransfer: dt });
      fireEvent.drop(rowOf("src"), { dataTransfer: dt });
      expect(await screen.findByLabelText("editor:src/.env")).toBeInTheDocument();
      expect(calls.some((c) => c.url.includes("/file?path=src%2F.env"))).toBe(true);
    });

    it("moves to the root when dropped on the tree background", async () => {
      const user = userEvent.setup();
      let moved = false;
      const { fn, calls } = mockFetch({
        extra: (method, url) => {
          if (method === "POST" && url.endsWith("/files/rename")) {
            moved = true;
            return jsonResponse(200, { path: "index.ts" });
          }
          if (moved && url.includes("/files?path=")) {
            return jsonResponse(200, {
              path: "",
              entries: [dir("src"), file("index.ts")],
              truncated: false,
            });
          }
        },
      });
      vi.stubGlobal("fetch", fn);
      const { container } = render(<FileEditorPanel params={{ projectId: 1 }} />);
      await user.click(await screen.findByText("src"));
      await screen.findByText("index.ts");
      const dt = fakeDt();
      fireEvent.dragStart(rowOf("index.ts"), { dataTransfer: dt });
      fireEvent.drop(container.querySelector(".file-editor-tree") as HTMLElement, {
        dataTransfer: dt,
      });
      await waitFor(() =>
        expect(calls.find((c) => c.url.endsWith("/files/rename"))!.body).toMatchObject({
          from: "src/index.ts",
          to: "index.ts",
        }),
      );
    });

    it("shows a move clash and a refused drop does nothing", async () => {
      const { fn, calls } = mockFetch({
        extra: (method, url) =>
          method === "POST" && url.endsWith("/files/rename")
            ? jsonResponse(409, { message: "exists", code: "conflict" })
            : undefined,
      });
      vi.stubGlobal("fetch", fn);
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await screen.findByText(".env");
      const dt = fakeDt();
      fireEvent.dragStart(rowOf(".env"), { dataTransfer: dt });
      fireEvent.drop(rowOf("src"), { dataTransfer: dt });
      expect(await screen.findByText(".env already exists in src")).toBeInTheDocument();
      // a drop of the same row back on the root background is "already there"
      calls.length = 0;
      fireEvent.dragStart(rowOf(".env"), { dataTransfer: dt });
      fireEvent.drop(rowOf("big.bin"), { dataTransfer: dt });
      expect(calls.some((c) => c.url.endsWith("/files/rename"))).toBe(false);
    });

    it("rows are not draggable while the project's directory is unknown", async () => {
      useDashboardStore.setState({ projects: [] });
      const { fn } = mockFetch();
      vi.stubGlobal("fetch", fn);
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await screen.findByText(".env");
      expect(rowOf(".env").getAttribute("draggable")).toBe("false");
      // a drag that did start would carry no root: nothing must be recorded
      fireEvent.dragStart(rowOf(".env"), { dataTransfer: fakeDt() });
      expect(activeFileDrag()).toBeNull();
    });

    it("does not drag a symlink out of the project, nor accept a drag onto its own folder", async () => {
      const { fn } = mockFetch({
        extra: (method, url) =>
          method === "GET" && url.includes("/files?path=") && !url.includes("src")
            ? jsonResponse(200, {
                path: "",
                entries: [
                  { name: "escape", kind: "symlink", size: 0, targetKind: "outside" },
                  dir("src"),
                ],
                truncated: false,
              })
            : undefined,
      });
      vi.stubGlobal("fetch", fn);
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await screen.findByText("escape");
      expect(rowOf("escape").getAttribute("draggable")).toBe("false");
    });

    it("refuses to move a file with unsaved edits, here or in another panel", async () => {
      const user = userEvent.setup();
      const { fn, calls } = mockFetch();
      vi.stubGlobal("fetch", fn);
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await user.click(await screen.findByText(".env"));
      const editor = await screen.findByLabelText("editor:.env");
      await user.type(editor, "x");
      await waitFor(() => expect(hasDirtyFileUnder(1, undefined, ".env")).toBe(true));
      const dt = fakeDt();
      fireEvent.dragStart(rowOf(".env"), { dataTransfer: dt });
      fireEvent.drop(rowOf("src"), { dataTransfer: dt });
      expect(calls.some((c) => c.url.endsWith("/files/rename"))).toBe(false);
    });

    it("keeps the shared registry in step with the draft, and clears it on unmount", async () => {
      const user = userEvent.setup();
      const { fn } = mockFetch();
      vi.stubGlobal("fetch", fn);
      const { unmount } = render(
        <FileEditorPanel params={{ projectId: 1, sessionId: undefined }} />,
      );
      await user.click(await screen.findByText(".env"));
      await user.type(await screen.findByLabelText("editor:.env"), "x");
      await waitFor(() => expect(hasDirtyFileUnder(1, undefined, ".env")).toBe(true));
      await user.click(screen.getByRole("button", { name: "Discard changes" }));
      await waitFor(() => expect(hasDirtyFileUnder(1, undefined, ".env")).toBe(false));
      await user.type(screen.getByLabelText("editor:.env"), "y");
      await waitFor(() => expect(hasDirtyFileUnder(1, undefined, ".env")).toBe(true));
      unmount();
      expect(hasDirtyFileUnder(1, undefined, ".env")).toBe(false);
    });

    it("announces the old path as gone after a rename and after a delete", async () => {
      const gone: FilePathGone[] = [];
      const off = subscribeFilePathGone((e) => gone.push(e));
      const user = userEvent.setup();
      const { fn } = mockFetch({
        extra: (method, url) => {
          if (method === "POST" && url.endsWith("/files/rename"))
            return jsonResponse(200, { path: "z" });
          if (method === "DELETE") return jsonResponse(200, { path: "big.bin" });
        },
      });
      vi.stubGlobal("fetch", fn);
      render(<FileEditorPanel params={{ projectId: 1 }} />);
      await screen.findByText("big.bin");
      await user.click(screen.getByLabelText("Rename big.bin"));
      const input = screen.getByRole("textbox", { name: "Rename big.bin" });
      await user.clear(input);
      await user.type(input, "z.bin{Enter}");
      await waitFor(() => expect(gone).toHaveLength(1));
      const del = screen.getAllByTitle(/Delete \.env\?/)[0];
      await user.click(del);
      await user.click(screen.getAllByTitle(/Delete \.env\?|Confirm/i)[0] ?? del);
      await waitFor(() => expect(gone).toHaveLength(2));
      expect(gone.map((g) => g.path)).toEqual(["big.bin", ".env"]);
      off();
    });
  });
});
