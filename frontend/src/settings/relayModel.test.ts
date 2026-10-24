import { describe, it, expect } from "vitest";
import {
  PROFILE_DEFAULT_MODEL,
  parseRelayModel,
  relayModelOptions,
  relayModelValue,
} from "./relayModel.js";

const PROVIDERS = [
  { provider: "anthropic", name: "Anthropic", models: ["claude-sonnet-5-5"] },
  { provider: "openrouter", name: "OpenRouter", models: ["llama3:8b"] },
];

describe("relayModel", () => {
  it("lists one option per provider/model, labelled with the provider", () => {
    expect(relayModelOptions(PROVIDERS)).toEqual([
      { value: "anthropic:claude-sonnet-5-5", label: "claude-sonnet-5-5 (Anthropic)" },
      { value: "openrouter:llama3:8b", label: "llama3:8b (OpenRouter)" },
    ]);
  });

  it("shows the alias as the profile default, a provider pair as a list value, else the bare model", () => {
    expect(relayModelValue(PROFILE_DEFAULT_MODEL, "")).toBeNull();
    expect(relayModelValue("llama3:8b", "openrouter")).toBe("openrouter:llama3:8b");
    expect(relayModelValue("my-model", "")).toBe("my-model");
  });

  it("parses a list value on the first colon only", () => {
    expect(parseRelayModel("openrouter:llama3:8b", PROVIDERS)).toEqual({
      model: "llama3:8b",
      modelProvider: "openrouter",
    });
  });

  it("keeps the stored provider while the list can't verify it, so an edit never makes the joined text a model id", () => {
    // Options failed to load: the stored pair is shown as `provider:model` and
    // edited as text. An edit under the same provider keeps the provider.
    expect(parseRelayModel("openrouter:llama3:70b", [], { modelProvider: "openrouter" })).toEqual({
      model: "llama3:70b",
      modelProvider: "openrouter",
    });
    // Clearing the model part is "no model": the profile default.
    expect(parseRelayModel("openrouter:", [], { modelProvider: "openrouter" })).toEqual({
      model: PROFILE_DEFAULT_MODEL,
      modelProvider: "",
    });
    // Once the list has loaded, an unknown value is a custom bare model.
    expect(
      parseRelayModel("openrouter:not-listed", PROVIDERS, { modelProvider: "openrouter" }),
    ).toEqual({ model: "openrouter:not-listed", modelProvider: "" });
    // Another prefix is the user's own text.
    expect(parseRelayModel("other:x", [], { modelProvider: "openrouter" })).toEqual({
      model: "other:x",
      modelProvider: "",
    });
  });

  it("parses null as the profile default and anything unknown as a bare custom model", () => {
    expect(parseRelayModel(null, PROVIDERS)).toEqual({
      model: PROFILE_DEFAULT_MODEL,
      modelProvider: "",
    });
    expect(parseRelayModel("openrouter:not-listed", PROVIDERS)).toEqual({
      model: "openrouter:not-listed",
      modelProvider: "",
    });
    expect(parseRelayModel("my-model", [])).toEqual({ model: "my-model", modelProvider: "" });
  });
});
