// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileEditorPanel } from "./FileEditorPanel.js";
import type { ProjectDirEntry } from "./api/index.js";
import { jsonResponse } from "./test/jsonResponse.js";

// CodeMirror is exercised for real in components/CodeEditor.test.tsx; here a
// textarea stands in so the panel's own behaviour is the thing under test.
vi.mock("./components/CodeEditor.js", () => ({
  CodeEditor: ({
    value,
    onChange,
    onSave,
    fileName,
  }: {
    value: string;
    onChange?: (v: string) => void;
    onSave?: () => void;
    fileName?: string;
  }) => (
    <textarea
      aria-label={`editor:${fileName}`}
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
    if (method === "GET" && url.includes("/files?path=")) {
      const p = decodeURIComponent(url.split("path=")[1]);
      if (p === "" && h.rootError)
        return Promise.resolve(jsonResponse(503, { message: "Host down" }));
      if (p === "")
        return Promise.resolve(jsonResponse(200, { path: "", entries: ROOT, truncated: false }));
      if (p === "src")
        return Promise.resolve(jsonResponse(200, { path: "src", entries: SRC, truncated: false }));
    }
    if (method === "GET" && url.includes("/file?path=")) {
      const p = decodeURIComponent(url.split("path=")[1]);
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

  it("opens a file, edits it, saves with the loaded mtime, and clears dirty", async () => {
    const { fn, calls } = mockFetch();
    vi.stubGlobal("fetch", fn);
    const user = userEvent.setup();
    render(<FileEditorPanel params={{ projectId: 1 }} />);
    await user.click(await screen.findByText(".env"));
    const editor = await screen.findByLabelText("editor:.env");
    expect(editor).toHaveValue("A=1\n");
    expect(screen.getByText("Save")).toBeDisabled();

    fireEvent.change(editor, { target: { value: "A=2\n" } });
    expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByText("Save"));

    await waitFor(() => expect(screen.queryByLabelText("Unsaved changes")).toBeNull());
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({ path: ".env", content: "A=2\n", expectedMtimeMs: 100 });
    expect(screen.getByText("Save")).toBeDisabled();
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
    await user.click(screen.getByText("Discard"));
    expect(screen.getByLabelText("editor:.env")).toHaveValue("A=1\n");
    expect(screen.getByText("big.bin").closest("button")).not.toBeDisabled();
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
    await user.click(screen.getByText("Save"));
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
    await user.click(screen.getByText("Save"));
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
    await user.click(screen.getByText("Save"));
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
