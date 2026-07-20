# Session Click & Drag-to-Dock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change sidebar session click behavior from "add tab to active group" to "open floating peek when not in current workspace" and add sidebar-to-dockview drag-to-dock support.

**Architecture:** Three interrelated changes: (1) `onOpenSession` branches on whether the session's panel exists in the current workspace — if yes, focus; if no, `addPanel({ floating: true })`. (2) `SessionRow` becomes a native HTML5 drag source carrying session ID. (3) App.tsx subscribes to dockview's `onUnhandledDragOver` for visual drop indicators, and handles native `drop` to place panels at the correct position (tab/within-group vs. split/edge).

**Tech Stack:** dockview-react ^7.0.2, dockview-core (external DnD via `onUnhandledDragOver` + native drop events), React 19, Zustand

---

### Task 1: Floating peek for sessions not in current workspace

**Files:**

- Modify: `frontend/src/App.tsx:414-436`

- [ ] **Step 1: Modify `onOpenSession` to detect session in current workspace**

In `App.tsx`, change `onOpenSession` to check `dockviewApi.getPanel()` — if the panel already exists in the current workspace (panel found), focus it (existing behavior). If not found, add the panel with `{ floating: true }` to open as a floating/overlay panel that does not modify the saved workspace layout.

```typescript
const onOpenSession = useCallback(
  (session: Session) => {
    if (!dockviewApi) return;
    const panelId = `session-${session.id}`;
    const existing = dockviewApi.getPanel(panelId);
    if (existing) {
      existing.api.setActive();
      if (isMobile) dockviewApi.maximizeGroup(existing);
      setSidebarOpen(false);
      return;
    }

    // Session not in current workspace → open as floating peek panel
    // (does not modify the saved workspace layout)
    const projectName = projects.find((p) => p.id === session.projectId)?.name;
    const panel = dockviewApi.addPanel({
      id: panelId,
      component: "terminal",
      tabComponent: "terminal",
      title: initialPaneTitle(session, projectName),
      params: { sessionId: session.id },
      floating: true,
    });
    if (isMobile) dockviewApi.maximizeGroup(panel);
    setSidebarOpen(false);
  },
  [dockviewApi, isMobile, projects],
);
```

- [ ] **Step 2: Verify behavior**

Run: `make test`
Expected: No regressions.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat: open session as floating peek when not in current workspace"
```

---

### Task 2: Draggable session rows

**Files:**

- Modify: `frontend/src/Sidebar.tsx:322-338`

- [ ] **Step 1: Add `draggable` and `onDragStart` to SessionRow**

Add `draggable={true}` and `onDragStart` handler to the `SessionRow` div.

- [ ] **Step 2: Run lint + typecheck**

Run: `make lint && make typecheck`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/Sidebar.tsx
git commit -m "feat: make sidebar session rows draggable"
```

---

### Task 3: Dockview external drop handling

**Files:**

- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Add dockview container ref and drop-target state**

Add `dockviewRef` and `lastDropTargetRef` to the `App` component.

- [ ] **Step 2: Wire ref to DockviewReact**

Add `ref={dockviewRef}` to the `<DockviewReact>` component.

- [ ] **Step 3: Subscribe to onUnhandledDragOver**

Add effect that subscribes to `dockviewApi.onUnhandledDragOver`, checks for our custom MIME type, calls `accept()`, and stores the drop target info.

- [ ] **Step 4: Handle native drop on dockview container**

Add effect that listens for native `drop` on the dockview container, reads session ID from `dataTransfer`, and calls `dockviewApi.addPanel()` with position based on the stored drop target.

- [ ] **Step 5: Run lint + typecheck**

Run: `make lint && make typecheck`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat: handle sidebar session drag-to-dock via onUnhandledDragOver + native drop"
```

---

### Task 4: Styling

**Files:**

- Modify: `frontend/src/styles.css`

- [ ] **Step 1: Add drag affordance cursor for session items**

Add `cursor: grab` (default) and `cursor: grabbing` (`:active`) to `.session-item`.

- [ ] **Step 2: Commit**

```bash
git add frontend/src/styles.css
git commit -m "style: add drag affordance cursor to session items"
```

---

### Task 5: Tests

**Files:**

- Create: `frontend/src/SessionRow.test.tsx`
- Create: `frontend/src/onOpenSession.test.ts`

- [ ] **Step 1: Write test for onOpenSession floating behavior**
- [ ] **Step 2: Write test for SessionRow drag start**
- [ ] **Step 3: Run tests**

Run from `frontend/`: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/SessionRow.test.tsx frontend/src/onOpenSession.test.ts
git commit -m "test: add tests for session click/drag-to-dock behavior"
```
