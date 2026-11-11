import { useState } from "react";
import { api, normalizeAgentId } from "../api/index.js";
import type { Launcher, Task } from "../api/index.js";
import { commandToBinary } from "../cliLogos.js";
import { useAsyncData } from "../hooks/useAsyncData.js";
import { resolvedDefaultModel } from "../lib/taskModelDefault.js";
import { commandModelCli } from "../models/modelCatalogs.js";
import {
  HERMES_REVIEW_OPTION,
  hermesReviewerAvailable,
  withCurrentReviewAgent,
} from "../settings/agentOptions.js";
import { useDashboardStore } from "../store/index.js";
import { TaskModelControls } from "../TaskModelControls.js";
import { ErrorText } from "../ui/ErrorText.js";
import { BotIcon } from "../ui/icons.js";
import { Dropdown } from "../ui/primitives.js";

// The per-task agent and model overrides, back in the task sidebar after the
// epic #2847 redesign dropped them: Worker and Reviewer rows in Details show
// the effective value and where it comes from, and "Edit" unfolds the
// dropdowns in place (the old panel's Agent, Review agent, Model, Small model
// and Reviewer model). Collapsed by default, so the dropdowns exist only when
// the user asks for them. Editable in the same statuses as before.

const UNSET_AGENT = "";

type Source = "task" | "issue" | "default";

function isAgentConfigEditable(task: Task): boolean {
  return (
    task.status === "backlog" ||
    (task.status === "ready" && task.agentCommand === null) ||
    task.status === "failed"
  );
}

function sourceOf(task: string | null, issue: string | null): Source {
  return task ? "task" : issue ? "issue" : "default";
}

function SourceTag({ source }: { source: Source }) {
  return (
    <span className="sb-dim sb-agent-src">
      {source === "task" && <span className="sb-ov-dot" title="Set on this task" aria-hidden />}(
      {source})
    </span>
  );
}

export function TaskAgents({ task }: { task: Task }) {
  const settings = useDashboardStore((s) => s.settings);
  const projects = useDashboardStore((s) => s.projects);
  const updateTask = useDashboardStore((s) => s.updateTask);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launchers, setLaunchers] = useState<Launcher[]>([]);

  const editable = isAgentConfigEditable(task);
  const unfolded = open && editable;
  // The agent list is only needed once the dropdowns exist.
  useAsyncData(
    () => api.listProjectActions(task.projectId),
    (all) => setLaunchers(all.filter((l) => l.kind === "agent")),
    (e) =>
      setError(
        e instanceof Error ? `Could not load agents: ${e.message}` : "Could not load agents",
      ),
    [task.projectId],
    { enabled: unfolded },
  );

  const project = projects?.find((p) => p.id === task.projectId);
  const projectDefaultAgent =
    project?.defaultAgent || settings?.taskMaster?.defaultAgent || "claude";
  const projectDefaultReviewAgent =
    project?.defaultReviewAgent || settings?.taskMaster?.defaultReviewAgent || "none";
  const workerAgent = task.agent || task.issueAgent || projectDefaultAgent;
  const reviewAgent = task.reviewAgent || task.issueReviewAgent || projectDefaultReviewAgent;
  const hermes = reviewAgent === HERMES_REVIEW_OPTION.value;
  const reviewerAgent = reviewAgent === "none" || hermes ? null : reviewAgent;

  const workerCli = commandModelCli(workerAgent);
  const reviewerCli = reviewerAgent === null ? null : commandModelCli(reviewerAgent);
  const workerModel =
    task.modelOverride ??
    (workerCli ? resolvedDefaultModel(workerCli, "implementer", task.body, settings) : null);
  const reviewerModel = reviewerCli
    ? (task.reviewerModel ?? resolvedDefaultModel(reviewerCli, "reviewer", task.body, settings))
    : null;

  const workerName =
    !editable && task.agentCommand ? commandToBinary(task.agentCommand) : workerAgent;
  const reviewerName = hermes ? "Hermes" : reviewAgent;

  const hermesAvailable = hermesReviewerAvailable(settings?.reviewRelay);
  const agentOptions = Array.from(
    new Map(launchers.map((l) => [normalizeAgentId(l.id), l.title])).entries(),
  ).map(([value, label]) => ({ value, label }));
  const withCurrent = (options: { value: string; label: string }[], current: string) =>
    current === UNSET_AGENT || options.some((o) => o.value === current)
      ? options
      : withCurrentReviewAgent(options, current);

  const unsetAgentLabel = task.issueAgent
    ? `${task.issueAgent} (from issue)`
    : `Project default (${projectDefaultAgent})`;
  const unsetReviewLabel = task.issueReviewAgent
    ? `${task.issueReviewAgent === "none" ? "None (disabled)" : task.issueReviewAgent} (from issue)`
    : `Project default (${projectDefaultReviewAgent === "none" ? "None" : projectDefaultReviewAgent})`;

  const save = async (patch: Parameters<typeof updateTask>[1]) => {
    setError(null);
    try {
      await updateTask(task.id, patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    }
  };

  return (
    <div className="sb-agents">
      <dl className="sb-kv">
        <dt>Worker</dt>
        <dd>
          {workerName}
          {workerModel ? ` · ${workerModel}` : ""}{" "}
          <SourceTag source={sourceOf(task.agent, task.issueAgent)} />
          {editable && (
            <button
              type="button"
              className="sb-link sb-agent-edit"
              aria-expanded={unfolded}
              onClick={() => setOpen((v) => !v)}
            >
              {unfolded ? "Done" : "Edit"}
            </button>
          )}
        </dd>
        <dt>Reviewer</dt>
        <dd>
          {reviewerName}
          {reviewerModel ? ` · ${reviewerModel}` : ""}{" "}
          <SourceTag source={sourceOf(task.reviewAgent, task.issueReviewAgent)} />
        </dd>
      </dl>
      {!editable && (
        <p className="sb-dim sb-agent-lock">
          Locked once a worker has claimed the task. Retry it, or move it to Backlog, to change.
        </p>
      )}
      {unfolded && (
        <div className="task-detail-agents-config">
          <div className="task-detail-agent-select">
            <span className="task-detail-agent-label">
              <BotIcon size={12} /> Agent:
            </span>
            <Dropdown
              ariaLabel="Worker agent"
              value={task.agent ?? UNSET_AGENT}
              onChange={(val) => save({ agent: val === UNSET_AGENT ? null : val })}
              options={withCurrent(
                [{ value: UNSET_AGENT, label: unsetAgentLabel }, ...agentOptions],
                task.agent ?? UNSET_AGENT,
              )}
            />
          </div>
          <div className="task-detail-agent-select">
            <span className="task-detail-agent-label">
              <BotIcon size={12} /> Review agent:
            </span>
            <Dropdown
              ariaLabel="Review agent"
              value={task.reviewAgent ?? UNSET_AGENT}
              onChange={(val) => save({ reviewAgent: val === UNSET_AGENT ? null : val })}
              options={withCurrent(
                [
                  { value: UNSET_AGENT, label: unsetReviewLabel },
                  { value: "none", label: "None (disabled)" },
                  ...(hermesAvailable ? [HERMES_REVIEW_OPTION] : []),
                  ...agentOptions,
                ],
                task.reviewAgent ?? UNSET_AGENT,
              )}
            />
          </div>
          <TaskModelControls
            task={task}
            workerAgent={workerAgent}
            reviewerAgent={reviewerAgent}
            settings={settings}
            onUpdate={(patch) => updateTask(task.id, patch)}
          />
          {error && <ErrorText>{error}</ErrorText>}
        </div>
      )}
    </div>
  );
}
