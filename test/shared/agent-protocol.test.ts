import { describe, it, expect } from "vitest";
import {
  AGENT_LAUNCH_OPTIONS,
  AGENT_OPERATIONS,
  LEGACY_BASELINE,
  isProtocolCompatible,
  localProtocolInfo,
} from "../../src/shared/agent-protocol.js";
import { spawnSessionSchema } from "../../src/routes/internal-schemas.js";

describe("agent protocol registry (issue #2248)", () => {
  it("the launch options are exactly the optional fields of the spawn schema", () => {
    const { properties, required } = spawnSessionSchema.body as unknown as {
      properties: Record<string, unknown>;
      required: string[];
    };
    const optional = Object.keys(properties).filter((k) => !required.includes(k));
    expect([...AGENT_LAUNCH_OPTIONS].sort()).toEqual(optional.sort());
  });

  it("the legacy baseline is a strict subset of the registry", () => {
    for (const op of LEGACY_BASELINE.operations) expect(AGENT_OPERATIONS).toContain(op);
    for (const o of LEGACY_BASELINE.launchOptions) expect(AGENT_LAUNCH_OPTIONS).toContain(o);
    expect(LEGACY_BASELINE.operations.length).toBeLessThan(AGENT_OPERATIONS.length);
  });

  it("advertises its own version as compatible", () => {
    expect(isProtocolCompatible(localProtocolInfo().protocolVersion)).toBe(true);
    expect(isProtocolCompatible(0)).toBe(false);
  });
});
