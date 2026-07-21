# Update Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface available update notifications on the main screen with a prominent banner and show the current app version in the toolbar.

**Architecture:** Add `currentVersion` and `updateCheck` + `dismissedUpdateVersion` state to the Zustand store. Render a dismissible update banner below the toolbar (reusing the backend-down banner pattern) when an update is available, and a small version label in `toolbar-actions` that opens Settings → Server Info. Check on mount with periodic re-checks.

**Tech Stack:** React 19, Zustand, CSS custom properties, TypeScript

---

### Task 1: Add update state and actions to store

**Files:**

- Modify: `frontend/src/store.ts` — imports, interface, implementation

- [ ] **Step 1: Add `UpdateCheckResult` import and localStorage key**

Add `UpdateCheckResult` to the import from `./api.js`. Change:

```typescript
import type {
  AppSettings,
  Group,
  Host,
  Project,
  Session,
  SettingsPatch,
  Theme as ThemePreference,
  Workspace,
} from "./api.js";
```

to:

```typescript
import type {
  AppSettings,
  Group,
  Host,
  Project,
  Session,
  SettingsPatch,
  Theme as ThemePreference,
  UpdateCheckResult,
  Workspace,
} from "./api.js";
```

Add the localStorage key constant after `THEME_HINT_KEY` (line 57):

```typescript
const THEME_HINT_KEY = "crs.themeHint";
// Which update version the user dismissed (persisted to localStorage).
// When a newer version appears, the banner re-shows.
const DISMISSED_UPDATE_KEY = "crs.dismissedUpdateVersion";
```

- [ ] **Step 2: Add state fields and actions to DashboardState interface**

Add after `backendReachable: boolean;` (line 174):

```typescript
  currentVersion: string | null;
  updateCheck: UpdateCheckResult | null;
  dismissedUpdateVersion: string | null;
  checkForUpdates: () => Promise<void>;
  dismissUpdate: () => void;
```

- [ ] **Step 3: Add initial values**

Add after `backendReachable: true,` (~line 324):

```typescript
    currentVersion: null,
    updateCheck: null,
    dismissedUpdateVersion: localStorage.getItem(DISMISSED_UPDATE_KEY),
```

- [ ] **Step 4: Implement `checkForUpdates` and `dismissUpdate` actions**

Add after `startThemeWatch` (~line 609):

```typescript
    checkForUpdates: async () => {
      try {
        const result = await api.checkForUpdate();
        set({
          currentVersion: result.currentVersion,
          updateCheck: result,
        });
      } catch {
        // Fail silently — network/rate-limit errors shouldn't surface.
      }
    },

    dismissUpdate: () => {
      const version = get().updateCheck?.latestVersion;
      if (version) {
        localStorage.setItem(DISMISSED_UPDATE_KEY, version);
      }
      set({ dismissedUpdateVersion: version ?? null });
    },
```

- [ ] **Step 5: Verify typecheck**

Run: `make typecheck`
Expected: No type errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/store.ts
git commit -m "feat: add update check state and dismiss action to store"
```

---

### Task 2: Add version label to toolbar

**Files:**

- Modify: `frontend/src/Toolbar.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`

- [ ] **Step 1: Change `onOpenSettings` prop type and add `currentVersion`**

In `frontend/src/Toolbar.tsx`, change the interface:

```typescript
interface ToolbarProps {
  onToggleSidebar: () => void;
  onOpenSession: (session: Session) => void;
  onOpenLauncher: () => void;
  onOpenSettings: (section?: string) => void;
  activeWorkspaceName: string | null;
  paneCount: number;
  currentVersion: string | null;
}
```

- [ ] **Step 2: Render version label in toolbar-actions**

In the Toolbar JSX, add after the theme toggle (~line 73):

```typescript
        <button className="toolbar-icon-btn" onClick={toggleTheme} title="Toggle theme">
          {theme === "light" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
        </button>
        {currentVersion !== null && (
          <button
            className="toolbar-version-label"
            onClick={() => onOpenSettings("server")}
            title={`Version ${currentVersion}`}
          >
            v{currentVersion}
          </button>
        )}
        <button className="toolbar-icon-btn" onClick={() => onOpenSettings()} title="Settings (⌘,)">
```

- [ ] **Step 3: Update App.tsx binding for Toolbar**

In App.tsx (~line 816), change the Toolbar JSX to pass `openSettings` directly and add `currentVersion`:

```typescript
      <Toolbar
        onToggleSidebar={toggleSidebar}
        onOpenSession={onOpenSession}
        onOpenLauncher={openGlobalLauncher}
        onOpenSettings={openSettings}
        activeWorkspaceName={activeWorkspace?.name ?? null}
        paneCount={paneCount}
        currentVersion={currentVersion}
      />
```

Add `currentVersion` to the store destructuring (~line 800 area, the `useDashboardStore` call):

```typescript
  const {
    theme,
    settings,
    sessions,
    projects,
    workspaces,
    groups,
    sidebarCollapsed,
    backendReachable,
    currentVersion,
    refreshSessions,
    ...
  } = useDashboardStore();
```

- [ ] **Step 4: Add CSS for the version label**

Add to `frontend/src/styles.css` after `.kbd` rules (~line 306):

```css
.toolbar-version-label {
  font-family: "Geist Mono", monospace;
  font-size: 11px;
  color: var(--dim);
  background: transparent;
  border: none;
  padding: 0 4px;
  cursor: pointer;
  border-radius: 5px;
  height: 26px;
  display: flex;
  align-items: center;
  white-space: nowrap;
}
.toolbar-version-label:hover {
  color: var(--muted);
  background: color-mix(in srgb, var(--fg) 8%, transparent);
}
```

- [ ] **Step 5: Verify typecheck**

Run: `make typecheck`
Expected: No type errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/Toolbar.tsx frontend/src/App.tsx frontend/src/styles.css
git commit -m "feat: show current version label in toolbar-actions"
```

---

### Task 3: Add update banner component to App.tsx

**Files:**

- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`

- [ ] **Step 1: Add mount-effect for initial update check and periodic re-check**

In App.tsx, add a new `useEffect` alongside the other mount effects (~line 515 area):

```typescript
// Check for updates on mount and re-check every 30 minutes.
// The backend caches results for 1h, so most re-checks are no-ops.
useEffect(() => {
  checkForUpdates();
  const timer = setInterval(checkForUpdates, 30 * 60 * 1000);
  return () => clearInterval(timer);
}, [checkForUpdates]);
```

Add `checkForUpdates`, `updateCheck`, `dismissedUpdateVersion`, and `dismissUpdate` to the store destructuring:

```typescript
  const {
    theme,
    settings,
    sessions,
    projects,
    workspaces,
    groups,
    sidebarCollapsed,
    backendReachable,
    currentVersion,
    updateCheck,
    dismissedUpdateVersion,
    checkForUpdates,
    dismissUpdate,
    refreshSessions,
    ...
  } = useDashboardStore();
```

- [ ] **Step 2: Render the update banner**

Inside `.grid-area`, after the backend-down banner block (~line 854), add:

```typescript
          {!backendReachable && (
            <div className="backend-down-banner">
              ...
            </div>
          )}
          {updateCheck?.updateAvailable && updateCheck.latestVersion !== dismissedUpdateVersion && (
            <div
              className="update-banner"
              onClick={() => openSettings("server")}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") openSettings("server"); }}
            >
              <RefreshIcon size={16} style={{ color: "var(--o)", flexShrink: 0 }} />
              <span className="update-banner-title">
                v{currentVersion} → v{updateCheck.latestVersion} available
              </span>
              <span className="update-banner-subtext">Click for details</span>
              <button
                className="update-banner-dismiss"
                onClick={(e) => { e.stopPropagation(); dismissUpdate(); }}
                title="Dismiss until next version"
              >
                ×
              </button>
            </div>
          )}
```

Add `RefreshIcon` to the import from `./icons.js` (line 29):

```typescript
import { GridIcon, RefreshIcon, ServerRackIcon } from "./icons.js";
```

- [ ] **Step 3: Add CSS for update banner**

Add to `frontend/src/styles.css` after the `.backend-down-reconnect:hover` rule (~line 1107):

```css
/* Update available — orange/warning palette, sits below the backend-down
   banner if both are showing, before the grid-area-body. Click navigates to
   Settings -> Server info -> Updates subsection. */
.update-banner {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: color-mix(in srgb, var(--o) 13%, var(--chrome));
  border-bottom: 1px solid color-mix(in srgb, var(--o) 25%, transparent);
  cursor: pointer;
  user-select: none;
}
.update-banner-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--fg);
}
.update-banner-subtext {
  font-family: "Geist Mono", monospace;
  font-size: 11px;
  color: var(--muted);
}
.update-banner-dismiss {
  margin-left: auto;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--dim);
  border-radius: 6px;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
}
.update-banner-dismiss:hover {
  background: color-mix(in srgb, var(--o) 18%, transparent);
  color: var(--fg);
}
```

- [ ] **Step 4: Verify typecheck and test**

Run: `make typecheck`
Expected: No type errors.

Run: `make test`
Expected: All existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/styles.css
git commit -m "feat: add dismissible update banner on main screen"
```
