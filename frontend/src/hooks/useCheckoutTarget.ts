import { useState } from "react";
import { useFollowedCheckoutSession } from "./useFollowedCheckoutSession.js";

// What the right sidebar's Files and Source Control views are bound to: the
// focused session's own checkout (host + worktree) unless the user explicitly
// picked the project's default checkout instead. One choice for both views, so
// they never disagree about where they are looking.
export interface CheckoutChoice {
  /** The session whose checkout is focused, whether or not it is shown. */
  followedSessionId: number | null;
  /** The user chose the project's default checkout over the followed one. */
  projectDefault: boolean;
  onChange: (projectDefault: boolean) => void;
}

export function useCheckoutTarget(projectId: number | null): {
  /** The session the views are bound to; null = the project's default checkout. */
  checkoutSessionId: number | null;
  choice: CheckoutChoice;
} {
  const followedSessionId = useFollowedCheckoutSession(projectId);
  const [projectDefault, setProjectDefault] = useState(false);
  const [lastFollowed, setLastFollowed] = useState(followedSessionId);
  if (followedSessionId !== lastFollowed) {
    // Following a different session: forget the last one's override.
    setLastFollowed(followedSessionId);
    setProjectDefault(false);
  }
  return {
    checkoutSessionId: projectDefault ? null : followedSessionId,
    choice: { followedSessionId, projectDefault, onChange: setProjectDefault },
  };
}
