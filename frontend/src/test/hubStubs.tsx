import { useState } from "react";

// Stand-ins for the five panels a ProjectHubPanel tab hosts. Each keeps a
// local draft (an <input>) so a test can prove a tab's state survives a tab
// switch, and "skills" can be told to crash to prove per-tab isolation.
export const hubStubControl = { crashSkills: false };

export function makeHubStub(name: string) {
  return function HubStub({ params }: { params: { projectId: number } }) {
    const [draft, setDraft] = useState("");
    if (name === "skills" && hubStubControl.crashSkills) throw new Error("skills exploded");
    return (
      <div data-testid={`stub-${name}`}>
        <span>{`${name}:${params.projectId}`}</span>
        <input
          aria-label={`${name} draft`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </div>
    );
  };
}
