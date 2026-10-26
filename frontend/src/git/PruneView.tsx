import { useEffect, useState } from "react";
import { api } from "../api/index.js";
import type { GitBranchPruneResult } from "../api/types.js";
import { describeError } from "../lib/describeError.js";
import { TrashIcon } from "../ui/icons.js";
import { Button, DetailHeader, StatusChip } from "../ui/sidebar/index.js";
import { PRUNE_SKIP_LABEL, mergeChip } from "./branchGroups.js";
import { refreshGitEverywhere } from "./useSourceControl.js";
import { useRepoUrl } from "./useRepoUrl.js";

type Phase =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string }
  | { kind: "preview"; plan: GitBranchPruneResult }
  | { kind: "done"; result: GitBranchPruneResult };

export interface PruneViewProps {
  projectId: number;
  onBack: () => void;
  onDone: () => void;
}

/**
 * Prune preview: what would go (with why), what is protected (with why), and a
 * Confirm that deletes exactly the ticked names. Local only — the server never
 * touches the remote and re-validates every name against a fresh read.
 */
export function PruneView({ projectId, onBack, onDone }: PruneViewProps) {
  const repoUrl = useRepoUrl(projectId);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .pruneProjectGitBranches(projectId, { dryRun: true })
      .then((plan) => {
        if (cancelled) return;
        if (!plan) {
          setPhase({ kind: "unavailable" });
          return;
        }
        setSelected(new Set(plan.candidates.map((c) => c.name)));
        setPhase({ kind: "preview", plan });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPhase({ kind: "error", message: describeError(err, "Could not preview the prune.") });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const confirm = async () => {
    if (phase.kind !== "preview" || selected.size === 0) return;
    setBusy(true);
    try {
      const result = await api.pruneProjectGitBranches(projectId, {
        confirm: true,
        names: [...selected],
      });
      refreshGitEverywhere(projectId);
      if (!result) setPhase({ kind: "unavailable" });
      else setPhase({ kind: "done", result });
    } catch (err) {
      setPhase({ kind: "error", message: describeError(err, "The prune failed.") });
    } finally {
      setBusy(false);
    }
  };

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  return (
    <div className="sc-detail">
      <DetailHeader
        onBack={phase.kind === "done" ? onDone : onBack}
        backLabel="Back to Source Control"
        title="Prune merged branches"
        subtitle="Local only · remotes are never touched"
        externalUrl={repoUrl}
        externalLabel="Open repository on GitHub"
      />
      <div className="sc-scroll">
        {phase.kind === "loading" && <div className="sc-empty">Checking branches…</div>}
        {phase.kind === "unavailable" && (
          <div className="sc-empty">Pruning is only available for projects on this host.</div>
        )}
        {phase.kind === "error" && (
          <div className="sc-row-error" role="alert">
            {phase.message}
          </div>
        )}
        {phase.kind === "preview" && (
          <PreviewBody
            plan={phase.plan}
            selected={selected}
            onToggle={toggle}
            onAll={(all) =>
              setSelected(new Set(all ? phase.plan.candidates.map((c) => c.name) : []))
            }
          />
        )}
        {phase.kind === "done" && <DoneBody result={phase.result} />}
      </div>
      {phase.kind === "preview" && (
        <div className="sc-sticky">
          <Button
            variant="danger"
            onClick={() => void confirm()}
            disabled={busy || selected.size === 0}
          >
            <TrashIcon size={12} />{" "}
            {busy
              ? "Deleting…"
              : `Delete ${selected.size} branch${selected.size === 1 ? "" : "es"}`}
          </Button>
          <Button variant="ghost" onClick={onBack} disabled={busy}>
            Cancel
          </Button>
        </div>
      )}
      {phase.kind === "done" && (
        <div className="sc-sticky">
          <Button onClick={onDone}>Done</Button>
        </div>
      )}
    </div>
  );
}

function PreviewBody({
  plan,
  selected,
  onToggle,
  onAll,
}: {
  plan: GitBranchPruneResult;
  selected: ReadonlySet<string>;
  onToggle: (name: string) => void;
  onAll: (all: boolean) => void;
}) {
  return (
    <>
      <div className="sc-callout">
        {plan.candidates.length === 0
          ? "No local branch is merged, squash-merged or left without an upstream."
          : `${plan.candidates.length} local branch${plan.candidates.length === 1 ? " is" : "es are"} done. Squash-merged ones are found through merged PRs and “upstream gone” — no Force needed.`}
      </div>
      {plan.candidates.length > 0 && (
        <>
          <div className="sc-group-h">
            <b>Will delete</b>
            <span className="sb-count">
              {selected.size}/{plan.candidates.length}
            </span>
            <button
              type="button"
              className="sc-link"
              onClick={() => onAll(selected.size !== plan.candidates.length)}
            >
              {selected.size === plan.candidates.length ? "Select none" : "Select all"}
            </button>
          </div>
          {plan.candidates.map((c) => {
            const chip = mergeChip(c.reason);
            return (
              <label key={c.name} className="sc-prune-item">
                <input
                  type="checkbox"
                  checked={selected.has(c.name)}
                  onChange={() => onToggle(c.name)}
                />
                <span>
                  <span className="mono sc-prune-name">{c.name}</span>
                  <span className="sc-prune-why">
                    <StatusChip tone={chip.tone} title={chip.title}>
                      {chip.label}
                    </StatusChip>
                    {chip.title}
                  </span>
                </span>
              </label>
            );
          })}
        </>
      )}
      {plan.skipped.length > 0 && (
        <>
          <div className="sc-group-h">
            <b>Skipped — protected</b>
            <span className="sb-count">{plan.skipped.length}</span>
          </div>
          {plan.skipped.map((s) => (
            <div key={s.name} className="sc-prune-item">
              <span className="sc-prune-spacer" />
              <span>
                <span className="mono sc-prune-name">{s.name}</span>
                <span className="sc-prune-why">
                  <StatusChip tone={s.why === "task-claimed" ? "merged" : "neutral"}>
                    {s.why}
                  </StatusChip>
                  {PRUNE_SKIP_LABEL[s.why] ?? s.why}
                </span>
              </span>
            </div>
          ))}
        </>
      )}
    </>
  );
}

function DoneBody({ result }: { result: GitBranchPruneResult }) {
  return (
    <>
      <div className="sc-callout" role="status">
        Deleted {result.deleted.length} branch{result.deleted.length === 1 ? "" : "es"} locally.
      </div>
      {result.failed.length > 0 && (
        <>
          <div className="sc-group-h">
            <b>Not deleted</b>
            <span className="sb-count">{result.failed.length}</span>
          </div>
          {result.failed.map((f) => (
            <div key={f.name} className="sc-prune-item">
              <span className="sc-prune-spacer" />
              <span>
                <span className="mono sc-prune-name">{f.name}</span>
                <span className="sc-prune-why">{PRUNE_SKIP_LABEL[f.why] ?? f.why}</span>
              </span>
            </div>
          ))}
        </>
      )}
    </>
  );
}
