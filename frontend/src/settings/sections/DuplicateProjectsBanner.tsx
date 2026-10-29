import { useCallback, useState } from "react";
import { api, ApiError } from "../../api/index.js";
import type { DuplicateGroup, DuplicateProjectEntry } from "../../api/index.js";
import { useDashboardStore } from "../../store/index.js";
import { GroupHeading, ListRow, Row, SecondaryButton, StyledList } from "../../ui/primitives.js";

// Issue #2232 — projects that point at the same repo (e.g. a macbook-pinned
// project next to the original). Merging folds the newer one into the oldest:
// its tasks, sessions (running ones too), previews and other rows move over.

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function impact(d: DuplicateProjectEntry): string {
  const c = d.counts;
  return [
    plural(c.tasks, "task") + (c.liveTasks > 0 ? ` (${c.liveTasks} live)` : ""),
    plural(c.runningSessions, "active session"),
    plural(c.previews, "preview"),
  ].join(", ");
}

export function DuplicateProjectsBanner() {
  const refreshProjects = useDashboardStore((s) => s.refreshProjects);
  // null until the operator asks: finding duplicates reads every project's origin
  // (one discovery call per remote host), too much to run on every mount.
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState(false);
  const [confirming, setConfirming] = useState<{
    group: DuplicateGroup;
    dup: DuplicateProjectEntry;
  } | null>(null);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setChecking(true);
    setCheckError(false);
    api
      .getProjectDuplicates()
      .then((r) => setGroups(r.groups))
      .catch(() => setCheckError(true))
      .finally(() => setChecking(false));
  }, []);

  const doMerge = async () => {
    if (!confirming) return;
    setMerging(true);
    setError(null);
    try {
      await api.mergeProject(confirming.dup.id, confirming.group.survivor.id);
      setConfirming(null);
      // DELETE-style removal broadcasts nothing, so refetch the list ourselves.
      await refreshProjects();
      load();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Merge failed");
    } finally {
      setMerging(false);
    }
  };

  if (groups === null || groups.length === 0) {
    return (
      <Row
        label="Duplicate projects"
        desc="Find projects that point at the same repository, e.g. one per host, and merge them."
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {checkError && (
            <span style={{ fontSize: "0.71875rem", color: "var(--dim)" }}>Check failed</span>
          )}
          {groups !== null && !checkError && !checking && (
            <span style={{ fontSize: "0.71875rem", color: "var(--dim)" }}>No duplicates found</span>
          )}
          <SecondaryButton onClick={load} disabled={checking}>
            Check
          </SecondaryButton>
        </div>
      </Row>
    );
  }

  return (
    <div data-testid="duplicate-projects">
      <GroupHeading
        title="Duplicate projects"
        desc="These projects point at the same repository. Merge a newer one into the oldest to keep one project with every host's checkout."
      />
      <StyledList>
        {groups.flatMap((g) =>
          g.duplicates.map((d) => (
            <ListRow
              key={d.id}
              title={`${d.name} → ${g.survivor.name}`}
              subtitle={d.refusal ? d.refusal.message : impact(d)}
              trailing={
                <SecondaryButton
                  onClick={() => {
                    setError(null);
                    setConfirming({ group: g, dup: d });
                  }}
                  disabled={d.refusal !== null || merging}
                >
                  Merge into {g.survivor.name}
                </SecondaryButton>
              }
              stacked
            />
          )),
        )}
      </StyledList>
      {confirming && (
        <div
          role="alertdialog"
          aria-label="Confirm project merge"
          style={{
            margin: "8px 0",
            padding: 10,
            border: "1px solid var(--border)",
            borderRadius: 6,
          }}
        >
          <div style={{ fontSize: "0.8125rem" }}>
            Merge <strong>{confirming.dup.name}</strong> into{" "}
            <strong>{confirming.group.survivor.name}</strong>? This moves {impact(confirming.dup)}{" "}
            and deletes {confirming.dup.name}. It cannot be undone.
          </div>
          {error && (
            <div role="alert" style={{ color: "var(--danger, #e5484d)", fontSize: "0.75rem" }}>
              {error}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <SecondaryButton onClick={() => void doMerge()} disabled={merging}>
              Merge
            </SecondaryButton>
            <SecondaryButton onClick={() => setConfirming(null)} disabled={merging}>
              Cancel
            </SecondaryButton>
          </div>
        </div>
      )}
    </div>
  );
}
