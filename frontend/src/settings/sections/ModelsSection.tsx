import { useEffect, useState } from "react";
import { useDashboardStore } from "../../store/index.js";
import { api } from "../../api/index.js";
import { Row } from "../../ui/primitives.js";

export function ModelsSection() {
  const { settings, updateSettings } = useDashboardStore();
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    api.listOpenCodeModels().then(setModels).catch(() => {});
  }, []);

  const disabled = settings.launchers?.defaultAgent !== "opencode";
  const defaultValue = settings.opencode?.defaultModel ?? "";

  return (
    <>
      <Row
        label="Default model"
        desc="Select the default opencode model for new sessions."
      >
        <select
          className="settings-select"
          value={defaultValue}
          disabled={disabled}
          onChange={(e) => {
            updateSettings({
              opencode: { defaultModel: e.target.value || null },
            });
          }}
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
          : "Choose the default model for new opencode sessions. Can be overridden per task via a Model: line in the task issue body."}
      </p>
    </>
  );
}
