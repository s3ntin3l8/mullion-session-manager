import { describe, it, expect } from "vitest";
import {
  metaAfterOperatorSave,
  parseHostCwdsMeta,
  serializeHostCwdsMeta,
} from "../../src/services/host-cwds-meta.js";

// Issue #2090 — projects.hostCwdsMeta: which hostCwds entries were
// auto-detected, and which hosts the operator declined.

describe("parseHostCwdsMeta / serializeHostCwdsMeta", () => {
  it("reads the empty meta from null, empty and malformed values", () => {
    for (const raw of [null, undefined, "", "not json", "[]", '"x"', "null", "42"]) {
      expect(parseHostCwdsMeta(raw as string | null)).toEqual({ auto: [], declined: [] });
    }
  });

  it("keeps only non-empty strings, once each", () => {
    const raw = JSON.stringify({ auto: ["a", "a", 3, "", "b"], declined: "nope" });
    expect(parseHostCwdsMeta(raw)).toEqual({ auto: ["a", "b"], declined: [] });
  });

  it("round-trips, and stores nothing at all for an empty meta", () => {
    const meta = { auto: ["a"], declined: ["b"] };
    expect(parseHostCwdsMeta(serializeHostCwdsMeta(meta))).toEqual(meta);
    expect(serializeHostCwdsMeta({ auto: [], declined: [] })).toBeNull();
  });
});

describe("metaAfterOperatorSave", () => {
  const hostCwds = JSON.stringify({ mac: "/Users/x/app", box: "/srv/app" });

  it("declines a host whose entry the operator removed", () => {
    const meta = metaAfterOperatorSave({ hostCwds, meta: null }, { mac: "/Users/x/app" });
    expect(meta).toEqual({ auto: [], declined: ["box"] });
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
    expect(meta).toEqual({ auto: [], declined: [] });
  });

  it("declines every host when the whole map is cleared", () => {
    expect(metaAfterOperatorSave({ hostCwds, meta: null }, {}).declined.sort()).toEqual([
      "box",
      "mac",
    ]);
  });

  it("an auto-filled entry that is removed becomes a decline, not a lingering auto flag", () => {
    const before = { hostCwds, meta: JSON.stringify({ auto: ["box"], declined: [] }) };
    expect(metaAfterOperatorSave(before, { mac: "/Users/x/app" })).toEqual({
      auto: [],
      declined: ["box"],
    });
  });
});
