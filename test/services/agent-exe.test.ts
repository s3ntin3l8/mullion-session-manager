import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toolNodePath } from "../../src/services/agent-exe.js";

describe("toolNodePath", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const tmp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-exe-"));
    dirs.push(dir);
    return dir;
  };

  /** A runtime folder holding the branded copy, its stamp and the Node it was made from. */
  function brandedCopy(stamp: string | ((source: string) => unknown) | undefined) {
    const dir = tmp();
    const source = path.join(dir, "node", "node.exe");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "");
    const copy = path.join(dir, "mullion-agent.exe");
    fs.writeFileSync(copy, "");
    if (stamp !== undefined) {
      fs.writeFileSync(
        `${copy}.json`,
        typeof stamp === "string" ? stamp : JSON.stringify(stamp(source)),
      );
    }
    return { copy, source };
  }

  it("returns the Node the branded copy was made from", () => {
    const { copy, source } = brandedCopy((src: string) => ({ source: src }));
    expect(toolNodePath(copy)).toBe(source);
  });

  it("returns any other executable as it is", () => {
    const { source } = brandedCopy((src: string) => ({ source: src }));
    expect(toolNodePath(source)).toBe(source);
    expect(toolNodePath("/usr/bin/node")).toBe("/usr/bin/node");
  });

  it("keeps the copy itself when there is no usable stamp", () => {
    expect(toolNodePath(brandedCopy(undefined).copy)).toMatch(/mullion-agent\.exe$/);
    const garbage = brandedCopy("{not json");
    expect(toolNodePath(garbage.copy)).toBe(garbage.copy);
    const missing = brandedCopy(() => ({ source: path.join(os.tmpdir(), "no-such-node.exe") }));
    expect(toolNodePath(missing.copy)).toBe(missing.copy);
    const wrongType = brandedCopy(() => ({ source: 42 }));
    expect(toolNodePath(wrongType.copy)).toBe(wrongType.copy);
  });

  it("defaults to the running executable", () => {
    expect(toolNodePath()).toBe(process.execPath);
  });
});
