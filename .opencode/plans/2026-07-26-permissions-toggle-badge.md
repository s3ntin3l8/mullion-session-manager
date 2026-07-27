# Permissions Toggle & Settings Layout Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two UX issues with the skip-permissions feature: (1) the launcher checkbox should be a universal override with per-agent badges, not auto-checked from settings, and (2) the settings page's agent rows should have aligned toggles and column headings.

**Architecture:** Two focused changes in `frontend/src/CommandPalette.tsx` (launcher checkbox logic + badge) and `frontend/src/Settings.tsx` (flag text moved to subtitle, wider title width, column headings). No backend changes.

**Tech Stack:** React (TypeScript), Zustand store, CSS modules

---

### Task 1: Universal launcher checkbox + per-agent badge

**Files:**

- Modify: `frontend/src/CommandPalette.tsx`

- [ ] **Step 1: Remove per-agent defaults from checkbox state, keep user toggle persistent**

The checkbox should reflect only the user's manual action. Remove the `skipPermissionsGlobalDefault` and `skipPermissionsLauncherDefault` computations. Keep `skipPermissionsOverride` as `boolean | null` (null = never touched by user). Remove the `useEffect` that resets it on launcher change — the user's choice persists across selections.

Current code (lines 188-220), to delete:

```typescript
const [skipPermissionsOverride, setSkipPermissionsOverride] = useState<boolean | null>(null);

const picked = filtered[selectedIndex];

const skipPermissionsGlobalDefault = useMemo(() => {
  if (picked?.kind !== "agent") return false;
  const agentId = picked.id.startsWith("agent:") ? picked.id.slice(6) : picked.id;
  return settings.launchers.skipPermissionsAgents?.includes(agentId) ?? false;
}, [picked, settings.launchers.skipPermissionsAgents]);

const skipPermissionsLauncherDefault =
  picked?.kind === "agent" && picked.skipPermissions === true
    ? true
    : picked?.kind === "agent" && picked.skipPermissions === false
      ? false
      : skipPermissionsGlobalDefault;

useEffect(() => {
  setSkipPermissionsOverride(null);
}, [filtered[selectedIndex]?.id]);

const skipPermissionsEnabled = skipPermissionsOverride ?? skipPermissionsLauncherDefault;
```

Replace with:

```typescript
// Universal override — when checked, ALL agents launch with skip-permissions.
// Per-agent config (settings / .crs/actions.json) is shown as a badge on the
// agent row instead of pre-checking the box. The user's choice persists
// across launcher selections (no reset on pick change).
const [skipPermissionsOverride, setSkipPermissionsOverride] = useState<boolean | null>(null);

const picked = filtered[selectedIndex];
const skipPermissionsEnabled = skipPermissionsOverride ?? false;
```

- [ ] **Step 2: Update the createSession call to merge override + per-agent config**

On launch, resolve skipPermissions as: checkbox override (highest) → per-launcher `.crs/actions.json` config → settings list.

Current (line 237):

```typescript
      skipPermissions: launcher.kind === "agent" ? skipPermissionsEnabled : undefined,
```

Replace with:

```typescript
      skipPermissions: launcher.kind === "agent"
        ? (skipPermissionsOverride !== null
            ? skipPermissionsOverride
            : launcher.skipPermissions
              || (settings.launchers.skipPermissionsAgents?.includes(
                   launcher.id.startsWith("agent:") ? launcher.id.slice(6) : launcher.id
                 ) ?? false))
        : undefined,
```

- [ ] **Step 3: Add per-agent skip-permissions badge in the launcher list**

After the `filtered` memo (after line 186), add a memoized set of agent IDs that have skip-permissions configured:

```typescript
const skipPermissionsAgentIds = useMemo(() => {
  const ids = new Set<string>();
  for (const id of settings.launchers.skipPermissionsAgents ?? []) {
    ids.add(id);
  }
  for (const l of launchers) {
    if (l.kind === "agent" && l.skipPermissions === true) {
      ids.add(l.id.startsWith("agent:") ? l.id.slice(6) : l.id);
    }
  }
  return ids;
}, [settings.launchers.skipPermissionsAgents, launchers]);
```

Inside the `filtered.map((launcher, i) => {` callback, after the existing source badge (after line 571), add:

```typescript
                  {launcher.kind === "agent"
                    && skipPermissionsAgentIds.has(
                      launcher.id.startsWith("agent:") ? launcher.id.slice(6) : launcher.id
                    )
                    && (
                      <span
                        className="cmd-row-source-badge"
                        style={{
                          color: "var(--orange)",
                          borderColor: "color-mix(in srgb, var(--orange) 40%, transparent)",
                        }}
                      >
                        ⚠ skip perms
                      </span>
                    )}
```

- [ ] **Step 4: Update the checkbox label to indicate it's a universal override**

Current (line 344):

```typescript
                    <span>Skip permissions</span>
```

Change to:

```typescript
                    <span>Skip permissions (all agents)</span>
```

Current (line 355):

```typescript
                    Suppresses all approval prompts from the agent CLI
```

Change to:

```typescript
                    Overrides per-agent settings — suppresses approval prompts for all agents
```

---

### Task 2: Clean up settings agent rows

**Files:**

- Modify: `frontend/src/Settings.tsx`

- [ ] **Step 1: Move flag text from trailing area to subtitle**

Remove the flag text (`{skipPermissionFlags[agentId]}`) from the trailing toggle span.

Current (lines 856-879):

```typescript
                    {skipPermissionFlags[agentId] && (
                      <span
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 3,
                          fontSize: 10,
                          color: "var(--muted)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <Toggle
                          on={settings.launchers.skipPermissionsAgents?.includes(agentId) ?? false}
                          size="small"
                          onChange={() => {
                            const current = settings.launchers.skipPermissionsAgents ?? [];
                            const next = current.includes(agentId)
                              ? current.filter((id) => id !== agentId)
                              : [...current, agentId];
                            updateSettings({ launchers: { skipPermissionsAgents: next } });
                          }}
                        />
                        {skipPermissionFlags[agentId]}
                      </span>
                    )}
```

Replace with:

```typescript
                    {skipPermissionFlags[agentId] && (
                      <span style={{ display: "flex", alignItems: "center", fontSize: 10 }}>
                        <Toggle
                          on={settings.launchers.skipPermissionsAgents?.includes(agentId) ?? false}
                          size="small"
                          onChange={() => {
                            const current = settings.launchers.skipPermissionsAgents ?? [];
                            const next = current.includes(agentId)
                              ? current.filter((id) => id !== agentId)
                              : [...current, agentId];
                            updateSettings({ launchers: { skipPermissionsAgents: next } });
                          }}
                        />
                      </span>
                    )}
```

- [ ] **Step 2: Append flag text to the subtitle after the path**

Current subtitle (lines 844-850):

```typescript
              subtitle={
                hookTrustPending
                  ? "Hook trust pending — run /hooks in a Codex session to enable structured events"
                  : a.available
                    ? (a.path ?? "")
                    : "not found on PATH"
              }
```

Replace with:

```typescript
              subtitle={
                hookTrustPending
                  ? "Hook trust pending — run /hooks in a Codex session to enable structured events"
                  : a.available
                    ? (a.path ?? "") + (skipPermissionFlags[agentId] ? `  •  ${skipPermissionFlags[agentId]}` : "")
                    : "not found on PATH" + (skipPermissionFlags[agentId] ? `  •  ${skipPermissionFlags[agentId]}` : "")
              }
```

- [ ] **Step 3: Widen the title so names don't push the subtitle start position**

Current title (line 843):

```typescript
              title={<span style={{ width: 96, display: "inline-block" }}>{a.title}</span>}
```

Change `width: 96` to `width: 140`:

```typescript
              title={<span style={{ width: 140, display: "inline-block" }}>{a.title}</span>}
```

This ensures short names like "bash" and long ones like "opencode" leave the subtitle starting from the same column.

- [ ] **Step 4: Add column headings above the agent list**

Insert a header row between the "Detected CLIs" Row and the StyledList. This gives users a clear label for what each trailing control does.

Before the `<StyledList>` (before line 832), add:

```typescript
      <div
        style={{
          display: "flex",
          gap: 12,
          padding: "0 13px 4px",
          fontSize: 9.5,
          color: "var(--dim)",
          textTransform: "uppercase" as const,
          letterSpacing: "0.5px",
        }}
      >
        <span style={{ width: 9, flexShrink: 0 }} />
        <span style={{ width: 16, flexShrink: 0 }} />
        <span style={{ width: 140, flexShrink: 0 }}>Launcher</span>
        <span style={{ flex: 1 }}>Config</span>
        <span style={{ flexShrink: 0, display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ marginRight: 2 }}>Skip perms</span>
          <span style={{ width: 60, textAlign: "center" as const }}>Status</span>
          <span style={{ width: 36, textAlign: "center" as const }}>Show</span>
        </span>
      </div>
```

The widths mirror the layout in `ListRow`: 9px for the status dot, 16px for the icon, 140px for the title, `flex: 1` for the subtitle, and then the trailing controls aligned by gap.

---

### Task 3: Lint & typecheck

- [ ] **Step 1: Run typecheck**
      Run: `make typecheck` from repo root. Expected: no new type errors.

- [ ] **Step 2: Run lint**
      Run: `make lint` from repo root. Expected: no new lint errors.

- [ ] **Step 3: Run tests**
      Run: `make test` from repo root. Expected: all tests pass.

- [ ] **Step 4: Run format check**
      Run: `make format-check` from repo root. Expected: no formatting errors.
