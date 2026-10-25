import { describe, expect, it } from "vitest";
import { SECTIONS, filterSettingsSections, phoneSections } from "./settingsSections.js";

// Issue #1880 — the settings filter, shared by the desktop nav rail
// (Settings.tsx) and the phone's navigator list (PhoneNavigator.tsx).
//
// The two have to agree: the phone's list had no filter at all, so finding
// one of the sections meant scrolling past all of them, while the desktop's
// filtered on the section's name and the control text its search index
// holds. This helper is the one implementation both use.

describe("filterSettingsSections", () => {
  const ids = (sections: typeof SECTIONS) => sections.map((s) => s.id);

  it("returns everything for an empty query", () => {
    expect(ids(filterSettingsSections(SECTIONS, ""))).toEqual(ids(SECTIONS));
    expect(ids(filterSettingsSections(SECTIONS, "   "))).toEqual(ids(SECTIONS));
  });

  it("matches a section by name", () => {
    expect(ids(filterSettingsSections(SECTIONS, "terminal"))).toEqual(["terminal"]);
  });

  it("matches a section by description", () => {
    // The description is what the desktop's rail did NOT match before, so
    // this is the part that is new: it finds a section by what the section
    // is about, not only by what it is called.
    expect(ids(filterSettingsSections(SECTIONS, "sign-in cookies"))).toEqual(["browser"]);
  });

  it("matches a section by the control text its search index holds", () => {
    // The index is the desktop rail's original behaviour — a query that
    // names a control finds the section that holds it.
    expect(ids(filterSettingsSections(SECTIONS, "cookies"))).toEqual(["browser"]);
  });

  it("is case-insensitive and ignores surrounding whitespace", () => {
    expect(ids(filterSettingsSections(SECTIONS, "  TERMINAL  "))).toEqual(["terminal"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterSettingsSections(SECTIONS, "zzzzz")).toEqual([]);
  });

  it("filters the phone's own list, which is the desktop's minus the Dock", () => {
    const phone = phoneSections();
    expect(ids(phone)).not.toContain("dock");
    expect(ids(filterSettingsSections(phone, "terminal"))).toEqual(["terminal"]);
    // "docker" finds Storage, not the hidden Dock section: Storage holds
    // the Docker-image cleanup control, and a section the phone does not
    // list cannot be what a query finds.
    expect(ids(filterSettingsSections(phone, "docker"))).toEqual(["storage"]);
  });

  it("does not change the list it is given", () => {
    const before = ids(SECTIONS);
    filterSettingsSections(SECTIONS, "terminal");
    expect(ids(SECTIONS)).toEqual(before);
  });
});
