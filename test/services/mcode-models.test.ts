import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listMcodeModels,
  parseMcodeModelCatalog,
  resetMcodeModelsCache,
  resolveMcodeConfigPath,
} from "../../src/services/mcode-models.js";

// Issue #1784 — mcode's model catalog.
//
// The catalog is read from mcode's own `config.yaml` rather than from
// `mcode provider list --json`, because mcode hardcodes `models: []` for both
// of its own MiniMax providers (verified against mcode 0.6.13) — that command
// answers `[]` for exactly the models a user wants to pick.

const STOCK_CONFIG = `
logLevel: info
defaultModel: minimax/MiniMax-M3.1-Flash
provider:
  minimax:
    models:
      MiniMax-M3:
        name: "M3"
        contextLimit: 204800
      MiniMax-M3.1-Flash:
        name: "M3.1-Flash (Free)"
        contextLimit: 204800
    model_order:
      - MiniMax-M3.1-Flash
      - MiniMax-M3
    whitelist:
      - MiniMax-M3
      - MiniMax-M3.1-Flash
`;

/** A temp data dir with a `config.yaml` in it. */
function makeDataDir(config?: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mullion-mcode-models-"));
  if (config !== undefined) writeFileSync(path.join(dir, "config.yaml"), config);
  return dir;
}

/** Rewrites a file and pushes its mtime forward, so an mtime-based
 * invalidation is observed even on a filesystem with coarse timestamps. */
function rewriteWithNewerMtime(filePath: string, contents: string): void {
  writeFileSync(filePath, contents);
  const future = new Date(Date.now() + 10_000);
  utimesSync(filePath, future, future);
}

describe("parseMcodeModelCatalog", () => {
  it("turns the provider's models map into provider/model ids", () => {
    expect(parseMcodeModelCatalog(STOCK_CONFIG)).toEqual([
      "minimax/MiniMax-M3.1-Flash",
      "minimax/MiniMax-M3",
    ]);
  });

  it("honours the provider's own model_order", () => {
    // The map's key order is M3 then M3.1-Flash; model_order puts the free
    // M3.1-Flash first, which is the order mcode's own picker uses.
    const config = `
provider:
  minimax:
    models:
      A-model: {}
      B-model: {}
      C-model: {}
    model_order:
      - C-model
      - B-model
`;
    expect(parseMcodeModelCatalog(config)).toEqual([
      "minimax/C-model",
      "minimax/B-model",
      "minimax/A-model",
    ]);
  });

  it("appends models the order does not mention, alphabetically", () => {
    const config = `
provider:
  minimax:
    models:
      Zebra: {}
      Apple: {}
      Mango: {}
    model_order:
      - Mango
`;
    expect(parseMcodeModelCatalog(config)).toEqual([
      "minimax/Mango",
      "minimax/Apple",
      "minimax/Zebra",
    ]);
  });

  it("restricts the catalog to the provider's whitelist", () => {
    const config = `
provider:
  minimax:
    models:
      Allowed: {}
      Blocked: {}
    whitelist:
      - Allowed
`;
    expect(parseMcodeModelCatalog(config)).toEqual(["minimax/Allowed"]);
  });

  // A whitelist is a filter Mullion does not own. A stock install lists BARE
  // model ids (verified against the host's own config.yaml), but a full
  // `provider/model` id or a glob must not silently filter out everything.
  it("accepts a whitelist entry that is a full provider/model id", () => {
    const config = `
provider:
  minimax:
    models:
      Allowed: {}
      Blocked: {}
    whitelist:
      - minimax/Allowed
`;
    expect(parseMcodeModelCatalog(config)).toEqual(["minimax/Allowed"]);
  });

  it("accepts a whitelist entry that is a glob", () => {
    const config = `
provider:
  minimax:
    models:
      MiniMax-M3: {}
      MiniMax-M3.1-Flash: {}
      Something-Else: {}
    whitelist:
      - "MiniMax-*"
`;
    expect(parseMcodeModelCatalog(config)).toEqual([
      "minimax/MiniMax-M3",
      "minimax/MiniMax-M3.1-Flash",
    ]);
  });

  it("IGNORES a whitelist that matches nothing, rather than emptying the catalog", () => {
    // The failure mode this guards: a whitelist in a shape this service does
    // not understand would filter out every model, leaving the picker empty —
    // worse than not applying it at all.
    const config = `
provider:
  minimax:
    models:
      Allowed: {}
    whitelist:
      - "some-shape-we-do-not-understand"
`;
    expect(parseMcodeModelCatalog(config)).toEqual(["minimax/Allowed"]);
  });

  it("REPORTS a whitelist it had to ignore", () => {
    // The same situation is also what a typo'd or not-yet-populated
    // whitelist looks like, so the dropped entries must be reportable.
    const config = `
provider:
  minimax:
    models:
      Allowed: {}
    whitelist:
      - "MiniMax-M4"
      - "MiniMax-M5"
`;
    const diagnostics = { ignoredWhitelists: [] };
    expect(parseMcodeModelCatalog(config, diagnostics)).toEqual(["minimax/Allowed"]);
    expect(diagnostics.ignoredWhitelists).toEqual([
      { providerId: "minimax", entries: ["MiniMax-M4", "MiniMax-M5"] },
    ]);
  });

  it("reads the custom_provider subtree too", () => {
    const config = `
custom_provider:
  my-gateway:
    models:
      my-model: {}
`;
    expect(parseMcodeModelCatalog(config)).toEqual(["my-gateway/my-model"]);
  });

  it("returns [] for a document that is not a mapping", () => {
    expect(parseMcodeModelCatalog("- just\n- a list\n")).toEqual([]);
    expect(parseMcodeModelCatalog("")).toEqual([]);
  });

  it("returns [] for a malformed document instead of throwing", () => {
    expect(parseMcodeModelCatalog("provider:\n  - [unclosed\n")).toEqual([]);
  });

  it("returns [] for a config with no providers", () => {
    expect(parseMcodeModelCatalog("logLevel: info\n")).toEqual([]);
  });

  it("skips a provider whose models map is not a map", () => {
    const config = `
provider:
  minimax:
    models: "not a map"
`;
    expect(parseMcodeModelCatalog(config)).toEqual([]);
  });

  it("drops ids the launch path would refuse (validateCliModel)", () => {
    // A provider id with a space would make `provider/model` unusable in a
    // `--model` flag, so it never reaches the picker.
    const config = `
provider:
  "bad id":
    models:
      "also bad": {}
  good:
    models:
      "fine": {}
`;
    expect(parseMcodeModelCatalog(config)).toEqual(["good/fine"]);
  });

  it("does not repeat an id", () => {
    const config = `
provider:
  minimax:
    models:
      Same: {}
custom_provider:
  minimax:
    models:
      Same: {}
`;
    expect(parseMcodeModelCatalog(config)).toEqual(["minimax/Same"]);
  });
});

describe("listMcodeModels", () => {
  const dirs: string[] = [];

  const dataDir = (config?: string): string => {
    const dir = makeDataDir(config);
    dirs.push(dir);
    return dir;
  };

  beforeEach(() => {
    resetMcodeModelsCache();
  });

  afterEach(() => {
    resetMcodeModelsCache();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads config.yaml out of mcode's data dir", async () => {
    const dir = dataDir(STOCK_CONFIG);
    const models = await listMcodeModels({ dataDir: dir });
    expect(models).toEqual(["minimax/MiniMax-M3.1-Flash", "minimax/MiniMax-M3"]);
    expect(resolveMcodeConfigPath(dir)).toBe(path.join(dir, "config.yaml"));
  });

  it("returns [] when mcode has no config.yaml", async () => {
    expect(await listMcodeModels({ dataDir: dataDir() })).toEqual([]);
  });

  it("returns [] for a malformed config.yaml instead of throwing", async () => {
    const dir = dataDir("provider:\n  - [unclosed\n");
    expect(await listMcodeModels({ dataDir: dir })).toEqual([]);
  });

  it("serves the cached entry for an unchanged file", async () => {
    const dir = dataDir(STOCK_CONFIG);
    const first = await listMcodeModels({ dataDir: dir });
    const second = await listMcodeModels({ dataDir: dir });
    // The SAME array instance — the second call was served from the cache,
    // not re-parsed.
    expect(second).toBe(first);
  });

  // The review's core point (PR #1828): a TTL alone would serve a stale list
  // for up to an hour after the user added a model or signed a different
  // provider in, and the Settings section has no refresh button.
  it("picks up a change to config.yaml immediately", async () => {
    const dir = dataDir(STOCK_CONFIG);
    expect(await listMcodeModels({ dataDir: dir })).toEqual([
      "minimax/MiniMax-M3.1-Flash",
      "minimax/MiniMax-M3",
    ]);

    rewriteWithNewerMtime(
      path.join(dir, "config.yaml"),
      `
provider:
  minimax:
    models:
      Brand-New-Model: {}
`,
    );

    expect(await listMcodeModels({ dataDir: dir })).toEqual(["minimax/Brand-New-Model"]);
  });

  it("does not serve a stale entry after the file disappears", async () => {
    const dir = dataDir(STOCK_CONFIG);
    expect(await listMcodeModels({ dataDir: dir })).toHaveLength(2);

    rmSync(path.join(dir, "config.yaml"));
    expect(await listMcodeModels({ dataDir: dir })).toEqual([]);
  });

  it("shares one file read between concurrent callers", async () => {
    const dir = dataDir(STOCK_CONFIG);
    const [a, b, c] = await Promise.all([
      listMcodeModels({ dataDir: dir }),
      listMcodeModels({ dataDir: dir }),
      listMcodeModels({ dataDir: dir }),
    ]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("keeps the cache per data dir", async () => {
    const one = dataDir(STOCK_CONFIG);
    const two = dataDir(`
provider:
  other:
    models:
      Only-Here: {}
`);
    expect(await listMcodeModels({ dataDir: one })).toEqual([
      "minimax/MiniMax-M3.1-Flash",
      "minimax/MiniMax-M3",
    ]);
    expect(await listMcodeModels({ dataDir: two })).toEqual(["other/Only-Here"]);
    // ...and going back to the first dir still answers with ITS catalog.
    expect(await listMcodeModels({ dataDir: one })).toEqual([
      "minimax/MiniMax-M3.1-Flash",
      "minimax/MiniMax-M3",
    ]);
  });

  it("never serves one data dir's catalog to another mid-read", async () => {
    // The in-flight slot is keyed by config path, so a caller for dir B
    // while dir A is being read starts its OWN read instead of receiving A's
    // catalog.
    const one = dataDir(STOCK_CONFIG);
    const two = dataDir(`
provider:
  other:
    models:
      Only-Here: {}
`);
    const [a, b] = await Promise.all([
      listMcodeModels({ dataDir: one }),
      listMcodeModels({ dataDir: two }),
    ]);
    expect(a).toEqual(["minimax/MiniMax-M3.1-Flash", "minimax/MiniMax-M3"]);
    expect(b).toEqual(["other/Only-Here"]);
  });
});
