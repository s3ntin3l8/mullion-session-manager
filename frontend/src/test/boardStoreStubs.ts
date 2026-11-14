// The Tasks-mode board's store surface (#3026) for tests that mock the store
// wholesale: UnifiedBoard publishes its statuses and consumes the jump request.
export const boardStoreStubs = {
  statusJumpRequest: null,
  setBoardStatuses: () => {},
  requestStatusJump: () => {},
};
