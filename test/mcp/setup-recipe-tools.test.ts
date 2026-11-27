import { describe, expect, it, vi } from "vitest";
import { getSetupRecipe, setSetupRecipe } from "../../src/mcp/setup-recipe-tools.mjs";

// #3592 — the MCP tools pass their arguments to the client unchanged.

describe("get_setup_recipe / set_setup_recipe MCP tools", () => {
  it("forward to the client and return its JSON", async () => {
    const client = {
      getSetupRecipe: vi.fn(async () => ({ projectId: 1, setupRecipe: null })),
      setSetupRecipe: vi.fn(async () => ({ projectId: 1, setupRecipe: "npm ci" })),
    };
    expect(JSON.parse(await getSetupRecipe.handler({}, client))).toEqual({
      projectId: 1,
      setupRecipe: null,
    });
    expect(client.getSetupRecipe).toHaveBeenCalledWith(undefined);
    await setSetupRecipe.handler({ projectId: "1", recipe: "npm ci", run: true }, client);
    expect(client.setSetupRecipe).toHaveBeenCalledWith("1", {
      recipe: "npm ci",
      run: true,
      sessionId: undefined,
    });
    expect(setSetupRecipe.inputSchema.required).toEqual(["recipe"]);
  });
});
