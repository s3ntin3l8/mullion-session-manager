import { useEffect, useReducer } from "react";
// The Tasks-mode board's store surface (#3026) for tests that mock the store
// wholesale: UnifiedBoard publishes its statuses and consumes the jump request.
export const boardStoreStubs = {
  // A getter, so each `...boardStoreStubs` spread reads the current value.
  get newTaskFormOpen() {
    return newTaskFormOpen;
  },
  setNewTaskFormOpen: (open: boolean) => {
    newTaskFormOpen = open;
    for (const listener of newTaskFormListeners) listener();
  },
  statusJumpRequest: null,
  setBoardStatuses: () => {},
  requestStatusJump: () => {},
};

// The new-task form's open state (#3288), which the board reads from the store
// so the phone's tab bar can open it too. The wholesale store mocks are not
// reactive, so this one piece is: `useNewTaskFormTick()`, called from the
// mock's hook, re-renders its subscribers when the setter runs.
let newTaskFormOpen = false;
const newTaskFormListeners = new Set<() => void>();
export function resetNewTaskFormStub() {
  newTaskFormOpen = false;
}
export function useNewTaskFormTick() {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    newTaskFormListeners.add(tick);
    return () => {
      newTaskFormListeners.delete(tick);
    };
  }, []);
}
