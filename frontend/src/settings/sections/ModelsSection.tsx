import { useDashboardStore } from "../../store/index.js";
import type { ReactNode } from "react";
import { api } from "../../api/index.js";
import { GroupHeading } from "../../ui/primitives.js";
import { ModelPicker } from "../ModelPicker.js";
import { CLAUDE_MODELS, CODEX_FALLBACK_MODELS, useCatalog } from "../../models/modelCatalogs.js";
import {
  buildCliModelPairs,
  resolveInstalledRoleModels,
  type InstalledRoleModels,
} from "../../modelRoles.js";

const hintStyle = { fontSize: 12, color: "var(--muted)", margin: "4px 0 0", paddingLeft: 6 };

const warningStyle = {
  fontSize: 11.5,
  // Amber, not the error red: this is an advisory note, and the codebase
  // colours advisory prose amber throughout (PromoteDialog, HostsSection,
  // IntegrationsSection). Red reads as a failure in a neutral settings row.
  color: "var(--y)",
  margin: 0,
  paddingLeft: 6,
  maxWidth: 280,
};

const FLAG_HINT =
  "Adds --model to new sessions and Task Master workers. A task's Model: / Reviewer-Model: line overrides these; a launcher command that already passes --model is left alone.";

/**
 * The advisory note under a reviewer-model picker when the reviewer and the
 * worker run on the SAME model — so the reviewer offers no second opinion.
 *
 * The comparison is between the models the two roles ACTUALLY run, which
 * come from two independent agent settings: the worker agent (an issue's
 * `Agent:` line, the project's default agent, or
 * `settings.taskMaster.defaultAgent`) and the review agent (an issue's
 * `ReviewAgent:` line, the project's default review agent, or
 * `settings.taskMaster.defaultReviewAgent`). They may be different CLIs,
 * and then each side's model comes from that CLI's own settings — so
 * comparing one CLI's two roles against each other would compare two
 * models that never met, and a reviewer on a different CLI is the
 * cheapest way to get a genuinely different model.
 *
 * It is therefore shown only under the REVIEW agent's CLI — under any
 * other CLI the reviewer-model setting is inert, because that CLI is not
 * the one the reviewer runs on.
 *
 * Only fires when both models are explicitly configured. With nothing
 * configured there is no deliberate choice being silently inherited, and
 * warning about it on a fresh install would be noise about nothing.
 *
 * The wording names the per-task directives that outrank this tier, and
 * says that `Model:` applies to BOTH roles: the panel cannot see task
 * bodies, so a task's `Model:` line can create a collapse the panel
 * never sees (and can make the model named here the wrong one). The note
 * points at the levers rather than claiming nothing can change it.
 */
function reviewerModelWarning(cliKey: string, roles: InstalledRoleModels): ReactNode {
  if (!roles.shared) return null;
  if (roles.reviewCli !== cliKey) return null;
  return (
    <p style={warningStyle}>
      Install-wide, your reviewer runs on the same model as your worker ({roles.reviewer}) — no
      second opinion. A task's own <code>Model:</code> / <code>Reviewer-Model:</code> line overrides
      this — and <code>Model:</code> applies to both roles, so it can also make them the same.
    </p>
  );
}

export function ModelsSection() {
  const { settings, updateSettings } = useDashboardStore();
  const opencode = useCatalog(api.listOpenCodeModels);
  const agy = useCatalog(api.listAgyModels);
  const codex = useCatalog(api.listCodexModels);
  // Issue #1784 — mcode's catalog, read from mcode's own config.yaml by the
  // backend (GET /api/mcode/models).
  const mcode = useCatalog(api.listMcodeModels);

  const setOpencode = (
    key: "implementerModel" | "reviewerModel" | "defaultSmallModel",
    value: string | null,
  ) => updateSettings({ opencode: { [key]: value } });

  const opencodeOptions = opencode.models.map((value) => ({ value }));

  // Each CLI's own two roles, keyed by the agent-option value the
  // install-wide agent settings use ("claude", "codex", "agy", "opencode").
  const cliPairs = buildCliModelPairs(settings);

  // The models the two roles ACTUALLY run — the worker agent and the
  // review agent are chosen independently, so they can be different CLIs,
  // and each side's model then comes from that CLI's own settings.
  const installedRoles = resolveInstalledRoleModels({
    workerCli: settings.taskMaster?.defaultAgent,
    reviewCli: settings.taskMaster?.defaultReviewAgent,
    pairs: cliPairs,
  });

  return (
    <>
      <GroupHeading title="Claude Code" />
      <ModelPicker
        label="Implementer model"
        ariaLabel="Claude Code implementer model"
        desc="Model for new Claude Code sessions and Task Master workers."
        value={settings.claudeCode?.defaultModel ?? null}
        options={CLAUDE_MODELS}
        defaultLabel="Claude Code default"
        allowCustom
        onChange={(v) => updateSettings({ claudeCode: { defaultModel: v } })}
      />
      <ModelPicker
        label="Reviewer model"
        ariaLabel="Claude Code reviewer model"
        desc="Model for sessions that review tasks. Empty uses the implementer model."
        value={settings.claudeCode?.reviewerModel ?? null}
        options={CLAUDE_MODELS}
        defaultLabel="Same as implementer"
        allowCustom
        onChange={(v) => updateSettings({ claudeCode: { reviewerModel: v } })}
        warning={reviewerModelWarning("claude", installedRoles)}
      />
      <ModelPicker
        label="Small model"
        ariaLabel="Claude Code small model"
        desc="Model for Claude Code's lightweight background work. Sets ANTHROPIC_DEFAULT_HAIKU_MODEL."
        value={settings.claudeCode?.smallModel ?? null}
        options={CLAUDE_MODELS}
        defaultLabel="Claude Code default"
        allowCustom
        onChange={(v) => updateSettings({ claudeCode: { smallModel: v } })}
      />
      <p style={hintStyle}>{FLAG_HINT}</p>

      <div style={{ paddingTop: 12 }}>
        <GroupHeading title="Codex" />
      </div>
      <ModelPicker
        label="Implementer model"
        ariaLabel="Codex implementer model"
        desc="Model for new Codex sessions and Task Master workers."
        value={settings.codex?.defaultModel ?? null}
        options={
          codex.models.length > 0 ? codex.models.map((value) => ({ value })) : CODEX_FALLBACK_MODELS
        }
        defaultLabel="Codex default"
        allowCustom
        onChange={(v) => updateSettings({ codex: { defaultModel: v } })}
      />
      <ModelPicker
        label="Reviewer model"
        ariaLabel="Codex reviewer model"
        desc="Model for sessions that review tasks. Empty uses the implementer model."
        value={settings.codex?.reviewerModel ?? null}
        options={
          codex.models.length > 0 ? codex.models.map((value) => ({ value })) : CODEX_FALLBACK_MODELS
        }
        defaultLabel="Same as implementer"
        allowCustom
        onChange={(v) => updateSettings({ codex: { reviewerModel: v } })}
        warning={reviewerModelWarning("codex", installedRoles)}
      />
      <p style={hintStyle}>{FLAG_HINT}</p>

      <div style={{ paddingTop: 12 }}>
        <GroupHeading title="agy" />
      </div>
      <ModelPicker
        label="Implementer model"
        ariaLabel="agy implementer model"
        desc="Model for new agy sessions and Task Master workers."
        value={settings.agy?.defaultModel ?? null}
        options={agy.models.map((value) => ({ value }))}
        defaultLabel="agy default"
        allowCustom
        onChange={(v) => updateSettings({ agy: { defaultModel: v } })}
      />
      <ModelPicker
        label="Reviewer model"
        ariaLabel="agy reviewer model"
        desc="Model for sessions that review tasks. Empty uses the implementer model."
        value={settings.agy?.reviewerModel ?? null}
        options={agy.models.map((value) => ({ value }))}
        defaultLabel="Same as implementer"
        allowCustom
        onChange={(v) => updateSettings({ agy: { reviewerModel: v } })}
        warning={reviewerModelWarning("agy", installedRoles)}
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
        warning={reviewerModelWarning("opencode", installedRoles)}
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

      <div style={{ paddingTop: 12 }}>
        <GroupHeading title="MiniMax Code" />
      </div>
      <ModelPicker
        label="Implementer model"
        ariaLabel="MiniMax Code implementer model"
        desc="Model for new MiniMax Code sessions and Task Master workers."
        value={settings.mcode?.defaultModel ?? null}
        options={mcode.models.map((value) => ({ value }))}
        defaultLabel="mcode default"
        allowCustom
        onChange={(v) => updateSettings({ mcode: { defaultModel: v } })}
      />
      <ModelPicker
        label="Reviewer model"
        ariaLabel="MiniMax Code reviewer model"
        desc="Model for sessions that review tasks. Empty uses the implementer model."
        value={settings.mcode?.reviewerModel ?? null}
        options={mcode.models.map((value) => ({ value }))}
        defaultLabel="Same as implementer"
        allowCustom
        onChange={(v) => updateSettings({ mcode: { reviewerModel: v } })}
        warning={reviewerModelWarning("mcode", installedRoles)}
      />
      <p style={hintStyle}>
        {mcode.status === "error"
          ? "Couldn't load the MiniMax Code model list. Try reopening Settings, or use Custom…."
          : mcode.status === "ready" && mcode.models.length === 0
            ? "No models found. Check that mcode is installed and signed in, or use Custom…."
            : "Adds -m to new MiniMax Code sessions and Task Master workers. The list comes from mcode's own config.yaml; a task's Model: / Reviewer-Model: line overrides it."}
      </p>
    </>
  );
}
