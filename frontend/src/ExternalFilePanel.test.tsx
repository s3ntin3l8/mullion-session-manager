// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { ExternalFilePanel } from "./ExternalFilePanel.js";
import { jsonResponse } from "./test/jsonResponse.js";

// CodeMirror is exercised for real in components/CodeEditor.test.tsx.
vi.mock("./components/CodeEditor.js", () => ({
  CodeEditor: ({
    value,
    readOnly,
    revealLine,
    fileName,
  }: {
    value: string;
    readOnly?: boolean;
    revealLine?: { line: number; token: number };
    fileName?: string;
  }) => (
    <textarea
      aria-label={`viewer:${fileName}`}
      data-readonly={String(!!readOnly)}
      data-reveal-line={revealLine?.line ?? ""}
      value={value}
      readOnly
    />
  ),
}));

afterEach(() => vi.unstubAllGlobals());

function stubFetch(respond: (url: string) => Response) {
  const fn = vi.fn((input: RequestInfo | URL) => Promise.resolve(respond(String(input))));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("ExternalFilePanel", () => {
  it("opens params.path read-only and passes the line through", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse(200, { path: "p.md", content: "# plan", size: 6, mtimeMs: 1 }),
    );
    render(<ExternalFilePanel params={{ projectId: 3, path: "~/.claude/plans/p.md", line: 9 }} />);
    const viewer = await screen.findByLabelText("viewer:~/.claude/plans/p.md");
    expect(viewer).toHaveProperty("value", "# plan");
    expect(viewer.getAttribute("data-readonly")).toBe("true");
    expect(viewer.getAttribute("data-reveal-line")).toBe("9");
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/api/projects/3/external-file?path=");
    expect(decodeURIComponent(url)).toContain("~/.claude/plans/p.md");
  });

  it("explains a not_allowlisted refusal", async () => {
    stubFetch(() => jsonResponse(403, { message: "nope", code: "not_allowlisted" }));
    render(<ExternalFilePanel params={{ projectId: 3, path: "~/.ssh/id_ed25519" }} />);
    expect(await screen.findByText(/isn't in a readable folder/)).toBeTruthy();
  });

  it("opens a pasted, line-wrapped path from the path bar", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse(200, { path: "plan.md", content: "x", size: 1, mtimeMs: 1 }),
    );
    render(<ExternalFilePanel params={{ projectId: 3 }} />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("File path"), {
      target: { value: "~/.minimax/v2/sessions/a\n  bc/plan.md" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(decodeURIComponent(String(fetchMock.mock.calls[0][0]))).toContain(
      "~/.minimax/v2/sessions/abc/plan.md",
    );
    expect(await screen.findByLabelText("viewer:~/.minimax/v2/sessions/abc/plan.md")).toBeTruthy();
  });

  it("maps a non-API failure to a generic note", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    render(<ExternalFilePanel params={{ projectId: 3, path: "/x/y.md" }} />);
    expect(await screen.findByText("Couldn't open /x/y.md")).toBeTruthy();
  });
});
