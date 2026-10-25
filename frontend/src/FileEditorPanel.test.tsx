// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileEditorPanel } from "./FileEditorPanel.js";
import type { ProjectDirEntry } from "./api/index.js";
import { jsonResponse } from "./test/jsonResponse.js";
import { useDashboardStore } from "./store/index.js";

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
      expect(await screen.findByText('"src" is not empty')).toBeInTheDocument();
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
    await screen.findByText(/isn't a UTF-8 text file/);
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
    expect(await screen.findByText(/isn't a UTF-8 text file/)).toBeInTheDocument();
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
});
