// The review relay's model setting is two stored fields — `model` and
// `modelProvider` — shown as one picker value (issue #1775). Kept DOM-free so
// the mapping can be tested without rendering Settings.
import type { HermesModelProvider } from "../api/index.js";
import type { ModelOption } from "./ModelPicker.js";

/** The API server's virtual model: use the Hermes profile's own model chain. */
export const PROFILE_DEFAULT_MODEL = "hermes-agent";

// Provider slugs have no ":" but model ids can ("llama3:8b"), so a list entry's
// value is `<slug>:<model>` and is only ever split on the FIRST colon.
const optionValue = (provider: string, model: string) => `${provider}:${model}`;

export function relayModelOptions(providers: HermesModelProvider[]): ModelOption[] {
  return providers.flatMap((p) =>
    p.models.map((model) => ({
      value: optionValue(p.provider, model),
      label: `${model} (${p.name})`,
    })),
  );
}

/** What the picker shows for the stored pair; null = the profile default. */
export function relayModelValue(model: string, modelProvider: string): string | null {
  if (modelProvider) return optionValue(modelProvider, model);
  return model === PROFILE_DEFAULT_MODEL ? null : model;
}

/**
 * The pair to store for a picker value. A value not in the list is a custom
 * bare model — except under the stored provider: when the list could not load,
 * the stored pair is shown (and edited) as its joined `provider:model` text, so
 * an edit that keeps the provider prefix must keep the provider, not turn the
 * joined string into a bare model id.
 */
export function parseRelayModel(
  value: string | null,
  providers: HermesModelProvider[],
  current: { modelProvider: string } = { modelProvider: "" },
): { model: string; modelProvider: string } {
  if (value === null) return { model: PROFILE_DEFAULT_MODEL, modelProvider: "" };
  const colon = value.indexOf(":");
  if (colon > 0) {
    const provider = value.slice(0, colon);
    const model = value.slice(colon + 1);
    if (providers.some((p) => p.provider === provider && p.models.includes(model))) {
      return { model, modelProvider: provider };
    }
  }
  const prefix = `${current.modelProvider}:`;
  if (current.modelProvider && providers.length === 0 && value.startsWith(prefix)) {
    const model = value.slice(prefix.length);
    // Clearing the model part leaves only the provider's prefix: that is "no
    // model", i.e. the profile default, not an empty model under a provider.
    if (model === "") return { model: PROFILE_DEFAULT_MODEL, modelProvider: "" };
    return { model, modelProvider: current.modelProvider };
  }
  return { model: value, modelProvider: "" };
}
