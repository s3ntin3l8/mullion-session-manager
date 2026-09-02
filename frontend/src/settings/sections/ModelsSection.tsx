import { useEffect, useState } from "react";
import { useDashboardStore } from "../../store/index.js";
import { api } from "../../api/index.js";
import { Row } from "../../ui/primitives.js";

export function ModelsSection() {
  const { settings, updateSettings } = useDashboardStore();
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    api
      .listOpenCodeModels()
      .then(setModels)
      .catch(() => {});
  }, []);

  const disabled = settings.launchers?.defaultAgent !== "opencode";
  const implementerValue = settings.opencode?.implementerModel ?? "";
  const reviewerValue = settings.opencode?.reviewerModel ?? "";

  const handleChange = (key: "implementerModel" | "reviewerModel", value: string) => {
    updateSettings({
      opencode: { [key]: value || null },
    });
  };

  return (
    <>
      <Row label="Implementer model" desc="Default model for task worker sessions.">
        <select
          className="settings-select"
          value={implementerValue}
          disabled={disabled}
          onChange={(e) => handleChange("implementerModel", e.target.value)}
        >
          <option value="">— None (CLI default) —</option>
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Reviewer model" desc="Default model for task review-agent sessions.">
        <select
          className="settings-select"
          value={reviewerValue}
          disabled={disabled}
          onChange={(e) => handleChange("reviewerModel", e.target.value)}
        >
          <option value="">— None (CLI default) —</option>
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </Row>
      <p
        style={{
          fontSize: 12,
          color: "var(--muted)",
          margin: "4px 0 0",
          paddingLeft: 6,
        }}
      >
        {disabled
          ? "Only available when the default agent is opencode."
          : "Each role can be overridden per task via Model: / Reviewer-Model: lines in the task issue body."}
      </p>
    </>
  );
}
