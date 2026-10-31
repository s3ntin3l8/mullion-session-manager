import { useState } from "react";
import { Dropdown } from "./ui/primitives.js";
import { ErrorText } from "./ui/ErrorText.js";
import { BotIcon } from "./ui/icons.js";
import { ModelSelect } from "./settings/ModelPicker.js";
import type { ModelOption } from "./settings/ModelPicker.js";
import { CLAUDE_SMALL_MODELS, commandModelCli, useModelOptions } from "./models/modelCatalogs.js";
import type { ModelCli } from "./models/modelCatalogs.js";
import type { AppSettings, Task } from "./api/index.js";
import { resolvedDefaultModel } from "./lib/taskModelDefault.js";
import type { ModelRole } from "./lib/taskModelDefault.js";

// Issue #2491 — the task detail panel's model controls, next to the Agent and
// Review agent dropdowns. The provider step exists only for opencode (its ids
// are `provider/model`); for every other CLI the agent IS the provider, so only
// the model dropdown shows. The first entry of each control is "Default
// (<resolved>)", which clears the task-level choice.

function defaultLabel(resolved: string | null): string {
  return resolved ? `Default (${resolved})` : "Default";
}

const providerOf = (id: string | null): string | null =>
  id !== null && id.includes("/") ? id.slice(0, id.indexOf("/")) : null;

function ModelField({
  label,
  cli,
  role,
  value,
  resolved,
  onChange,
}: {
  label: string;
  cli: ModelCli;
  role: ModelRole;
  value: string | null;
  resolved: string | null;
  onChange: (value: string | null) => void;
}) {
  const catalog = useModelOptions(cli);
  // A pick of a provider with no model chosen yet has nowhere to live but here.
  const [pickedProvider, setPickedProvider] = useState<string | null>(null);
  const small = role === "small";
  const withProvider = cli === "opencode" && !small;

  let options: ModelOption[] = catalog.options;
  let allowCustom = catalog.allowCustom;
  if (small && cli === "claude-code") options = CLAUDE_SMALL_MODELS;

  const provider = withProvider ? (providerOf(value) ?? pickedProvider) : null;
  if (withProvider) {
    options = options.filter((o) => providerOf(o.value) === provider);
    allowCustom = false;
  }
  const providers = withProvider
    ? Array.from(new Set(catalog.options.map((o) => providerOf(o.value)).filter((p) => p !== null)))
    : [];

  return (
    <div className="task-detail-agent-select">
      <span className="task-detail-agent-label">
        <BotIcon size={12} /> {label}:
      </span>
      {withProvider && (
        <Dropdown
          ariaLabel={`${label} provider`}
          value={provider ?? ""}
          onChange={(p) => {
            setPickedProvider(p === "" ? null : p);
            if (p === "" || providerOf(value) !== p) onChange(null);
          }}
          options={[
            { value: "", label: defaultLabel(resolved) },
            ...providers.map((p) => ({ value: p, label: p })),
          ]}
        />
      )}
      {(!withProvider || provider !== null) && (
        <ModelSelect
          ariaLabel={`${label} model`}
          value={value}
          options={options}
          defaultLabel={withProvider ? "Choose a model…" : defaultLabel(resolved)}
          allowCustom={allowCustom}
          onChange={onChange}
          small
        />
      )}
    </div>
  );
}

export function TaskModelControls({
  task,
  workerAgent,
  reviewerAgent,
  settings,
  onUpdate,
}: {
  task: Task;
  // The agent ids the worker and reviewer resolve to; reviewerAgent is null
  // when the review agent is hermes or none (Hermes picks its own model).
  workerAgent: string;
  reviewerAgent: string | null;
  settings: AppSettings | null;
  onUpdate: (patch: {
    model?: string | null;
    smallModel?: string | null;
    reviewerModel?: string | null;
  }) => Promise<unknown>;
}) {
  const [error, setError] = useState<string | null>(null);
  const save = async (patch: Parameters<typeof onUpdate>[0]) => {
    setError(null);
    try {
      await onUpdate(patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the model");
    }
  };
  const workerCli = commandModelCli(workerAgent);
  const reviewerCli = reviewerAgent === null ? null : commandModelCli(reviewerAgent);
  const smallCli = workerCli === "opencode" || workerCli === "claude-code" ? workerCli : null;
  if (workerCli === null && reviewerCli === null) return null;
  // `key` remounts a field when its CLI changes, dropping a stale provider pick.
  return (
    <>
      {workerCli !== null && (
        <ModelField
          key={`model-${workerCli}`}
          label="Model"
          cli={workerCli}
          role="implementer"
          value={task.modelOverride ?? null}
          resolved={resolvedDefaultModel(workerCli, "implementer", task.body, settings)}
          onChange={(v) => save({ model: v })}
        />
      )}
      {smallCli !== null && (
        <ModelField
          key={`small-${smallCli}`}
          label="Small model"
          cli={smallCli}
          role="small"
          value={task.smallModelOverride ?? null}
          resolved={resolvedDefaultModel(smallCli, "small", task.body, settings)}
          onChange={(v) => save({ smallModel: v })}
        />
      )}
      {reviewerCli !== null && (
        <ModelField
          key={`reviewer-${reviewerCli}`}
          label="Reviewer model"
          cli={reviewerCli}
          role="reviewer"
          value={task.reviewerModel ?? null}
          resolved={resolvedDefaultModel(reviewerCli, "reviewer", task.body, settings)}
          onChange={(v) => save({ reviewerModel: v })}
        />
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </>
  );
}
