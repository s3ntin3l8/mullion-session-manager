// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ts from "typescript";
import { Dropdown, NumberField, Row, Segmented, Slider, Toggle } from "./primitives.js";

// Accessible names for the Settings controls.
//
// Every control in the Settings modal was visually labelled but
// programmatically anonymous: `Row` rendered its label as a plain <div>, so
// a screen reader heard 32 identical "toggle" buttons, 28 identical "combo
// boxes", 8 identical "radio" groups and 17 identical "spin buttons" with
// no way to tell which setting each one belonged to.
//
// `Row` now publishes its label through a context, and the controls read it.
// The two halves are covered here: the unit tests below pin the mechanism
// itself, and the static sweep at the bottom proves no call site in the
// Settings tree is left without a name — the sweep is the enforcement
// mechanism, because a control outside a Row gets no context and would
// otherwise regress silently.

type TagUse = { name: string; line: number; hasAriaLabel: boolean; ancestors: string[] };

/**
 * Every JSX element use in a file, with the chain of component names above
 * it.
 *
 * Parsed with the TypeScript compiler rather than by hand: a hand-rolled
 * scanner has to guess where a JSX tag ends, and one mis-parse (a `<` inside
 * a JS expression, a `>` inside an attribute string) silently corrupts the
 * element nesting for the rest of the file — which is how a sweep like this
 * ends up reporting a control that is in fact inside a Row.
 */
function scanTags(file: string, src: string): TagUse[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const uses: TagUse[] = [];

  const visit = (node: ts.Node, ancestors: string[]) => {
    if (ts.isJsxElement(node)) {
      const name = jsxName(node.openingElement);
      if (name) {
        let hasAriaLabel = false;
        for (const prop of node.openingElement.attributes.properties) {
          if (
            ts.isJsxAttribute(prop) &&
            ts.isIdentifier(prop.name) &&
            prop.name.text === "ariaLabel"
          ) {
            hasAriaLabel = true;
          }
        }
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        uses.push({ name, line: line + 1, hasAriaLabel, ancestors });
      }
      ts.forEachChild(node, (child) => visit(child, name ? [...ancestors, name] : ancestors));
      return;
    }
    if (ts.isJsxSelfClosingElement(node)) {
      const name = jsxName(node);
      if (name) {
        let hasAriaLabel = false;
        for (const prop of node.attributes.properties) {
          if (
            ts.isJsxAttribute(prop) &&
            ts.isIdentifier(prop.name) &&
            prop.name.text === "ariaLabel"
          ) {
            hasAriaLabel = true;
          }
        }
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        uses.push({ name, line: line + 1, hasAriaLabel, ancestors });
      }
      return;
    }
    // A component's own body is a separate AST subtree, so the JSX inside
    // `function CooldownField() { return <NumberField ... /> }` has no
    // JSX ancestor naming CooldownField. Model the component boundary
    // explicitly, or a control that a helper renders would look
    // unnested when it is in fact inside a Row.
    if (ts.isFunctionDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text)) {
      const next = [...ancestors, node.name.text];
      ts.forEachChild(node, (child) => visit(child, next));
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      /^[A-Z]/.test(node.name.text)
    ) {
      const init = node.initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        const next = [...ancestors, node.name.text];
        ts.forEachChild(init, (child) => visit(child, next));
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, ancestors));
  };

  visit(sf, []);
  return uses;
}

function jsxName(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string | null {
  const tag = node.tagName;
  if (ts.isIdentifier(tag)) return tag.text;
  if (ts.isPropertyAccessExpression(tag)) return tag.name.text;
  return null;
}

// The Settings tree, read as source.
//
// import.meta.glob (rather than node:fs) keeps this file within
// tsconfig.app.json's browser-only type universe — no other src/ file
// imports "node:*" modules, since that tsconfig deliberately omits Node's
// global types (see tsconfig.node.json's contrasting "types": ["node"],
// reserved for vite.config.ts). Same pattern as pwaSplashScreens.test.ts.
const settingsSources = import.meta.glob("../settings/**/*.tsx", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const CONTROL_NAMES = ["Toggle", "Dropdown", "Segmented", "Slider", "NumberField"];

/** The Settings source files, minus the test files themselves. */
function settingsSourceFiles(): Array<[string, string]> {
  return Object.entries(settingsSources).filter(
    ([filePath]) => filePath.endsWith(".tsx") && !filePath.includes(".test."),
  );
}

/**
 * Which custom components are rendered inside a `Row` somewhere in the
 * Settings tree.
 *
 * A control can sit inside a Row without the `Row` appearing in its own
 * JSX ancestry — `<Row label="Cooldown"><CooldownField /></Row>` puts the
 * Row's context two component boundaries away from the `NumberField` that
 * `CooldownField` renders. React context flows through those boundaries, so
 * the control IS named; a scanner that only looked at JSX ancestry would
 * report a false positive.
 *
 * This resolves that by collecting every component name that is used
 * somewhere with a `Row` in its ancestry, then treating any control
 * underneath one of those components as row-provided. That is an
 * over-approximation (a component used inside a Row in one place and
 * outside a Row in another counts as row-provided everywhere), which is the
 * safe direction to err in: it can hide a gap, never invent one.
 */
function componentsProvidedByARow(files: Array<[string, string]>): Set<string> {
  const provided = new Set<string>();
  for (const [filePath, src] of files) {
    const uses = scanTags(filePath, src);
    for (const use of uses) {
      if (!/^[A-Z]/.test(use.name)) continue;
      if (CONTROL_NAMES.includes(use.name)) continue;
      if (use.ancestors.includes("Row")) provided.add(use.name);
    }
  }
  return provided;
}

describe("Settings primitives — accessible names", () => {
  it("names a Toggle from its Row's visible label", () => {
    render(
      <Row label="Show exited &amp; killed sessions" desc="Keep ended sessions visible.">
        <Toggle on={false} onChange={() => {}} />
      </Row>,
    );
    expect(
      screen.getByRole("button", { name: "Show exited & killed sessions" }),
    ).toBeInTheDocument();
  });

  it("names a Dropdown from its Row's visible label", () => {
    render(
      <Row label="Default shell">
        <Dropdown options={[{ value: "bash", label: "bash" }]} value="bash" onChange={() => {}} />
      </Row>,
    );
    expect(screen.getByRole("combobox", { name: "Default shell" })).toBeInTheDocument();
  });

  it("names a Slider from its Row's visible label and exposes a formatted value", () => {
    render(
      <Row label="Terminal font size">
        <Slider min={8} max={20} value={12} onChange={() => {}} format={(v) => `${v} px`} />
      </Row>,
    );
    const slider = screen.getByRole("slider", { name: "Terminal font size" });
    expect(slider).toHaveAttribute("aria-valuetext", "12 px");
    // The bubble restates the value visually; announcing it twice is noise.
    expect(document.querySelector(".settings-slider-bubble")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("names a NumberField from its Row's visible label and carries the unit", () => {
    render(
      <Row label="Scrollback lines">
        <NumberField value={1000} onChange={() => {}} suffix=" lines" />
      </Row>,
    );
    const field = screen.getByRole("spinbutton", { name: "Scrollback lines" });
    expect(field).toHaveAttribute("aria-valuetext", "1000 lines");
  });

  it("prefers an explicit ariaLabel over the visible label", () => {
    render(
      <Row label="Ctrl + R" desc="Reverse search" ariaLabel="Reverse search (Ctrl + R)">
        <Toggle on={false} onChange={() => {}} />
      </Row>,
    );
    expect(screen.getByRole("button", { name: "Reverse search (Ctrl + R)" })).toBeInTheDocument();
  });

  it("derives the name from a JSX label", () => {
    render(
      <Row label={<span className="settings-kbd-chip">Ctrl + K</span>}>
        <Toggle on={false} onChange={() => {}} />
      </Row>,
    );
    expect(screen.getByRole("button", { name: "Ctrl + K" })).toBeInTheDocument();
  });

  it("lets a control's own ariaLabel win over the Row's", () => {
    render(
      <Row label="Row label">
        <Toggle on={false} onChange={() => {}} ariaLabel="Explicit name" />
      </Row>,
    );
    expect(screen.getByRole("button", { name: "Explicit name" })).toBeInTheDocument();
  });
});

describe("Segmented — radio group semantics", () => {
  const options = [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
    { value: "c", label: "C" },
  ];

  it("exposes a named radio group with the selection marked", () => {
    render(
      <Row label="Theme">
        <Segmented options={options} value="b" onChange={() => {}} />
      </Row>,
    );
    const group = screen.getByRole("radiogroup", { name: "Theme" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "B" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "A" })).toHaveAttribute("aria-checked", "false");
  });

  it("keeps a single tab stop for the group and moves selection with the arrow keys", async () => {
    const user = userEvent.setup();
    const changes: string[] = [];
    render(
      <Row label="Theme">
        <Segmented options={options} value="a" onChange={(v) => changes.push(v)} />
      </Row>,
    );

    const selected = screen.getByRole("radio", { name: "A" });
    const others = [
      screen.getByRole("radio", { name: "B" }),
      screen.getByRole("radio", { name: "C" }),
    ];

    // Roving tabindex: only the checked radio is in the tab order.
    expect(selected).toHaveAttribute("tabindex", "0");
    for (const other of others) expect(other).toHaveAttribute("tabindex", "-1");

    selected.focus();
    await user.keyboard("{ArrowRight}");
    expect(changes).toEqual(["b"]);
    // Arrow keys move focus with the selection.
    expect(screen.getByRole("radio", { name: "B" })).toHaveFocus();

    await user.keyboard("{ArrowLeft}");
    expect(changes).toEqual(["b", "a"]);

    await user.keyboard("{End}");
    expect(changes).toEqual(["b", "a", "c"]);
    expect(screen.getByRole("radio", { name: "C" })).toHaveFocus();

    await user.keyboard("{Home}");
    expect(changes).toEqual(["b", "a", "c", "a"]);
    expect(screen.getByRole("radio", { name: "A" })).toHaveFocus();
  });

  it("wraps around at the ends of the group", async () => {
    const user = userEvent.setup();
    const changes: string[] = [];
    render(
      <Row label="Theme">
        <Segmented options={options} value="c" onChange={(v) => changes.push(v)} />
      </Row>,
    );
    screen.getByRole("radio", { name: "C" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(changes).toEqual(["a"]);
  });
});

describe("Settings tree — no control is left without a name", () => {
  it("every Toggle/Dropdown/Segmented/Slider/NumberField is inside a Row or names itself", () => {
    const files = settingsSourceFiles();
    const rowProvided = componentsProvidedByARow(files);
    const offenders: string[] = [];
    for (const [filePath, src] of files) {
      const uses = scanTags(filePath, src);
      for (const use of uses) {
        if (!CONTROL_NAMES.includes(use.name)) continue;
        // A control inside a Row inherits its name from the Row's context —
        // directly, or through a helper component that is itself rendered
        // inside a Row.
        if (use.ancestors.includes("Row")) continue;
        if (use.ancestors.some((a) => rowProvided.has(a))) continue;
        // Otherwise it must name itself.
        if (use.hasAriaLabel) continue;
        offenders.push(
          `${filePath.replace(/.*frontend\//, "frontend/")}:${use.line} <${use.name}>`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
