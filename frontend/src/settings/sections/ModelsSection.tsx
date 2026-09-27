import { useDashboardStore } from "../../store/index.js";
import { api } from "../../api/index.js";
import { GroupHeading } from "../../ui/primitives.js";
import { ModelPicker } from "../ModelPicker.js";
import { CLAUDE_MODELS, CODEX_FALLBACK_MODELS, useCatalog } from "../../models/modelCatalogs.js";

const hintStyle = { fontSize: 12, color: "var(--muted)", margin: "4px 0 0", paddingLeft: 6 };

const FLAG_HINT =
  "Adds --model to new sessions and Task Master workers. A task's Model: line overrides it; a launcher command that already passes --model is left alone.";

export function ModelsSection() {
  const { settings, updateSettings } = useDashboardStore();
  const opencode = useCatalog(api.listOpenCodeModels);
  const agy = useCatalog(api.listAgyModels);
  const codex = useCatalog(api.listCodexModels);

  const setOpencode = (
    key: "implementerModel" | "reviewerModel" | "defaultSmallModel",
    value: string | null,
  ) => updateSettings({ opencode: { [key]: value } });

  const opencodeOptions = opencode.models.map((value) => ({ value }));

  return (
    <>
      <GroupHeading title="Claude Code" />
      <ModelPicker
        label="Default model"
        ariaLabel="Claude Code default model"
        desc="Model for new Claude Code sessions."
        value={settings.claudeCode?.defaultModel ?? null}
        options={CLAUDE_MODELS}
        defaultLabel="Claude Code default"
        allowCustom
        onChange={(v) => updateSettings({ claudeCode: { defaultModel: v } })}
      />
      <p style={hintStyle}>{FLAG_HINT}</p>

      <div style={{ paddingTop: 12 }}>
        <GroupHeading title="Codex" />
      </div>
      <ModelPicker
        label="Default model"
        ariaLabel="Codex default model"
        desc="Model for new Codex sessions."
        value={settings.codex?.defaultModel ?? null}
        options={
          codex.models.length > 0 ? codex.models.map((value) => ({ value })) : CODEX_FALLBACK_MODELS
        }
        defaultLabel="Codex default"
        allowCustom
        onChange={(v) => updateSettings({ codex: { defaultModel: v } })}
      />
      <p style={hintStyle}>{FLAG_HINT}</p>

      <div style={{ paddingTop: 12 }}>
        <GroupHeading title="agy" />
      </div>
      <ModelPicker
        label="Default model"
        ariaLabel="agy default model"
        desc="Model for new agy sessions."
        value={settings.agy?.defaultModel ?? null}
        options={agy.models.map((value) => ({ value }))}
        defaultLabel="agy default"
        allowCustom
        onChange={(v) => updateSettings({ agy: { defaultModel: v } })}
      />
      <p style={hintStyle}>
        {agy.status === "error"
          ? "Couldn't load the agy model list. Try reopening Settings, or use Custom…."
          : agy.status === "ready" && agy.models.length === 0
            ? "No models found. Check that agy is installed and signed in, or use Custom…."
            : FLAG_HINT}
      </p>

      <div style={{ paddingTop: 12 }}>
        <GroupHeading title="opencode" />
      </div>
      <ModelPicker
        label="Implementer model"
        desc="Model for sessions that work on tasks."
        value={settings.opencode?.implementerModel ?? null}
        options={opencodeOptions}
        defaultLabel="opencode default"
        allowCustom={false}
        onChange={(v) => setOpencode("implementerModel", v)}
      />
      <ModelPicker
        label="Reviewer model"
        desc="Model for sessions that review tasks."
        value={settings.opencode?.reviewerModel ?? null}
        options={opencodeOptions}
        defaultLabel="opencode default"
        allowCustom={false}
        onChange={(v) => setOpencode("reviewerModel", v)}
      />
      <ModelPicker
        label="Small model"
        desc="Model for lightweight jobs such as generating titles."
        value={settings.opencode?.defaultSmallModel ?? null}
        options={opencodeOptions}
        defaultLabel="opencode default"
        allowCustom={false}
        onChange={(v) => setOpencode("defaultSmallModel", v)}
      />
      <p style={hintStyle}>
        {opencode.status === "error"
          ? // Reached only for a genuine HTTP/network failure fetching
            // GET /api/opencode/models — NOT for "opencode isn't installed":
            // listOpenCodeModels() swallows exec failures (ENOENT included) and
            // returns [], so that case lands in the "ready && empty" branch.
            "Couldn't load the model list. Try reopening Settings."
          : opencode.status === "ready" && opencode.models.length === 0
            ? "No models found. Check that opencode is installed and has a provider configured."
            : "Applies to opencode sessions only. A task can override these with Model:, Reviewer-Model:, or SmallModel: lines."}
      </p>
    </>
  );
}
