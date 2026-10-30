import { describe, it, expect } from "vitest";
import {
  MAX_DECLINED_HOSTS,
  metaAfterOperatorSave,
  parseHostCwdsMeta,
  serializeHostCwdsMeta,
} from "../../src/services/host-cwds-meta.js";

// Issue #2090 — projects.hostCwdsMeta: which hostCwds entries were
// auto-detected, and which hosts the operator declined.

describe("parseHostCwdsMeta / serializeHostCwdsMeta", () => {
  it("reads the empty meta from null, empty and malformed values", () => {
    for (const raw of [null, undefined, "", "not json", "[]", '"x"', "null", "42"]) {
      expect(parseHostCwdsMeta(raw as string | null)).toEqual({
        auto: [],
        declined: [],
        managed: [],
      });
    }
  });

  it("keeps only non-empty strings, once each", () => {
    const raw = JSON.stringify({ auto: ["a", "a", 3, "", "b"], declined: "nope" });
    expect(parseHostCwdsMeta(raw)).toEqual({ auto: ["a", "b"], declined: [], managed: [] });
  });

  it("round-trips, and stores nothing at all for an empty meta", () => {
    const meta = { auto: ["a"], declined: ["b"], managed: ["c"] };
    expect(parseHostCwdsMeta(serializeHostCwdsMeta(meta))).toEqual(meta);
    expect(serializeHostCwdsMeta({ auto: [], declined: [], managed: [] })).toBeNull();
  });
});

describe("metaAfterOperatorSave", () => {
  const hostCwds = JSON.stringify({ mac: "/Users/x/app", box: "/srv/app" });

  it("declines a host whose entry the operator removed", () => {
    const meta = metaAfterOperatorSave({ hostCwds, meta: null }, { mac: "/Users/x/app" });
    expect(meta).toEqual({ auto: [], declined: ["box"], managed: [] });
  });

  it("clears the auto flag of every entry the operator saved, and un-declines a re-added host", () => {
    const before = {
      hostCwds,
      meta: JSON.stringify({ auto: ["mac"], declined: ["old"] }),
    };
    const meta = metaAfterOperatorSave(before, {
      mac: "/Users/x/app",
      box: "/srv/app",
      old: "/opt/app",
    });
    expect(meta).toEqual({ auto: [], declined: [], managed: [] });
  });

  it("declines every host when the whole map is cleared", () => {
    expect(metaAfterOperatorSave({ hostCwds, meta: null }, {}).declined.sort()).toEqual([
      "box",
      "mac",
    ]);
  });

  it("forgets a declined host that no longer exists, and caps how many it remembers", () => {
    const before = {
      hostCwds: null,
      meta: JSON.stringify({ auto: [], declined: ["gone", "mac"] }),
    };
    expect(
      metaAfterOperatorSave(before, {}, new Set(["mac"])).declined,
      "an unknown host's decline is dropped",
    ).toEqual(["mac"]);

    const many = Array.from({ length: MAX_DECLINED_HOSTS + 10 }, (_, i) => `h${i}`);
    const full = { hostCwds: null, meta: JSON.stringify({ auto: [], declined: many }) };
    const after = metaAfterOperatorSave(full, {}).declined;
    expect(after).toHaveLength(MAX_DECLINED_HOSTS);
    // The OLDEST are forgotten first.
    expect(after[after.length - 1]).toBe(`h${MAX_DECLINED_HOSTS + 9}`);
    expect(after).not.toContain("h0");
  });

  it("an auto-filled entry that is removed becomes a decline, not a lingering auto flag", () => {
    const before = { hostCwds, meta: JSON.stringify({ auto: ["box"], declined: [] }) };
    expect(metaAfterOperatorSave(before, { mac: "/Users/x/app" })).toEqual({
      auto: [],
      declined: ["box"],
      managed: [],
    });
  });

  it("keeps a managed host only while its entry exists at the same path", () => {
    const before = {
      hostCwds,
      meta: JSON.stringify({ auto: [], declined: [], managed: ["mac", "box"] }),
    };
    // mac untouched; box re-mapped by the operator -> theirs now.
    expect(metaAfterOperatorSave(before, { mac: "/Users/x/app", box: "/other" }).managed).toEqual([
      "mac",
    ]);
    // box removed -> no longer managed (and declined).
    const removed = metaAfterOperatorSave(before, { mac: "/Users/x/app" });
    expect(removed.managed).toEqual(["mac"]);
    expect(removed.declined).toEqual(["box"]);
  });

  it("reads only strings from a malformed managed list, and a managed-only meta is stored", () => {
    expect(parseHostCwdsMeta(JSON.stringify({ managed: ["a", 1, "a"] })).managed).toEqual(["a"]);
    expect(parseHostCwdsMeta(JSON.stringify({ managed: "x" })).managed).toEqual([]);
    expect(serializeHostCwdsMeta({ auto: [], declined: [], managed: ["a"] })).not.toBeNull();
  });
});
