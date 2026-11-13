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
  aria,
  cli,
  role,
  value,
  resolved,
  onChange,
  sidebar,
}: {
  label: string;
  // Accessible name; stays unique when the visible label is shortened.
  aria: string;
  cli: ModelCli;
  role: ModelRole;
  value: string | null;
  resolved: string | null;
  onChange: (value: string | null) => void;
  sidebar: boolean;
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
    <div
      className={
        sidebar
          ? `sb-agent-fld${withProvider && provider !== null ? " sb-agent-fld-two" : ""}`
          : "task-detail-agent-select"
      }
    >
      {sidebar ? (
        <span className="sb-agent-lbl">{label}</span>
      ) : (
        <span className="task-detail-agent-label">
          <BotIcon size={12} /> {label}:
        </span>
      )}
      {withProvider && (
        <Dropdown
          small={sidebar}
          ariaLabel={`${aria} provider`}
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
          ariaLabel={aria}
          value={value}
          options={options}
          defaultLabel={withProvider && value === null ? "Choose a model…" : defaultLabel(resolved)}
          allowCustom={allowCustom}
          onChange={onChange}
          small
          stretch={sidebar}
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
  section,
  variant,
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
  // Render only one role's fields (the sidebar groups Worker and Reviewer).
  section?: "worker" | "reviewer";
  // "sidebar": label in the sb-kv column, controls stretched to the cell.
  variant?: "sidebar";
}) {
  const sidebar = variant === "sidebar";
  const [error, setError] = useState<string | null>(null);
  const save = async (patch: Parameters<typeof onUpdate>[0]) => {
    setError(null);
    try {
      await onUpdate(patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the model");
    }
  };
  const workerCli = section === "reviewer" ? null : commandModelCli(workerAgent);
  const reviewerCli =
    reviewerAgent === null || section === "worker" ? null : commandModelCli(reviewerAgent);
  const smallCli = workerCli === "opencode" || workerCli === "claude-code" ? workerCli : null;
  if (workerCli === null && reviewerCli === null) return null;
  // `key` remounts a field when its CLI changes, dropping a stale provider pick.
  return (
    <>
      {workerCli !== null && (
        <ModelField
          key={`model-${workerCli}`}
          label="Model"
          aria="Worker model"
          cli={workerCli}
          role="implementer"
          value={task.modelOverride ?? null}
          resolved={resolvedDefaultModel(workerCli, "implementer", task.body, settings)}
          onChange={(v) => save({ model: v })}
          sidebar={sidebar}
        />
      )}
      {smallCli !== null && (
        <ModelField
          key={`small-${smallCli}`}
          label={sidebar ? "Small" : "Small model"}
          aria="Small model"
          cli={smallCli}
          role="small"
          value={task.smallModelOverride ?? null}
          resolved={resolvedDefaultModel(smallCli, "small", task.body, settings)}
          onChange={(v) => save({ smallModel: v })}
          sidebar={sidebar}
        />
      )}
      {reviewerCli !== null && (
        <ModelField
          key={`reviewer-${reviewerCli}`}
          label={sidebar ? "Model" : "Reviewer model"}
          aria="Reviewer model"
          cli={reviewerCli}
          role="reviewer"
          value={task.reviewerModel ?? null}
          resolved={resolvedDefaultModel(reviewerCli, "reviewer", task.body, settings)}
          onChange={(v) => save({ reviewerModel: v })}
          sidebar={sidebar}
        />
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </>
  );
}
