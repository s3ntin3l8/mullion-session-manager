import { describe, expect, it } from "vitest";
import { buildRefChips, stripRemote } from "./historyRefs.js";

const remotes = new Set(["origin/main", "upstream/dev"]);

describe("stripRemote", () => {
  it("strips a known remote prefix and leaves local names alone", () => {
    expect(stripRemote("origin/feat/x", remotes)).toBe("feat/x");
    expect(stripRemote("upstream/dev", remotes)).toBe("dev");
    expect(stripRemote("feat/x", remotes)).toBe("feat/x");
  });
});

describe("buildRefChips", () => {
  it("collapses origin/x + x into one synced chip and keeps the PR lookup key", () => {
    const chips = buildRefChips(["origin/feat", "feat"], remotes);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({
      label: "feat",
      kind: "branch",
      synced: true,
      prBranch: "feat",
      tone: "success",
    });
    expect(chips[0].raw).toEqual(["origin/feat", "feat"]);
  });

  it("matches a PR from a remote-only ref by stripping the prefix", () => {
    const [chip] = buildRefChips(["origin/feat"], remotes);
    expect(chip).toMatchObject({ label: "feat", kind: "remote", synced: false, prBranch: "feat" });
  });

  it("promotes the chip to head, orders head/branch/tag/remote, drops origin/HEAD", () => {
    const chips = buildRefChips(
      ["origin/HEAD", "upstream/dev", "tag: v1", "other", "origin/main", "HEAD -> main"],
      remotes,
    );
    expect(chips.map((c) => [c.label, c.kind])).toEqual([
      ["main", "head"],
      ["other", "branch"],
      ["v1", "tag"],
      ["dev", "remote"],
    ]);
    expect(chips[0].synced).toBe(true);
    expect(chips[0].tone).toBe("info");
    expect(chips[2].prBranch).toBeUndefined();
  });

  it("turns a remote-first chip into a local branch when the local ref follows", () => {
    const [chip] = buildRefChips(["origin/x", "x"], new Set(["origin/x"]));
    expect(chip.kind).toBe("branch");
    const [head] = buildRefChips(["origin/y", "HEAD -> y"], new Set(["origin/y"]));
    expect(head.kind).toBe("head");
  });

  it("ignores a bare HEAD", () => {
    expect(buildRefChips(["HEAD"], remotes)).toEqual([]);
  });
});
