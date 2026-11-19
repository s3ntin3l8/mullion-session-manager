import { describe, it, expect } from "vitest";
import {
  parsePlacementRequirement,
  serializePlacementRequirement,
  describeRequirementSource,
} from "../../src/services/task-placement-resolve.js";

// Issue #1954 — `Platform:` / `Host:` in an issue body, with the same matching
// rules as the other directives (Agent:, Model:, ...).
describe("parsePlacementRequirement", () => {
  it("returns null for a body with no directive, or no body", () => {
    expect(parsePlacementRequirement(null)).toBeNull();
    expect(parsePlacementRequirement("")).toBeNull();
    expect(parsePlacementRequirement("Fix the login bug.\n\nSteps: 1. open it")).toBeNull();
  });

  it("reads a Platform: directive, lower-cased", () => {
    expect(parsePlacementRequirement("Platform: darwin")).toEqual({ platform: "darwin" });
    expect(parsePlacementRequirement("Platform: Darwin")).toEqual({ platform: "darwin" });
  });

  it("reads a Host: directive, keeping the id as typed", () => {
    expect(parsePlacementRequirement("Host: 3f2a-Mac")).toEqual({ hostId: "3f2a-Mac" });
  });

  it("keeps both when both are given, with the host as the target", () => {
    expect(parsePlacementRequirement("Host: h1\nPlatform: darwin")).toEqual({
      hostId: "h1",
      platform: "darwin",
    });
  });

  describe("Capability:", () => {
    it("reads one or several names, lower-cased, in canonical order", () => {
      expect(parsePlacementRequirement("Capability: xcode")).toEqual({ capabilities: ["xcode"] });
      expect(parsePlacementRequirement("capability: Android-Emulator,XCODE")).toEqual({
        capabilities: ["xcode", "android-emulator"],
      });
    });

    it("rides along with Platform: and Host:", () => {
      expect(parsePlacementRequirement("Platform: darwin\nCapability: xcode")).toEqual({
        platform: "darwin",
        capabilities: ["xcode"],
      });
      expect(parsePlacementRequirement("Host: h1\nCapability: xcode")).toEqual({
        hostId: "h1",
        capabilities: ["xcode"],
      });
    });

    it("keeps an unknown name apart, so the claim can refuse it", () => {
      expect(parsePlacementRequirement("Capability: xcode,nope")).toEqual({
        capabilities: ["xcode"],
        unknownCapabilities: ["nope"],
      });
      expect(parsePlacementRequirement("Capability: nope")).toEqual({
        unknownCapabilities: ["nope"],
      });
    });

    it("ignores a fenced block, whitespace in the value, prose, and takes the first match", () => {
      expect(parsePlacementRequirement("```\nCapability: xcode\n```")).toBeNull();
      expect(parsePlacementRequirement("Capability: xcode, android-emulator")).toBeNull();
      expect(parsePlacementRequirement("needs Capability: xcode")).toBeNull();
      expect(parsePlacementRequirement("Capability: xcode\nCapability: android-emulator")).toEqual({
        capabilities: ["xcode"],
      });
    });

    it("round-trips through serialize, and names its source line", () => {
      const target = parsePlacementRequirement("Platform: darwin\nCapability: xcode");
      expect(serializePlacementRequirement(target)).toBe(
        '{"platform":"darwin","capabilities":["xcode"]}',
      );
      expect(describeRequirementSource(target!)).toBe(
        "the `Platform:` and `Capability:` lines in its issue body",
      );
      expect(describeRequirementSource({ platform: "darwin" })).toBe(
        "the `Platform:` line in its issue body",
      );
    });
  });

  it("matches the key case-insensitively, at the start of a line, with surrounding text around", () => {
    expect(parsePlacementRequirement("Build it.\n\n  PLATFORM:   darwin  \nThanks")).toEqual({
      platform: "darwin",
    });
  });

  it("ignores a directive-looking phrase in prose, or one with a multi-word value", () => {
    expect(
      parsePlacementRequirement("We should run this on Platform: darwin eventually"),
    ).toBeNull();
    expect(parsePlacementRequirement("Platform: mac os")).toBeNull();
    expect(parsePlacementRequirement("The Host: field is empty")).toBeNull();
  });

  it("is not hidden by leading whitespace, but is by a bullet or quote prefix", () => {
    expect(parsePlacementRequirement("    Host: localhost")).toEqual({ hostId: "localhost" });
    expect(parsePlacementRequirement("- Host: localhost")).toBeNull();
    expect(parsePlacementRequirement("> Host: localhost")).toBeNull();
  });

  it("uses the first occurrence", () => {
    expect(parsePlacementRequirement("Platform: darwin\nPlatform: linux")).toEqual({
      platform: "darwin",
    });
  });
});

describe("serializePlacementRequirement", () => {
  it("is null for no requirement and JSON otherwise", () => {
    expect(serializePlacementRequirement(null)).toBeNull();
    expect(serializePlacementRequirement({ platform: "darwin" })).toBe('{"platform":"darwin"}');
    expect(serializePlacementRequirement({ hostId: "h1", platform: "darwin" })).toBe(
      '{"hostId":"h1","platform":"darwin"}',
    );
  });
});
