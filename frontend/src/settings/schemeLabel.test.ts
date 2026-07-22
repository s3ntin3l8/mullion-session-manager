import { describe, it, expect } from "vitest";
import { schemeLabel } from "./schemeLabel.js";

describe("schemeLabel", () => {
  describe("dark mode — names are returned verbatim", () => {
    it('keeps " Dark" suffix in dark mode', () => {
      expect(schemeLabel("Mullion Dark", "dark")).toBe("Mullion Dark");
      expect(schemeLabel("One Dark", "dark")).toBe("One Dark");
    });

    it("leaves theme-neutral names unchanged in dark mode", () => {
      expect(schemeLabel("Solarized", "dark")).toBe("Solarized");
      expect(schemeLabel("Dracula", "dark")).toBe("Dracula");
      expect(schemeLabel("Gruvbox", "dark")).toBe("Gruvbox");
      expect(schemeLabel("Tokyo Night", "dark")).toBe("Tokyo Night");
    });
  });

  describe('light mode — rewrites " Dark" suffix', () => {
    it('rewrites "Mullion Dark" to "Mullion Light"', () => {
      expect(schemeLabel("Mullion Dark", "light")).toBe("Mullion Light");
    });

    it('rewrites "One Dark" to "One Light"', () => {
      expect(schemeLabel("One Dark", "light")).toBe("One Light");
    });
  });

  describe("light mode — leaves theme-neutral names unchanged", () => {
    it('keeps "Solarized" as-is', () => {
      expect(schemeLabel("Solarized", "light")).toBe("Solarized");
    });

    it('keeps "Dracula" as-is', () => {
      expect(schemeLabel("Dracula", "light")).toBe("Dracula");
    });

    it('keeps "Gruvbox" as-is', () => {
      expect(schemeLabel("Gruvbox", "light")).toBe("Gruvbox");
    });

    it('keeps "Tokyo Night" as-is', () => {
      expect(schemeLabel("Tokyo Night", "light")).toBe("Tokyo Night");
    });
  });

  describe("edge cases", () => {
    it('handles names with "Dark" not as a suffix word', () => {
      expect(schemeLabel("Dark Theme", "light")).toBe("Dark Theme");
    });

    it("handles empty string", () => {
      expect(schemeLabel("", "light")).toBe("");
      expect(schemeLabel("", "dark")).toBe("");
    });
  });
});
