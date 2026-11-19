// @vitest-environment jsdom
// Image paste and file upload: the clipboard-image path, the
// attach-image button, the drop handler's own limits and notices, and a
// file dragged in from a file tree.
//
// Split out of the former frontend/src/TerminalPane.test.tsx, which had grown
// past the file-size ceiling (scripts/max-file-lines.baseline.json). The mock
// preamble and the shared helpers now live in ./test/terminal-pane-mocks.ts
// and ./test/terminal-pane-harness.tsx.

import { describe, it, expect, vi } from "vitest";

// IMPORT ORDER MATTERS: the mocks module is imported BEFORE the harness.
// Vitest evaluates a test file's imports in order, and the harness pulls in
// the mocked modules (TerminalPane -> @xterm/xterm), whose vi.mock factories
// call back into the mocks module — so the mocks module has to be evaluated
// (and its exports initialized) first. See
// frontend/src/test/terminal-pane-mocks.ts's own header comment.
import {
  mockApiFactory,
  mockRepaintRegistryFactory,
  mockInputRegistryFactory,
  mockXtermFactory,
  mockFitAddonFactory,
  mockWebglAddonFactory,
  mockUnicode11AddonFactory,
  mockSearchAddonFactory,
} from "./test/terminal-pane-mocks.js";

import { screen, waitFor, fireEvent } from "@testing-library/react";
import { act } from "react";
import { useDashboardStore } from "./store/index.js";
import { api, ApiError } from "./api/index.js";
import { makeProject, makeSession as makeStoreSession } from "./test/fixtures.js";
import {
  renderPane,
  stubFakeWebSocket,
  fakeSocket,
  getLatestTermInstance,
  setupTerminalPaneTestLifecycle,
} from "./test/terminal-pane-harness.js";

vi.mock("./api/index.js", () => mockApiFactory());
vi.mock("./terminalRepaintRegistry.js", () => mockRepaintRegistryFactory());
vi.mock("./terminalInputRegistry.js", () => mockInputRegistryFactory());
vi.mock("@xterm/xterm", () => mockXtermFactory());
vi.mock("@xterm/addon-fit", () => mockFitAddonFactory());
vi.mock("@xterm/addon-webgl", () => mockWebglAddonFactory());
vi.mock("@xterm/addon-unicode11", () => mockUnicode11AddonFactory());
vi.mock("@xterm/addon-search", () => mockSearchAddonFactory());

setupTerminalPaneTestLifecycle();

describe("TerminalPane image paste/upload (issue #68)", () => {
  // Simulates the Cmd+V chord attachKeyConflictHandler listens for, by
  // invoking whatever callback the (mocked) term.attachCustomKeyEventHandler
  // was last registered with — the mount effect and the settings-sync effect
  // that runs right after it both register one, and both close over the same
  // pasteHandlerRef, so the most recent registration is equivalent to either.
  function triggerPasteChord() {
    const term = getLatestTermInstance();
    const calls = term.attachCustomKeyEventHandler.mock.calls;
    const handler = calls[calls.length - 1]![0] as (event: unknown) => boolean;
    act(() => {
      handler({
        type: "keydown",
        key: "v",
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        preventDefault: vi.fn(),
      });
    });
  }

  it("uploads a clipboard image and injects its path instead of pasting text", async () => {
    stubFakeWebSocket(true);
    const blob = new Blob(["fake"], { type: "image/png" });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi
          .fn()
          .mockResolvedValue([{ types: ["image/png"], getType: vi.fn().mockResolvedValue(blob) }]),
        readText: vi.fn().mockResolvedValue("should not be used"),
      },
    });
    vi.mocked(api.uploadSessionFile).mockResolvedValue({ path: "/cwd/.mullion-uploads/x.png" });

    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    triggerPasteChord();

    await waitFor(() => expect(api.uploadSessionFile).toHaveBeenCalledWith(1, blob, "pasted.png"));
    await waitFor(() => {
      expect(getLatestTermInstance().paste).toHaveBeenCalledWith("/cwd/.mullion-uploads/x.png ");
    });
    expect(navigator.clipboard.readText).not.toHaveBeenCalled();
  });

  it("falls back to a text paste when the clipboard has no image entry", async () => {
    stubFakeWebSocket(true);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi.fn().mockResolvedValue([{ types: ["text/plain"], getType: vi.fn() }]),
        readText: vi.fn().mockResolvedValue("hello"),
      },
    });

    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    triggerPasteChord();

    await waitFor(() => expect(getLatestTermInstance().paste).toHaveBeenCalledWith("hello"));
    expect(api.uploadSessionFile).not.toHaveBeenCalled();
  });

  it("falls back to a text paste when navigator.clipboard.read is unavailable", async () => {
    stubFakeWebSocket(true);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn().mockResolvedValue("plain text") },
    });

    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    triggerPasteChord();

    await waitFor(() => expect(getLatestTermInstance().paste).toHaveBeenCalledWith("plain text"));
    expect(api.uploadSessionFile).not.toHaveBeenCalled();
  });

  it("uploads a file selected via the attach-image button and injects its path", async () => {
    stubFakeWebSocket(true);
    vi.mocked(api.uploadSessionFile).mockResolvedValue({ path: "/cwd/.mullion-uploads/y.jpg" });

    const { container } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["fake"], "photo.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(api.uploadSessionFile).toHaveBeenCalledWith(1, file, "photo.png"));
    await waitFor(() => {
      expect(getLatestTermInstance().paste).toHaveBeenCalledWith("/cwd/.mullion-uploads/y.jpg ");
    });
  });

  it("uploads files of any type dropped onto the pane", async () => {
    stubFakeWebSocket(true);
    vi.mocked(api.uploadSessionFile).mockResolvedValue({
      path: "/cwd/.mullion-uploads/d/notes.txt",
    });

    const { container } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    const pane = container.firstElementChild as HTMLElement;

    fireEvent.dragEnter(pane, { dataTransfer: { types: ["Files"], files: [] } });
    expect(screen.getByText("Drop files to attach")).toBeInTheDocument();

    const text = new File(["x"], "notes.txt", { type: "text/plain" });
    fireEvent.drop(pane, { dataTransfer: { types: ["Files"], files: [text] } });
    await waitFor(() => expect(api.uploadSessionFile).toHaveBeenCalledWith(1, text, "notes.txt"));
    expect(screen.queryByText("Drop files to attach")).not.toBeInTheDocument();
  });

  describe("a file dragged from a file tree", () => {
    const MIME = "application/x-mullion-file";
    const payload = (over = {}) =>
      JSON.stringify({
        projectId: 7,
        sessionId: null,
        path: "src/a b.ts",
        kind: "file",
        rootCwd: "/work/app",
        ...over,
      });
    const dt = (json: string) => ({
      types: [MIME],
      getData: (t: string) => (t === MIME ? json : ""),
      files: [],
      items: [],
    });

    it("types the path relative to the session's directory, backslash-escaped when it needs it", async () => {
      stubFakeWebSocket(true);
      const { container } = renderPane();
      await waitFor(() => expect(fakeSocket.readyState).toBe(1));
      useDashboardStore.setState({
        projects: [makeProject({ id: 7, cwd: "/work/app" })],
        sessions: [makeStoreSession({ id: 1, projectId: 7, cwd: "/work/app/packages/ui" })],
      });
      const pane = container.firstElementChild as HTMLElement;
      fireEvent.dragEnter(pane, { dataTransfer: dt(payload()) });
      expect(screen.getByText("Drop to insert path")).toBeInTheDocument();
      fireEvent.drop(pane, { dataTransfer: dt(payload()) });
      expect(getLatestTermInstance().paste).toHaveBeenCalledWith("../../src/a\\ b.ts ");
      expect(screen.queryByText("Drop to insert path")).not.toBeInTheDocument();
      expect(api.uploadSessionFile).not.toHaveBeenCalled(); // a reference, not an upload
    });

    it("resolves to the same file in a worktree session's own checkout", async () => {
      stubFakeWebSocket(true);
      const { container } = renderPane();
      await waitFor(() => expect(fakeSocket.readyState).toBe(1));
      useDashboardStore.setState({
        projects: [makeProject({ id: 7, cwd: "/work/app" })],
        sessions: [
          makeStoreSession({ id: 1, projectId: 7, cwd: "/work/app/.mullion-worktrees/feat" }),
        ],
      });
      fireEvent.drop(container.firstElementChild as HTMLElement, {
        dataTransfer: dt(payload({ path: "src/a.ts" })),
      });
      expect(getLatestTermInstance().paste).toHaveBeenCalledWith("src/a.ts ");
    });

    it("types an absolute path for a file from another project", async () => {
      stubFakeWebSocket(true);
      const { container } = renderPane();
      await waitFor(() => expect(fakeSocket.readyState).toBe(1));
      useDashboardStore.setState({
        projects: [makeProject({ id: 8, cwd: "/work/other" })],
        sessions: [makeStoreSession({ id: 1, projectId: 8, cwd: "/work/other" })],
      });
      fireEvent.drop(container.firstElementChild as HTMLElement, {
        dataTransfer: dt(payload({ path: "src/a.ts" })),
      });
      expect(getLatestTermInstance().paste).toHaveBeenCalledWith("/work/app/src/a.ts ");
    });

    it("ignores a malformed payload and does nothing where input affordances are off", async () => {
      stubFakeWebSocket(true);
      const { container } = renderPane();
      await waitFor(() => expect(fakeSocket.readyState).toBe(1));
      const pane = container.firstElementChild as HTMLElement;
      fireEvent.drop(pane, { dataTransfer: dt("not json") });
      expect(getLatestTermInstance().paste).not.toHaveBeenCalled();
    });

    it("is inert on a pane without input affordances (a dock monitor)", async () => {
      stubFakeWebSocket(true);
      const { container } = renderPane({ inputAffordances: false });
      await waitFor(() => expect(fakeSocket.readyState).toBe(1));
      const pane = container.firstElementChild as HTMLElement;
      fireEvent.dragEnter(pane, { dataTransfer: dt(payload()) });
      expect(screen.queryByText("Drop to insert path")).not.toBeInTheDocument();
      fireEvent.drop(pane, { dataTransfer: dt(payload()) });
      expect(getLatestTermInstance().paste).not.toHaveBeenCalled();
    });
  });

  it("uploads every file of a multi-file drop and pastes the paths together in drop order", async () => {
    stubFakeWebSocket(true);
    vi.mocked(api.uploadSessionFile).mockImplementation(async (_id, _blob, name) => ({
      path: `/cwd/.mullion-uploads/u/${name}`,
    }));

    const { container } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    const img = new File(["i"], "a.png", { type: "image/png" });
    const pdf = new File(["p"], "b.pdf", { type: "application/pdf" });
    fireEvent.drop(container.firstElementChild as HTMLElement, {
      dataTransfer: { types: ["Files"], files: [img, pdf] },
    });

    await waitFor(() => {
      expect(getLatestTermInstance().paste).toHaveBeenCalledWith(
        "/cwd/.mullion-uploads/u/a.png /cwd/.mullion-uploads/u/b.pdf ",
      );
    });
    expect(api.uploadSessionFile).toHaveBeenCalledTimes(2);
  });

  it("still pastes the paths that uploaded when another file in the drop fails", async () => {
    stubFakeWebSocket(true);
    vi.mocked(api.uploadSessionFile).mockImplementation(async (_id, _blob, name) => {
      if (name === "bad.bin") throw new Error("too large");
      return { path: `/cwd/.mullion-uploads/u/${name}` };
    });

    const { container, getByText } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    const bad = new File(["x"], "bad.bin", { type: "" });
    const good = new File(["y"], "good.txt", { type: "text/plain" });
    fireEvent.drop(container.firstElementChild as HTMLElement, {
      dataTransfer: { types: ["Files"], files: [bad, good] },
    });

    await waitFor(() => {
      expect(getLatestTermInstance().paste).toHaveBeenCalledWith(
        "/cwd/.mullion-uploads/u/good.txt ",
      );
    });
    expect(getByText("Upload failed")).toBeTruthy();
  });

  it("backslash-escapes a pasted path whose cwd contains a space", async () => {
    stubFakeWebSocket(true);
    vi.mocked(api.uploadSessionFile).mockResolvedValue({
      path: "/my proj/.mullion-uploads/u/a.txt",
    });

    const { container } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    fireEvent.drop(container.firstElementChild as HTMLElement, {
      dataTransfer: { types: ["Files"], files: [new File(["x"], "a.txt", { type: "text/plain" })] },
    });

    await waitFor(() => {
      expect(getLatestTermInstance().paste).toHaveBeenCalledWith(
        "/my\\ proj/.mullion-uploads/u/a.txt ",
      );
    });
  });

  it("retries once as a generic file when the image content check fails", async () => {
    stubFakeWebSocket(true);
    vi.mocked(api.uploadSessionFile).mockReset();
    vi.mocked(api.uploadSessionFile)
      .mockRejectedValueOnce(new ApiError("mismatch", 400, "UPLOAD_IMAGE_MISMATCH"))
      .mockResolvedValueOnce({ path: "/cwd/.mullion-uploads/u/fake.png" });

    const { container } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    const fake = new File(["not a png"], "fake.png", { type: "image/png" });
    fireEvent.drop(container.firstElementChild as HTMLElement, {
      dataTransfer: { types: ["Files"], files: [fake] },
    });

    await waitFor(() => {
      expect(getLatestTermInstance().paste).toHaveBeenCalledWith(
        "/cwd/.mullion-uploads/u/fake.png ",
      );
    });
    expect(api.uploadSessionFile).toHaveBeenCalledTimes(2);
    expect(api.uploadSessionFile).toHaveBeenLastCalledWith(1, fake, "fake.png", {
      asGeneric: true,
    });
  });

  it("does not retry a second time when the generic retry also fails", async () => {
    stubFakeWebSocket(true);
    vi.mocked(api.uploadSessionFile).mockReset();
    vi.mocked(api.uploadSessionFile)
      .mockRejectedValueOnce(new ApiError("mismatch", 400, "UPLOAD_IMAGE_MISMATCH"))
      .mockRejectedValueOnce(new Error("boom"));

    const { container, getByText } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    fireEvent.drop(container.firstElementChild as HTMLElement, {
      dataTransfer: {
        types: ["Files"],
        files: [new File(["x"], "fake.png", { type: "image/png" })],
      },
    });

    await waitFor(() => expect(getByText("Upload failed")).toBeTruthy());
    expect(api.uploadSessionFile).toHaveBeenCalledTimes(2);
  });

  it("explains an outdated remote agent instead of a bare upload failure", async () => {
    stubFakeWebSocket(true);
    vi.mocked(api.uploadSessionFile).mockReset();
    vi.mocked(api.uploadSessionFile).mockRejectedValue(
      new ApiError("agent too old — update it", 502, "UPLOAD_AGENT_OUTDATED"),
    );

    const { container, getByText } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    fireEvent.drop(container.firstElementChild as HTMLElement, {
      dataTransfer: {
        types: ["Files"],
        files: [new File(["x"], "a.pdf", { type: "application/pdf" })],
      },
    });

    await waitFor(() => expect(getByText("agent too old — update it")).toBeTruthy());
  });

  it("uploads at most 3 files at a time", async () => {
    stubFakeWebSocket(true);
    let inFlight = 0;
    let peak = 0;
    vi.mocked(api.uploadSessionFile).mockImplementation(async (_id, _blob, name) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { path: `/p/${name}` };
    });

    const { container } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    const files = Array.from({ length: 7 }, (_, i) => new File(["x"], `f${i}.txt`));
    fireEvent.drop(container.firstElementChild as HTMLElement, {
      dataTransfer: { types: ["Files"], files },
    });

    await waitFor(() => expect(api.uploadSessionFile).toHaveBeenCalledTimes(7));
    await waitFor(() => expect(getLatestTermInstance().paste).toHaveBeenCalled());
    expect(peak).toBe(3);
  });

  it("skips zero-size untyped entries when the browser has no webkitGetAsEntry", async () => {
    stubFakeWebSocket(true);
    vi.mocked(api.uploadSessionFile).mockResolvedValue({ path: "/cwd/.mullion-uploads/u/f.txt" });

    const { container } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    const folder = new File([], "folder", { type: "" });
    const file = new File(["y"], "f.txt", { type: "text/plain" });
    const item = (f: File) => ({ kind: "file", getAsFile: () => f });
    fireEvent.drop(container.firstElementChild as HTMLElement, {
      dataTransfer: { types: ["Files"], files: [folder, file], items: [item(folder), item(file)] },
    });

    await waitFor(() => expect(api.uploadSessionFile).toHaveBeenCalledTimes(1));
    expect(api.uploadSessionFile).toHaveBeenCalledWith(1, file, "f.txt");
  });

  it("keeps the uploading indicator on until every overlapping batch has settled, then reports a failure from any", async () => {
    stubFakeWebSocket(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gates: Array<(ok: boolean) => void> = [];
    vi.mocked(api.uploadSessionFile).mockImplementation(
      (_id, _blob, name) =>
        new Promise((resolve, reject) => {
          gates.push((ok) => (ok ? resolve({ path: `/p/${name}` }) : reject(new Error("boom"))));
        }),
    );

    const { container } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    const pane = container.firstElementChild as HTMLElement;
    const drop = (name: string) =>
      fireEvent.drop(pane, {
        dataTransfer: { types: ["Files"], files: [new File(["x"], name)] },
      });

    drop("one.txt");
    drop("two.txt");
    await waitFor(() => expect(gates).toHaveLength(2));
    expect(screen.getByText("Uploading…")).toBeInTheDocument();

    gates[0]!(false); // first batch fails while the second is still running
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(screen.getByText("Uploading…")).toBeInTheDocument();
    expect(screen.queryByText("Upload failed")).not.toBeInTheDocument();

    gates[1]!(true);
    await waitFor(() => expect(screen.getByText("Upload failed")).toBeInTheDocument());
    expect(getLatestTermInstance().paste).toHaveBeenCalledWith("/p/two.txt ");
    warn.mockRestore();
  });

  it("uploads only the first 20 files of a larger drop and says so", async () => {
    stubFakeWebSocket(true);
    vi.mocked(api.uploadSessionFile).mockImplementation(async (_id, _blob, name) => ({
      path: `/p/${name}`,
    }));

    const { container } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    const files = Array.from({ length: 25 }, (_, i) => new File(["x"], `f${i}.txt`));
    fireEvent.drop(container.firstElementChild as HTMLElement, {
      dataTransfer: { types: ["Files"], files },
    });

    await waitFor(() => expect(api.uploadSessionFile).toHaveBeenCalledTimes(20));
    expect(screen.getByText("5 file(s) over the per-drop limit skipped")).toBeInTheDocument();
  });

  it("stops adding files once a drop would exceed the total byte cap", async () => {
    stubFakeWebSocket(true);
    vi.mocked(api.uploadSessionFile).mockImplementation(async (_id, _blob, name) => ({
      path: `/p/${name}`,
    }));

    const { container } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    const big = (name: string) => {
      const f = new File(["x"], name);
      Object.defineProperty(f, "size", { value: 25 * 1024 * 1024 });
      return f;
    };
    fireEvent.drop(container.firstElementChild as HTMLElement, {
      dataTransfer: {
        types: ["Files"],
        files: ["a", "b", "c", "d", "e"].map((n) => big(`${n}.bin`)),
      },
    });

    await waitFor(() => expect(api.uploadSessionFile).toHaveBeenCalledTimes(4));
    expect(screen.getByText("1 file(s) over the per-drop limit skipped")).toBeInTheDocument();
  });

  it("skips only the file that busts the byte budget and keeps filling it", async () => {
    stubFakeWebSocket(true);
    vi.mocked(api.uploadSessionFile).mockImplementation(async (_id, _blob, name) => ({
      path: `/p/${name}`,
    }));

    const { container } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    const sized = (name: string, mb: number) => {
      const f = new File(["x"], name);
      Object.defineProperty(f, "size", { value: mb * 1024 * 1024 });
      return f;
    };
    fireEvent.drop(container.firstElementChild as HTMLElement, {
      dataTransfer: {
        types: ["Files"],
        files: [
          sized("a.bin", 25),
          sized("b.bin", 25),
          sized("c.bin", 25),
          sized("d.bin", 20),
          sized("e.bin", 25),
          sized("f.bin", 2),
        ],
      },
    });

    await waitFor(() => expect(api.uploadSessionFile).toHaveBeenCalledTimes(5));
    const names = vi.mocked(api.uploadSessionFile).mock.calls.map((c) => c[2]);
    expect(names).toEqual(["a.bin", "b.bin", "c.bin", "d.bin", "f.bin"]);
    expect(screen.getByText("1 file(s) over the per-drop limit skipped")).toBeInTheDocument();
  });

  it("skips a file over the per-file server limit up front and folds every skip into one notice", async () => {
    stubFakeWebSocket(true);
    vi.mocked(api.uploadSessionFile).mockResolvedValue({ path: "/p/ok.txt" });

    const { container } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    const huge = new File(["x"], "huge.bin");
    Object.defineProperty(huge, "size", { value: 30 * 1024 * 1024 });
    const ok = new File(["y"], "ok.txt", { type: "text/plain" });
    const entry = (isDirectory: boolean, f: File) => ({
      kind: "file",
      getAsFile: () => f,
      webkitGetAsEntry: () => ({ isDirectory }),
    });
    const dir = new File([], "folder");
    fireEvent.drop(container.firstElementChild as HTMLElement, {
      dataTransfer: {
        types: ["Files"],
        files: [dir, huge, ok],
        items: [entry(true, dir), entry(false, huge), entry(false, ok)],
      },
    });

    await waitFor(() => expect(api.uploadSessionFile).toHaveBeenCalledTimes(1));
    expect(api.uploadSessionFile).toHaveBeenCalledWith(1, ok, "ok.txt");
    expect(
      screen.getByText("1 folder(s)/empty file(s) skipped, 1 file(s) over 25 MB skipped"),
    ).toBeInTheDocument();
  });

  it("reports skipped folders in a notice", async () => {
    stubFakeWebSocket(true);
    vi.mocked(api.uploadSessionFile).mockResolvedValue({ path: "/p/f.txt" });

    const { container } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    const dir = new File([], "folder");
    const file = new File(["y"], "f.txt", { type: "text/plain" });
    const entry = (isDirectory: boolean, f: File) => ({
      kind: "file",
      getAsFile: () => f,
      webkitGetAsEntry: () => ({ isDirectory }),
    });
    fireEvent.drop(container.firstElementChild as HTMLElement, {
      dataTransfer: {
        types: ["Files"],
        files: [dir, file],
        items: [entry(true, dir), entry(false, file)],
      },
    });

    expect(await screen.findByText("1 folder(s)/empty file(s) skipped")).toBeInTheDocument();
  });

  it("clears the uploading indicator when building a request throws synchronously", async () => {
    stubFakeWebSocket(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(api.uploadSessionFile).mockImplementation(() => {
      throw new URIError("URI malformed");
    });

    const { container } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    fireEvent.drop(container.firstElementChild as HTMLElement, {
      dataTransfer: { types: ["Files"], files: [new File(["x"], "bad.txt")] },
    });

    expect(await screen.findByText("Upload failed")).toBeInTheDocument();
    expect(screen.queryByText("Uploading…")).not.toBeInTheDocument();
    warn.mockRestore();
  });

  it("skips dropped directories", async () => {
    stubFakeWebSocket(true);
    vi.mocked(api.uploadSessionFile).mockResolvedValue({ path: "/cwd/.mullion-uploads/u/f.txt" });

    const { container } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    const dir = new File([], "folder", { type: "" });
    const file = new File(["y"], "f.txt", { type: "text/plain" });
    const entry = (isDirectory: boolean, f: File) => ({
      kind: "file",
      getAsFile: () => f,
      webkitGetAsEntry: () => ({ isDirectory }),
    });
    // A string item (e.g. text/uri-list) sits first and must not shift indexes.
    const str = { kind: "string", getAsFile: () => null };
    fireEvent.drop(container.firstElementChild as HTMLElement, {
      dataTransfer: {
        types: ["Files"],
        files: [dir, file],
        items: [str, entry(true, dir), entry(false, file)],
      },
    });

    await waitFor(() => expect(api.uploadSessionFile).toHaveBeenCalledTimes(1));
    expect(api.uploadSessionFile).toHaveBeenCalledWith(1, file, "f.txt");
  });

  it("swallows file drops (no navigation) but never uploads when inputAffordances is false", async () => {
    stubFakeWebSocket(true);
    const { container } = renderPane({ inputAffordances: false });
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    const img = new File(["fake"], "photo.png", { type: "image/png" });
    const notPrevented = fireEvent.drop(container.firstElementChild as HTMLElement, {
      dataTransfer: { types: ["Files"], files: [img] },
    });
    expect(notPrevented).toBe(false);
    expect(api.uploadSessionFile).not.toHaveBeenCalled();
    expect(screen.queryByText("Drop files to attach")).not.toBeInTheDocument();
  });

  it("ignores non-file drags", async () => {
    stubFakeWebSocket(true);
    const { container } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    fireEvent.dragEnter(container.firstElementChild as HTMLElement, {
      dataTransfer: { types: ["text/plain"], files: [] },
    });
    expect(screen.queryByText("Drop files to attach")).not.toBeInTheDocument();
  });

  it("shows an error toast when the upload fails", async () => {
    stubFakeWebSocket(true);
    vi.mocked(api.uploadSessionFile).mockRejectedValue(new Error("network error"));

    const { container, getByText } = renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["fake"], "photo.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(getByText("Upload failed")).toBeTruthy());
  });
});
