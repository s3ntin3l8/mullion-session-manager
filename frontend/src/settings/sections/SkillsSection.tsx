import { useEffect, useState } from "react";
import { api } from "../../api.js";
import type { SkillInfo } from "../../api.js";

// Issue #432 — read-only "what skills does Mullion see" listing: every
// global/builtin skill discovered on THIS host (see skills.ts's own
// listGlobalSkills doc comment on why this is deliberately primary-host-
// only, unlike the per-project SkillsPanel dockview panel). Fetched once on
// mount, same "these change rarely" reasoning as the rest of this file's
// read-only diagnostic sections.
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
        No skills found under any known Claude Code, Codex, opencode, or agy directory on this host.
        Per-project skills (repo-local `.claude/skills`, `.agents/skills`, etc.) show up in each
        project's own Skills panel instead.
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
              {skill.description} · {skill.agents.join(", ")}
            </span>
          </div>
        ))}
      </div>
      <div className="settings-footer-note">
        Global and builtin skills only, resolved on this host. Per-project skills show up in each
        project's own Skills panel.
      </div>
    </>
  );
}
