import { describe, it, expect } from "vitest";
import { commandAgentBin } from "../../../src/services/hook-adapters/index.js";

// Issue #2240 — a launch command maps to the KNOWN_AGENTS binary placement
// must find on a host; shells and unknown commands map to null (no filter).
describe("commandAgentBin", () => {
  it.each([
    ["claude", "claude"],
    ["claude --model opus", "claude"],
    ["codex", "codex"],
    ["opencode", "opencode"],
    ["agy", "agy"],
    ["mcode", "mcode"],
  ])("maps %s to %s", (command, bin) => {
    expect(commandAgentBin(command)).toBe(bin);
  });

  it.each(["bash", "zsh", "npm run dev", "gemini", ""])("returns null for %j", (command) => {
    expect(commandAgentBin(command)).toBeNull();
  });
});
