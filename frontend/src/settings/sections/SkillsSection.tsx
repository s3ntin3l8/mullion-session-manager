import { useEffect, useState } from "react";
import { api } from "../../api/index.js";
import type { SkillInfo, SkillKind } from "../../api/index.js";

const KIND_LABEL: Record<SkillKind, string> = {
  skill: "Skill",
  agent: "Subagent",
  command: "Command",
};

// Issue #432 — read-only "what skills does Mullion see" listing: every
// global/builtin skill discovered on THIS host (see skills.ts's own
// listGlobalSkills doc comment on why this is deliberately primary-host-
// only, unlike the per-project SkillsPanel dockview panel). Extended by
// issue #885 to also list global/builtin subagents and slash commands —
// always read-only here regardless of kind, since this whole section never
// had a toggle to begin with. Fetched once on mount, same "these change
// rarely" reasoning as the rest of this file's read-only diagnostic
// sections.
export function SkillsSection() {
  const [skills, setSkills] = useState<SkillInfo[] | null | undefined>(undefined);

  useEffect(() => {
    api
      .listGlobalSkills()
      .then(setSkills)
      .catch(() => setSkills(null));
  }, []);

  if (skills === undefined) return <div className="settings-readonly-value">Loading…</div>;
  if (skills === null) {
    return <div className="settings-readonly-value">Couldn't load skills.</div>;
  }
  if (skills.length === 0) {
    return (
      <div className="settings-footer-note">
        No skills, subagents, or slash commands found under any known Claude Code, Codex, opencode,
        or agy directory on this host. Per-project ones (repo-local `.claude/skills`,
        `.agents/skills`, `.claude/agents`, `.claude/commands`, etc.) show up in each project's own
        Skills panel instead.
      </div>
    );
  }

  return (
    <>
      <div className="settings-info-table">
        {skills.map((skill, i) => (
          <div key={skill.sourceDir} className={`settings-info-row${i % 2 === 1 ? " zebra" : ""}`}>
            <span className="settings-info-key">{skill.name}</span>
            <span className="settings-info-value">
              {KIND_LABEL[skill.kind]} · {skill.description} · {skill.agents.join(", ")}
            </span>
          </div>
        ))}
      </div>
      <div className="settings-footer-note">
        Global and builtin skills, subagents, and slash commands only, resolved on this host.
        Per-project ones show up in each project's own Skills panel.
      </div>
    </>
  );
}
