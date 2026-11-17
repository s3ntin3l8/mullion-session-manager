import { vi } from "vitest";

/**
 * The SessionBackend members that read a worker's task files out of the
 * sessions directory (commit title, re-review request, ci-unfixable
 * declaration), as fresh mocks that find nothing. A new one belongs here once,
 * not in every full-backend fake.
 */
export function nullTaskFileReads() {
  return {
    readTaskCommitTitle: vi.fn().mockResolvedValue(null),
    readTaskRereviewRequest: vi.fn().mockResolvedValue(null),
    readTaskCiUnfixable: vi.fn().mockResolvedValue(null),
  };
}
