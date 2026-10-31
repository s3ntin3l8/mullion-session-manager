import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useDashboardStore } from "../../store/index.js";
import { api, normalizeAgentId } from "../../api/index.js";
import type { AppSettings } from "../../api/index.js";
import { ModelSelect } from "../ModelPicker.js";
import type { ModelOption } from "../ModelPicker.js";
import {
  CLAUDE_MODELS,
  CLAUDE_SMALL_MODELS,
  CODEX_FALLBACK_MODELS,
  useCatalog,
} from "../../models/modelCatalogs.js";
import { isClaudeModelAlias } from "../../cliModel.js";
import {
  buildCliModelPairs,
  resolveInstalledRoleModels,
  type InstalledRoleModels,
} from "../../modelRoles.js";
import { AGENT_OPTIONS } from "../agentOptions.js";

// Issue #2073 — one row per CLI, columns for the three roles. Order and
// visible names come from AGENT_OPTIONS so this list cannot drift from the
// Agents page (Antigravity, not "agy"). A CLI with no entry here is not a
// model-capable agent and is not rendered.
function cliLayout(key: string): { hasSmall: boolean; allowCustom: boolean } | null {
  switch (key) {
    case "claude":
      return { hasSmall: true, allowCustom: true };
    case "codex":
      return { hasSmall: false, allowCustom: true };
    case "opencode":
      return { hasSmall: true, allowCustom: false };
    case "agy":
      return { hasSmall: false, allowCustom: true };
    case "mcode":
      return { hasSmall: false, allowCustom: true };
    default:
      return null;
  }
}

const MODEL_CLIS = AGENT_OPTIONS.flatMap((option) => {
  const layout = cliLayout(option.value);
  return layout ? [{ ...option, ...layout }] : [];
});

// Column header copy. The phone card hides that header, but it does not
// repeat these sentences: the legend already covers new sessions, and an
// empty Small cell is simply absent. The card only keeps the bit the empty
// control does not say itself.
const ROLE_COPY = {
  implementer: { label: "Implementer", desc: "New sessions and workers." },
  reviewer: {
    label: "Reviewer",
    desc: "Review sessions. Empty follows the implementer, except opencode.",
  },
  small: { label: "Small", desc: "Background work. Only Claude Code and opencode." },
} as const;

function cardDesc(cli: string, role: "implementer" | "reviewer" | "small"): string | null {
  if (role === "reviewer") {
    // opencode's empty reviewer is its own default, not the implementer, so
    // the shared "except opencode" clause would be talking about this row.
    return cli === "opencode"
      ? "Empty stays on opencode's own default."
      : "Empty follows the implementer.";
  }
  if (role === "small") return "Background work.";
  return null;
}

type AgentProbe =
  { status: "loading" } | { status: "error" } | { status: "ready"; available: ReadonlySet<string> };

/**
 * Which model CLIs are actually on this host.
 *
 * This is NOT `resolveInstalledRoleModels`. That function answers which
 * model the worker and the reviewer resolve to at the install-wide tier
 * ("installed" there means install-wide, not "the binary exists"). The
 * on-disk signal is the same `available` flag Settings → Agents already
 * renders, from GET /api/agents.
 *
 * `loading` and `error` are not "nothing is installed" — collapsing on
 * either would flash every row shut, and a failed probe would hide CLIs
 * the user can still configure.
 */
function useDetectedAgents(): AgentProbe {
  const [probe, setProbe] = useState<AgentProbe>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    api
      .listAgents()
      .then((agents) => {
        if (cancelled) return;
        const available = new Set<string>();
        for (const agent of agents) {
          if (agent.kind === "agent" && agent.available) available.add(normalizeAgentId(agent.id));
        }
        setProbe({ status: "ready", available });
      })
      .catch(() => {
        if (!cancelled) setProbe({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return probe;
}

function hasStoredModel(settings: AppSettings, key: string): boolean {
  const present = (value: string | null | undefined) => value != null && value !== "";
  switch (key) {
    case "claude":
      return (
        present(settings.claudeCode.defaultModel) ||
        present(settings.claudeCode.reviewerModel) ||
        present(settings.claudeCode.smallModel)
      );
    case "codex":
      return present(settings.codex.defaultModel) || present(settings.codex.reviewerModel);
    case "agy":
      return present(settings.agy.defaultModel) || present(settings.agy.reviewerModel);
    case "mcode":
      return present(settings.mcode.defaultModel) || present(settings.mcode.reviewerModel);
    case "opencode":
      return (
        present(settings.opencode.implementerModel) ||
        present(settings.opencode.reviewerModel) ||
        present(settings.opencode.defaultSmallModel)
      );
    default:
      return false;
  }
}

/** In the main list, not behind "Show N more". */
function isPrimary(settings: AppSettings, key: string, probe: AgentProbe): boolean {
  if (probe.status !== "ready") return true;
  if (probe.available.has(key)) return true;
  if (settings.taskMaster.defaultAgent === key || settings.taskMaster.defaultReviewAgent === key) {
    return true;
  }
  return hasStoredModel(settings, key);
}

function moreLabel(count: number, open: boolean): string {
  const noun = count === 1 ? "CLI" : "CLIs";
  return open ? `Hide ${count} ${noun}` : `Show ${count} more ${noun}`;
}

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
    <p className="settings-models-warning">
      Install-wide, your reviewer runs on the same model as your worker ({roles.reviewer}) — no
      second opinion. A task's own <code>Model:</code> / <code>Reviewer-Model:</code> line overrides
      this — and <code>Model:</code> applies to both roles, so it can also make them the same.
    </p>
  );
}

/**
 * The Small model picker used to offer aliases (`haiku`…), and an install may
 * still have one stored. The server ignores it (an alias there would break
 * every haiku-backed Claude Code feature, issue #2032), so say so instead of
 * leaving a setting that silently does nothing.
 */
function smallModelAliasWarning(value: string | null): ReactNode {
  if (value === null || !isClaudeModelAlias(value)) return null;
  return (
    <p className="settings-models-warning">
      <code>{value}</code> is a model alias, not a full model id, so Mullion ignores it and Claude
      Code uses its own default. Pick a full id (or Claude Code default) to clear this.
    </p>
  );
}

function ariaName(label: string, role: "implementer" | "reviewer" | "small"): string {
  return `${label} ${role} model`;
}

export function ModelsSection() {
  const { settings, updateSettings } = useDashboardStore();
  const opencode = useCatalog(api.listOpenCodeModels);
  const agy = useCatalog(api.listAgyModels);
  const codex = useCatalog(api.listCodexModels);
  // Issue #1784 — mcode's catalog, read from mcode's own config.yaml by the
  // backend (GET /api/mcode/models).
  const mcode = useCatalog(api.listMcodeModels);
  const probe = useDetectedAgents();
  const [showRest, setShowRest] = useState(false);

  const setOpencode = (
    key: "implementerModel" | "reviewerModel" | "defaultSmallModel",
    value: string | null,
  ) => updateSettings({ opencode: { [key]: value } });

  const opencodeOptions = opencode.models.map((value) => ({ value }));
  const codexOptions =
    codex.models.length > 0 ? codex.models.map((value) => ({ value })) : CODEX_FALLBACK_MODELS;
  const agyOptions = agy.models.map((value) => ({ value }));
  const mcodeOptions = mcode.models.map((value) => ({ value }));

  // Each CLI's own two roles, keyed by the agent-option value the
  // install-wide agent settings use ("claude", "codex", "agy", "opencode").
  const cliPairs = buildCliModelPairs(settings);

  // The models the two roles ACTUALLY run — the worker agent and the
  // review agent are chosen independently, so they can be different CLIs,
  // and each side's model then comes from that CLI's own settings.
  const installedRoles = resolveInstalledRoleModels({
    workerCli: settings.taskMaster?.defaultAgent,
    // "hermes" is an HTTP reviewer, not a model CLI: it has no per-CLI model
    // here (its model is Review relay → Review policy → Model), so it must not
    // be matched against any CLI card.
    reviewCli:
      settings.taskMaster?.defaultReviewAgent === "hermes"
        ? null
        : settings.taskMaster?.defaultReviewAgent,
    pairs: cliPairs,
  });

  const primaryCount = MODEL_CLIS.filter((cli) => isPrimary(settings, cli.value, probe)).length;
  const showAll = primaryCount === 0 || primaryCount === MODEL_CLIS.length;
  const hiddenCount = showAll ? 0 : MODEL_CLIS.length - primaryCount;

  const catalogNote = (key: string): string | null => {
    if (key === "agy") {
      if (agy.status === "error") {
        return "Couldn't load the agy model list. Try reopening Settings, or use Custom….";
      }
      if (agy.status === "ready" && agy.models.length === 0) {
        return "No models found. Check that agy is installed and signed in, or use Custom….";
      }
      return null;
    }
    if (key === "opencode") {
      if (opencode.status === "error") {
        // Reached only for a genuine HTTP/network failure fetching
        // GET /api/opencode/models — NOT for "opencode isn't installed":
        // listOpenCodeModels() swallows exec failures (ENOENT included) and
        // returns [], so that case lands in the "ready && empty" branch.
        return "Couldn't load the model list. Try reopening Settings.";
      }
      if (opencode.status === "ready" && opencode.models.length === 0) {
        return "No models found. Check that opencode is installed and has a provider configured.";
      }
      return "Pick from opencode's list — no custom id. A task can also set SmallModel:.";
    }
    if (key === "mcode") {
      if (mcode.status === "error") {
        return "Couldn't load the MiniMax Code model list. Try reopening Settings, or use Custom….";
      }
      if (mcode.status === "ready" && mcode.models.length === 0) {
        return "No models found. Check that mcode is installed and signed in, or use Custom….";
      }
      return null;
    }
    return null;
  };

  const roleBinding = (
    key: string,
    role: "implementer" | "reviewer" | "small",
    label: string,
  ): {
    value: string | null;
    options: ModelOption[];
    defaultLabel: string;
    allowCustom: boolean;
    onChange: (value: string | null) => void;
  } | null => {
    const layout = cliLayout(key);
    if (!layout) return null;
    if (role === "small" && !layout.hasSmall) return null;
    const allowCustom = layout.allowCustom;
    if (key === "claude") {
      if (role === "small") {
        return {
          value: settings.claudeCode.smallModel,
          options: CLAUDE_SMALL_MODELS,
          defaultLabel: "Claude Code default",
          allowCustom,
          onChange: (v) => updateSettings({ claudeCode: { smallModel: v } }),
        };
      }
      return role === "implementer"
        ? {
            value: settings.claudeCode.defaultModel,
            options: CLAUDE_MODELS,
            defaultLabel: "Claude Code default",
            allowCustom,
            onChange: (v) => updateSettings({ claudeCode: { defaultModel: v } }),
          }
        : {
            value: settings.claudeCode.reviewerModel,
            options: CLAUDE_MODELS,
            defaultLabel: "Same as implementer",
            allowCustom,
            onChange: (v) => updateSettings({ claudeCode: { reviewerModel: v } }),
          };
    }
    if (key === "codex") {
      return {
        value: role === "implementer" ? settings.codex.defaultModel : settings.codex.reviewerModel,
        options: codexOptions,
        defaultLabel: role === "implementer" ? "Codex default" : "Same as implementer",
        allowCustom,
        onChange: (v) =>
          updateSettings(
            role === "implementer"
              ? { codex: { defaultModel: v } }
              : { codex: { reviewerModel: v } },
          ),
      };
    }
    if (key === "agy") {
      return {
        value: role === "implementer" ? settings.agy.defaultModel : settings.agy.reviewerModel,
        options: agyOptions,
        defaultLabel: role === "implementer" ? `${label} default` : "Same as implementer",
        allowCustom,
        onChange: (v) =>
          updateSettings(
            role === "implementer" ? { agy: { defaultModel: v } } : { agy: { reviewerModel: v } },
          ),
      };
    }
    if (key === "mcode") {
      return {
        value: role === "implementer" ? settings.mcode.defaultModel : settings.mcode.reviewerModel,
        options: mcodeOptions,
        defaultLabel: role === "implementer" ? "mcode default" : "Same as implementer",
        allowCustom,
        onChange: (v) =>
          updateSettings(
            role === "implementer"
              ? { mcode: { defaultModel: v } }
              : { mcode: { reviewerModel: v } },
          ),
      };
    }
    if (key === "opencode") {
      const field =
        role === "implementer"
          ? "implementerModel"
          : role === "reviewer"
            ? "reviewerModel"
            : "defaultSmallModel";
      return {
        value: settings.opencode[field],
        options: opencodeOptions,
        defaultLabel: "opencode default",
        allowCustom,
        onChange: (v) => setOpencode(field, v),
      };
    }
    return null;
  };

  return (
    <div className="settings-models">
      <p className="settings-models-legend">
        Install-wide defaults for new sessions and Task Master workers. A task's <code>Model:</code>{" "}
        or <code>Reviewer-Model:</code> line overrides them, and <code>Model:</code> applies to both
        roles. A launcher that already passes <code>--model</code> (or <code>-m</code> for MiniMax
        Code) is left alone. These are model settings for local CLIs; when the review agent is
        Hermes, its model is set under Review relay → Review policy → Model instead.
      </p>
      <div className="settings-models-grid">
        <div className="settings-models-head">
          <span />
          {(["implementer", "reviewer", "small"] as const).map((role) => (
            <span key={role}>
              <span className="settings-models-col">{ROLE_COPY[role].label}</span>
              <span className="settings-models-col-desc">{ROLE_COPY[role].desc}</span>
            </span>
          ))}
        </div>
        {MODEL_CLIS.filter(
          (cli) => showAll || showRest || isPrimary(settings, cli.value, probe),
        ).map((cli) => {
          const note = catalogNote(cli.value);
          const notDetected = probe.status === "ready" && !probe.available.has(cli.value);
          const implementer = roleBinding(cli.value, "implementer", cli.label);
          const reviewer = roleBinding(cli.value, "reviewer", cli.label);
          const small = roleBinding(cli.value, "small", cli.label);
          return (
            <div
              key={cli.value}
              className="settings-models-row"
              data-testid={`models-row-${cli.value}`}
            >
              <div className="settings-models-name">
                {cli.label}
                {notDetected && <span className="settings-models-missing">not detected</span>}
              </div>
              {implementer && (
                <RoleCell
                  label={ROLE_COPY.implementer.label}
                  desc={cardDesc(cli.value, "implementer")}
                  ariaLabel={ariaName(cli.label, "implementer")}
                  {...implementer}
                />
              )}
              {reviewer && (
                <RoleCell
                  label={ROLE_COPY.reviewer.label}
                  desc={cardDesc(cli.value, "reviewer")}
                  ariaLabel={ariaName(cli.label, "reviewer")}
                  {...reviewer}
                />
              )}
              {small ? (
                <RoleCell
                  label={ROLE_COPY.small.label}
                  desc={cardDesc(cli.value, "small")}
                  ariaLabel={ariaName(cli.label, "small")}
                  {...small}
                />
              ) : (
                <div className="settings-models-cell settings-models-cell-empty">
                  <span className="settings-models-role" aria-hidden="true">
                    Small
                  </span>
                  <span className="settings-models-empty">
                    <span aria-hidden="true">—</span>
                    <span className="visually-hidden">{cli.label} has no small-model setting</span>
                  </span>
                </div>
              )}
              <div className="settings-models-wide">
                {note && <p className="settings-models-note">{note}</p>}
                {/* Always mounted so a warning's arrival is announced. Empty
                    when there is nothing to say. Catalog notes stay outside
                    this region: they appear because a fetch finished, not
                    because the user changed a dropdown. */}
                <div className="settings-models-status" role="status">
                  {reviewerModelWarning(cli.value, installedRoles)}
                  {cli.value === "claude"
                    ? smallModelAliasWarning(settings.claudeCode.smallModel)
                    : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {hiddenCount > 0 && (
        <button
          type="button"
          className="settings-add-btn"
          aria-expanded={showRest}
          onClick={() => setShowRest((open) => !open)}
        >
          {moreLabel(hiddenCount, showRest)}
        </button>
      )}
    </div>
  );
}

function RoleCell({
  label,
  desc,
  ariaLabel,
  value,
  options,
  defaultLabel,
  allowCustom,
  onChange,
}: {
  label: string;
  desc: string | null;
  ariaLabel: string;
  value: string | null;
  options: ModelOption[];
  defaultLabel: string;
  allowCustom: boolean;
  onChange: (value: string | null) => void;
}) {
  return (
    <div className="settings-models-cell">
      <span className="settings-models-role" aria-hidden="true">
        {label}
      </span>
      {desc && <span className="settings-models-role-desc">{desc}</span>}
      <ModelSelect
        stretch
        ariaLabel={ariaLabel}
        value={value}
        options={options}
        defaultLabel={defaultLabel}
        allowCustom={allowCustom}
        onChange={onChange}
      />
    </div>
  );
}
