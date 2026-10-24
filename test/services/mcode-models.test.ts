import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  beforeEach(() => {
    resetMcodeModelsCache();
  });

  afterEach(() => {
    resetMcodeModelsCache();
  });

  it("reads config.yaml out of mcode's data dir", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mullion-mcode-models-"));
    try {
      writeFileSync(path.join(dir, "config.yaml"), STOCK_CONFIG);
      const models = await listMcodeModels({ dataDir: dir });
      expect(models).toEqual(["minimax/MiniMax-M3.1-Flash", "minimax/MiniMax-M3"]);
      expect(resolveMcodeConfigPath(dir)).toBe(path.join(dir, "config.yaml"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] when mcode has no config.yaml", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mullion-mcode-models-"));
    try {
      expect(await listMcodeModels({ dataDir: dir })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] for a malformed config.yaml instead of throwing", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mullion-mcode-models-"));
    try {
      writeFileSync(path.join(dir, "config.yaml"), "provider:\n  - [unclosed\n");
      expect(await listMcodeModels({ dataDir: dir })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caches a successful catalog for an hour", async () => {
    const readConfig = vi.fn().mockReturnValue(STOCK_CONFIG);
    let now = 1_000_000;
    const first = await listMcodeModels({ readConfig, now: () => now });
    expect(first).toHaveLength(2);

    // A second call inside the TTL does not read the file again.
    now += 60_000;
    const second = await listMcodeModels({ readConfig, now: () => now });
    expect(second).toEqual(first);
    expect(readConfig).toHaveBeenCalledTimes(1);

    // Past the TTL it re-reads.
    now += 3 * 60 * 60 * 1000;
    await listMcodeModels({ readConfig, now: () => now });
    expect(readConfig).toHaveBeenCalledTimes(2);
  });

  it("does NOT cache an empty catalog", async () => {
    // An empty result is usually transient (the file is momentarily
    // unreadable), so it must be retried rather than pinned for an hour.
    const readConfig = vi.fn().mockReturnValue("");
    expect(await listMcodeModels({ readConfig })).toEqual([]);
    expect(await listMcodeModels({ readConfig })).toEqual([]);
    expect(readConfig).toHaveBeenCalledTimes(2);
  });

  it("shares one file read between concurrent callers", async () => {
    const readConfig = vi.fn().mockReturnValue(STOCK_CONFIG);
    const [a, b, c] = await Promise.all([
      listMcodeModels({ readConfig }),
      listMcodeModels({ readConfig }),
      listMcodeModels({ readConfig }),
    ]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(readConfig).toHaveBeenCalledTimes(1);
  });
});
