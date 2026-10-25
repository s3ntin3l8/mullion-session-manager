// scripts/check-token-contrast.mjs is the guard that stops the token
// palette's ROLE split from quietly regressing: the audit found that
// `--dim` was used as a text colour in 182 places and as a fill behind
// white text in others, and that no single value satisfies both roles — so
// the palette now carries `--accent-fill` and `--badge-dim` for the
// white-on-fill job.
//
// The guard's own matcher is the weak point. It was `/color\s*:\s*(#fff|
// white)\b/`, which silently accepted `#ffffff` (no word boundary between
// `fff` and `fff`) and `#FFF` (no `i` flag) — so two of the commonest
// spellings of white slipped past it while the stylesheets happened to use
// `#fff`. A guard that only catches the spelling in use today is not a
// guard.
//
// So this suite drives the real script against fixture trees (precedent:
// test/scripts/check-case-collision.test.ts, which drives its script
// through execFile the same way) and pins every spelling of white it must
// catch — and the ones it must NOT catch, because a false positive here
// would fail the lint step on a perfectly legal rule.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = path.join(REPO_ROOT, "scripts", "check-token-contrast.mjs");
const REAL_TOKENS = path.join(REPO_ROOT, "frontend", "src", "styles", "tokens.css");

describe("check-token-contrast.mjs", () => {
  let root: string;
  let stylesDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "token-contrast-test-"));
    stylesDir = path.join(root, "frontend", "src", "styles");
    fs.mkdirSync(stylesDir, { recursive: true });
    // The real token file — the fixture only has to differ in the
    // STYLESHEET, and using the real tokens means the token-contrast half
    // of the check is genuinely exercised rather than stubbed.
    fs.copyFileSync(REAL_TOKENS, path.join(stylesDir, "tokens.css"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeStylesheet(name: string, body: string): void {
    fs.writeFileSync(path.join(stylesDir, name), body);
  }

  async function run(): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, root]);
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  // Every spelling of white the matcher has to catch. Each one is white
  // text on `--accent-solid`, which is a TEXT-role token — the exact
  // regression the role split exists to prevent.
  for (const [description, value] of [
    ["the 3-digit hex", "#fff"],
    ["the 4-digit hex", "#ffff"],
    ["the 6-digit hex", "#ffffff"],
    ["an uppercase 3-digit hex", "#FFF"],
    ["an uppercase 6-digit hex", "#FFFFFF"],
    ["the 8-digit hex with alpha", "#ffffffff"],
    ["the keyword", "white"],
    ["an uppercase keyword", "WHITE"],
    ["rgb() with commas", "rgb(255, 255, 255)"],
    ["rgb() without commas", "rgb(255 255 255)"],
    ["rgba() with alpha", "rgba(255, 255, 255, 0.9)"],
  ] as const) {
    it(`catches white written as ${description}`, async () => {
      writeStylesheet("probe.css", `.probe { color: ${value}; background: var(--accent-solid); }`);
      const result = await run();
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("puts white text on var(--accent-solid)");
    });
  }

  // A colour that is NOT white must not trip the guard — a false positive
  // here would fail `npm run lint` on a legal rule.
  //
  // `#fff0` is the interesting one: 4-digit hex is #RGBA, so `#ffff` is
  // opaque white and `#fff0` is the same white at zero alpha — which is
  // not white text on anything. Both are pinned, one on each side.
  for (const [description, value] of [
    ["yellow", "#ffff00"],
    ["a near-white grey", "#f8f8f8"],
    ["a short hex", "#fff0"],
    ["a red", "#ff0000"],
    ["a non-white rgb()", "rgb(254, 255, 255)"],
  ] as const) {
    it(`does not mistake ${description} for white`, async () => {
      writeStylesheet("probe.css", `.probe { color: ${value}; background: var(--accent-solid); }`);
      const result = await run();
      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain("puts white text");
    });
  }

  it("passes when white sits on a fill-role token", async () => {
    writeStylesheet("probe.css", ".probe { color: #ffffff; background: var(--accent-fill); }");
    const result = await run();
    expect(result.code).toBe(0);
  });

  it("passes on a stylesheet with no white text at all", async () => {
    writeStylesheet("probe.css", ".probe { color: var(--fg); background: var(--chrome); }");
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("every design token clears its WCAG contrast threshold");
  });

  // The token-contrast half of the check must still work — the fixture
  // uses the real tokens.css, so a regression in a token VALUE is caught
  // even though the fixture's own stylesheet is innocent.
  it("still fails when a token value regresses", async () => {
    const tokens = fs.readFileSync(REAL_TOKENS, "utf8");
    // --dim is the token the audit found failing AA in both themes.
    const regressed = tokens.replace(/--dim:\s*#[0-9a-fA-F]{3,8}/, "--dim: #666670");
    fs.writeFileSync(path.join(stylesDir, "tokens.css"), regressed);
    const result = await run();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--dim");
  });
});
