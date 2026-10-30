import { useState } from "react";
import { api } from "../api/index.js";
import { Button } from "../ui/sidebar/index.js";
import { runBranchOp } from "./branchOps.js";
import { TextInput } from "../ui/primitives.js";

export interface NewBranchFormProps {
  projectId: number;
  /** The start point the form opens with — the default base when known. */
  defaultFrom: string;
  onDone: (notice: string) => void;
  onCancel: () => void;
}

/**
 * The Branches header's "New branch" (issue #1672): a name, a start point
 * (any branch or remote-tracking ref), and whether to switch to it. The new
 * branch never tracks its start point. A refusal stays in the form, inline.
 */
export function NewBranchForm({ projectId, defaultFrom, onDone, onCancel }: NewBranchFormProps) {
  const [name, setName] = useState("");
  const [from, setFrom] = useState(defaultFrom);
  const [checkout, setCheckout] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const branch = name.trim();
    const start = from.trim();
    if (!branch || !start || busy) return;
    setBusy(true);
    const outcome = await runBranchOp(
      projectId,
      () => api.createProjectGitBranch(projectId, { name: branch, from: start, checkout }),
      () => (checkout ? `Created and switched to ${branch}.` : `Created ${branch}.`),
    );
    setBusy(false);
    if (outcome.ok) onDone(outcome.notice);
    else setError(outcome.message);
  };

  return (
    <form
      className="sc-new-branch"
      aria-label="New branch"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="sc-search ui-input-wrap">
        <TextInput
          small
          aria-label="New branch name"
          placeholder="new-branch-name"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="sc-search ui-input-wrap">
        <span className="sc-dim ui-input-adorn">from</span>
        <TextInput
          aria-label="Start point"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
      </label>
      <div className="sc-new-branch-row">
        <label className="sc-check">
          <input
            type="checkbox"
            checked={checkout}
            onChange={(e) => setCheckout(e.target.checked)}
          />
          Switch to it
        </label>
        <Button
          size="sm"
          variant="primary"
          type="submit"
          disabled={busy || !name.trim() || !from.trim()}
        >
          {busy ? "Creating…" : "Create"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error && (
        <div className="sc-row-error" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}
