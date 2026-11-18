// @vitest-environment jsdom
// The wrap-aware link provider and the file-path link provider:
// registration/disposal, the shared activate/hover/leave policy, and the
// linkHandler option OSC 8 hyperlinks go through.
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

import { screen } from "@testing-library/react";
import { act } from "react";
import {
  renderPane,
  stubFakeWebSocket,
  getLatestTermInstance,
  getLatestTermConstructorOptions,
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

// Wrap-aware link provider (lib/terminalLinks.ts), replacing
// @xterm/addon-web-links — the joining/matching logic itself is covered by
// that module's own terminalLinks.test.ts (fake buffers) and
// terminalLinks.xterm.test.ts (real Terminal, real captured bytes); these
// tests only cover the wiring TerminalPane.tsx owns: registration/disposal,
// the shared activate/hover/leave policy, and the linkHandler option OSC 8
// hyperlinks go through.
describe("TerminalPane wrap-aware link provider", () => {
  it("registers exactly one link provider on mount and disposes it on unmount", () => {
    stubFakeWebSocket(true);
    const { unmount } = renderPane();

    const term = getLatestTermInstance() as unknown as {
      registerLinkProvider: ReturnType<typeof vi.fn>;
    };
    expect(term.registerLinkProvider).toHaveBeenCalledTimes(1);
    const providerSub = term.registerLinkProvider.mock.results[0]!.value as {
      dispose: ReturnType<typeof vi.fn>;
    };
    expect(providerSub.dispose).not.toHaveBeenCalled();

    unmount();

    expect(providerSub.dispose).toHaveBeenCalledTimes(1);
  });

  it("passes a linkHandler with activate/hover/leave and allowNonHttpProtocols: false", () => {
    stubFakeWebSocket(true);
    renderPane();

    const options = getLatestTermConstructorOptions();
    expect(options.linkHandler.activate).toBeInstanceOf(Function);
    expect(options.linkHandler.hover).toBeInstanceOf(Function);
    expect(options.linkHandler.leave).toBeInstanceOf(Function);
    expect(options.linkHandler.allowNonHttpProtocols).toBe(false);
  });

  // OSC 8 hyperlinks let the emitting process set the displayed text
  // independently of the real href (a known terminal phishing vector) —
  // unlike our own provider's links, where the matched text IS the href by
  // construction. xterm's own default OSC 8 handler gates activation behind
  // a confirm() naming the real destination for exactly this reason; a
  // custom `linkHandler` replaces that default entirely, so this repo's own
  // activate must keep gating it rather than silently dropping the check.
  it("activate confirms before opening an OSC 8 link, and refuses an unsafe scheme without even asking", () => {
    stubFakeWebSocket(true);
    renderPane();
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const options = getLatestTermConstructorOptions();
    const fakeEvent = {} as MouseEvent;

    options.linkHandler.activate(fakeEvent, "https://example.com/pull/1234");
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringContaining("https://example.com/pull/1234"),
    );
    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com/pull/1234",
      "_blank",
      "noopener,noreferrer",
    );

    openSpy.mockClear();
    confirmSpy.mockClear();
    confirmSpy.mockReturnValue(false);
    options.linkHandler.activate(fakeEvent, "https://example.com/declined");
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).not.toHaveBeenCalled();

    openSpy.mockClear();
    confirmSpy.mockClear();
    options.linkHandler.activate(fakeEvent, "javascript:alert(1)");
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();

    openSpy.mockRestore();
    confirmSpy.mockRestore();
  });

  // Distinct from the OSC 8 case above: this repo's own provider's links
  // never need a confirm — the hover tooltip already discloses exactly what
  // a click opens, since the matched `text` IS the href. Also exercises the
  // provideLinks wiring end-to-end (0-indexed buffer row -> 1-indexed
  // bufferLineNumber, 0-indexed startCol/endCol -> xterm's ILink range
  // convention), which the tests above never touch — none of them go
  // through registerLinkProvider's own captured callback.
  it("provideLinks maps a computed link into xterm's ILink range and its activate skips the confirm", () => {
    stubFakeWebSocket(true);
    renderPane();
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const term = getLatestTermInstance() as unknown as {
      registerLinkProvider: ReturnType<typeof vi.fn>;
      buffer: { active: { getLine: ReturnType<typeof vi.fn> } };
    };
    const provider = term.registerLinkProvider.mock.calls[0]![0] as {
      provideLinks: (
        bufferLineNumber: number,
        callback: (
          links:
            | {
                range: { start: { x: number; y: number }; end: { x: number; y: number } };
                text: string;
                activate: (e: MouseEvent, t: string) => void;
              }[]
            | undefined,
        ) => void,
      ) => void;
    };

    const rowText = "see https://example.com/foo";
    const fakeLine = {
      isWrapped: false,
      length: rowText.length,
      translateToString: () => rowText,
      getCell: (x: number) => (x < rowText.length ? { getChars: () => rowText[x] } : undefined),
    };
    // Buffer row 4 (0-indexed) == bufferLineNumber 5 (1-indexed, xterm's own
    // provideLinks convention) — this mismatch is exactly what the `- 1`
    // conversion in TerminalPane.tsx's provideLinks exists to bridge.
    term.buffer.active.getLine.mockImplementation((y: number) => (y === 4 ? fakeLine : undefined));

    let links: {
      range: { start: { x: number; y: number }; end: { x: number; y: number } };
      text: string;
      activate: (e: MouseEvent, t: string) => void;
    }[] = [];
    provider.provideLinks(5, (result) => {
      links = result ?? [];
    });

    expect(links).toHaveLength(1);
    expect(links[0]!.text).toBe("https://example.com/foo");
    // 0-indexed startCol 4 ("https" starts right after "see ") -> 1-indexed
    // start.x 5; 0-indexed exclusive endCol 27 (rowText.length, the match
    // runs to the row's end) used as-is for end.x, matching the addon's own
    // convention (see terminalLinks.ts's ComputedLink doc comment).
    expect(links[0]!.range).toEqual({ start: { x: 5, y: 5 }, end: { x: 27, y: 5 } });

    links[0]!.activate({} as MouseEvent, links[0]!.text);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com/foo",
      "_blank",
      "noopener,noreferrer",
    );

    openSpy.mockRestore();
    confirmSpy.mockRestore();
  });

  it("hover shows the tooltip and leave clears it", () => {
    stubFakeWebSocket(true);
    renderPane();

    const options = getLatestTermConstructorOptions();
    const fakeEvent = { clientX: 40, clientY: 20 } as MouseEvent;

    expect(screen.queryByText("https://example.com/pull/1234")).not.toBeInTheDocument();

    act(() => {
      options.linkHandler.hover(fakeEvent, "https://example.com/pull/1234", {
        start: { y: 3 },
        end: { y: 4 },
      });
    });
    expect(screen.getByText("https://example.com/pull/1234")).toBeInTheDocument();
    expect(screen.getByText(/joined across 2 rows/)).toBeInTheDocument();

    act(() => {
      options.linkHandler.leave(fakeEvent, "https://example.com/pull/1234", {});
    });
    expect(screen.queryByText("https://example.com/pull/1234")).not.toBeInTheDocument();
  });
});

// File-path links (lib/terminalPathLinks.ts) — the matching itself is covered
// by that module's own tests; these cover TerminalPane's wiring: the provider
// exists only when a handler is passed, activation needs a modifier (or a
// coarse pointer), and the handler gets the path + line as printed.
describe("TerminalPane file-path link provider", () => {
  type PathProvider = {
    provideLinks: (
      n: number,
      cb: (
        links:
          | {
              range: { start: { x: number; y: number }; end: { x: number; y: number } };
              text: string;
              activate: (e: MouseEvent) => void;
              hover: (e: MouseEvent) => void;
              leave: () => void;
            }[]
          | undefined,
      ) => void,
    ) => void;
  };

  function pathProvider(rowText: string | undefined) {
    const term = getLatestTermInstance() as unknown as {
      registerLinkProvider: ReturnType<typeof vi.fn>;
      buffer: { active: { getLine: ReturnType<typeof vi.fn> } };
    };
    if (rowText !== undefined) {
      const fakeLine = {
        isWrapped: false,
        length: rowText.length,
        translateToString: () => rowText,
        getCell: (x: number) => (x < rowText.length ? { getChars: () => rowText[x] } : undefined),
      };
      term.buffer.active.getLine.mockImplementation((y: number) =>
        y === 0 ? fakeLine : undefined,
      );
    }
    return term.registerLinkProvider.mock.calls[1]![0] as PathProvider;
  }

  it("registers no path provider without onOpenFile, and disposes it on unmount with one", () => {
    stubFakeWebSocket(true);
    const bare = renderPane();
    expect(
      (getLatestTermInstance() as unknown as { registerLinkProvider: ReturnType<typeof vi.fn> })
        .registerLinkProvider,
    ).toHaveBeenCalledTimes(1);
    bare.unmount();

    const { unmount } = renderPane({ onOpenFile: vi.fn() });
    const term = getLatestTermInstance() as unknown as {
      registerLinkProvider: ReturnType<typeof vi.fn>;
    };
    expect(term.registerLinkProvider).toHaveBeenCalledTimes(2);
    const sub = term.registerLinkProvider.mock.results[1]!.value as {
      dispose: ReturnType<typeof vi.fn>;
    };
    unmount();
    expect(sub.dispose).toHaveBeenCalledTimes(1);
  });

  it("maps a path to an ILink range and opens it on Ctrl/Cmd-click only", () => {
    stubFakeWebSocket(true);
    const onOpenFile = vi.fn();
    renderPane({ onOpenFile });
    const provider = pathProvider("fail at src/app.ts:42:7");

    let links: Parameters<Parameters<PathProvider["provideLinks"]>[1]>[0] = [];
    provider.provideLinks(1, (result) => {
      links = result;
    });
    expect(links).toHaveLength(1);
    expect(links![0].text).toBe("src/app.ts:42:7");
    expect(links![0].range).toEqual({ start: { x: 9, y: 1 }, end: { x: 23, y: 1 } });

    links![0].activate({ ctrlKey: false, metaKey: false } as MouseEvent);
    expect(onOpenFile).not.toHaveBeenCalled();
    links![0].activate({ ctrlKey: true } as MouseEvent);
    expect(onOpenFile).toHaveBeenLastCalledWith("src/app.ts", 42);
    links![0].activate({ metaKey: true } as MouseEvent);
    expect(onOpenFile).toHaveBeenCalledTimes(2);
  });

  it("shows a Ctrl+click hint tooltip on hover and clears it on leave", () => {
    stubFakeWebSocket(true);
    renderPane({ onOpenFile: vi.fn() });
    const provider = pathProvider("see .env");
    let links: Parameters<Parameters<PathProvider["provideLinks"]>[1]>[0] = [];
    provider.provideLinks(1, (result) => {
      links = result;
    });
    act(() => links![0].hover({ clientX: 10, clientY: 10 } as MouseEvent));
    expect(screen.getByText("Ctrl+click to edit .env")).toBeInTheDocument();
    act(() => links![0].leave());
    expect(screen.queryByText("Ctrl+click to edit .env")).not.toBeInTheDocument();
  });

  it("returns no links for a row with no paths, or when the handler is gone", () => {
    stubFakeWebSocket(true);
    renderPane({ onOpenFile: vi.fn() });
    const provider = pathProvider("nothing to see here");
    let links: Parameters<Parameters<PathProvider["provideLinks"]>[1]>[0] = [{} as never];
    provider.provideLinks(1, (result) => {
      links = result;
    });
    expect(links).toEqual([]);
  });
});
