// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { CodeEditor } from "./CodeEditor.js";
import { languageForFile } from "../lib/editorLanguage.js";

function viewOf(container: HTMLElement): EditorView {
  const dom = container.querySelector(".cm-editor") as HTMLElement;
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error("no CodeMirror view mounted");
  return view;
}

describe("CodeEditor (real CodeMirror)", () => {
  it("mounts with the initial value and an accessible label", () => {
    const { container, getByLabelText } = render(
      <CodeEditor value="A=1" fileName=".env" ariaLabel="Editing .env" />,
    );
    expect(viewOf(container).state.doc.toString()).toBe("A=1");
    expect(getByLabelText("Editing .env")).toBeInTheDocument();
  });

  it("reports edits through onChange", () => {
    const onChange = vi.fn();
    const { container } = render(<CodeEditor value="" onChange={onChange} fileName="a.txt" />);
    viewOf(container).dispatch({ changes: { from: 0, insert: "hello" } });
    expect(onChange).toHaveBeenCalledWith("hello");
  });

  it("replaces the doc when the value prop changes externally, without echoing a no-op", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<CodeEditor value="one" onChange={onChange} />);
    rerender(<CodeEditor value="two" onChange={onChange} />);
    expect(viewOf(container).state.doc.toString()).toBe("two");
    // the programmatic replace is itself a doc change; an identical value is not
    onChange.mockClear();
    rerender(<CodeEditor value="two" onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("toggles read-only", () => {
    const { container, rerender } = render(<CodeEditor value="x" />);
    expect(viewOf(container).state.readOnly).toBe(false);
    rerender(<CodeEditor value="x" readOnly />);
    expect(viewOf(container).state.readOnly).toBe(true);
  });

  it("fires onSave on Mod-s", () => {
    const onSave = vi.fn();
    const { container } = render(<CodeEditor value="x" onSave={onSave} />);
    const content = container.querySelector(".cm-content") as HTMLElement;
    content.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
    expect(onSave).toHaveBeenCalled();
  });

  it("destroys the view on unmount", () => {
    const { container, unmount } = render(<CodeEditor value="x" />);
    const view = viewOf(container);
    const destroy = vi.spyOn(view, "destroy");
    unmount();
    expect(destroy).toHaveBeenCalled();
  });
});

describe("languageForFile", () => {
  it("maps known names/extensions and leaves the rest as plain text", () => {
    for (const name of [
      ".env",
      ".env.local",
      "prod.env",
      "a.ini",
      "run.sh",
      "x.toml",
      "x.yaml",
      "x.yml",
      "x.json",
      "x.js",
      "x.tsx",
      "README.md",
      "dir/.env",
    ]) {
      expect(languageForFile(name), name).not.toBeNull();
    }
    expect(languageForFile("notes.txt")).toBeNull();
    expect(languageForFile("Makefile")).toBeNull();
  });
});
