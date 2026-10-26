import { useCallback, useState } from "react";
import { api } from "../api/index.js";
import type { GitHubPrDetailComment, GitHubPrDetailThread } from "../api/types.js";

/**
 * Reply to / resolve a PR's review threads (#1672), with each write shown at
 * once from its own response. A refetch right after a write can still answer
 * from before it (GitHub's read-after-write is not immediate), so the posted
 * reply and the resolved flag are overlaid on whatever the server returns
 * until the server's own copy carries them.
 */
export function usePrThreadWrites(projectId: number, number: number, refresh: () => void) {
  const [resolved, setResolved] = useState<ReadonlySet<string>>(new Set());
  const [replies, setReplies] = useState<Record<string, GitHubPrDetailComment[]>>({});

  const reply = useCallback(
    async (threadId: string, body: string) => {
      const posted = await api.replyToPrThread(projectId, number, threadId, body);
      const comment: GitHubPrDetailComment = {
        author: posted.author,
        bodyHtml: posted.bodyHtml,
        createdAt: posted.createdAt,
      };
      setReplies((r) => ({ ...r, [threadId]: [...(r[threadId] ?? []), comment] }));
      refresh();
    },
    [projectId, number, refresh],
  );

  const resolve = useCallback(
    async (threadId: string) => {
      await api.resolvePrThread(projectId, number, threadId);
      setResolved((s) => new Set(s).add(threadId));
      refresh();
    },
    [projectId, number, refresh],
  );

  const patch = useCallback(
    (threads: GitHubPrDetailThread[]): GitHubPrDetailThread[] =>
      threads.map((t) => {
        const own = (replies[t.id] ?? []).filter(
          (c) => !t.comments.some((s) => s.createdAt === c.createdAt && s.author === c.author),
        );
        if (own.length === 0 && !resolved.has(t.id)) return t;
        return {
          ...t,
          isResolved: t.isResolved || resolved.has(t.id),
          comments: [...t.comments, ...own],
        };
      }),
    [replies, resolved],
  );

  return { reply, resolve, patch };
}
