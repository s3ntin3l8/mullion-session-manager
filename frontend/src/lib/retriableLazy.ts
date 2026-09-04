import { lazy, useState } from "react";
import type { ComponentType } from "react";

type Loader<Props extends object> = () => Promise<{ default: ComponentType<Props> }>;

interface SharedEntry {
  generation: number;
  // The cache holds entries for many different Props shapes (one per
  // loader) — narrowed back to the caller's own Props at each read site
  // below, the same "the `any` isn't ours" trade this file's callers
  // already make for dockview-core's own typing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Component: ComponentType<any>;
}

interface LocalState<Props extends object> {
  retryKey: number;
  generation: number;
  Component: ComponentType<Props>;
}

// Shared across every mount of a given loader (e.g. two concurrently-open
// browser panes both calling loadBrowserPane in panels/registry.tsx) —
// restores the pre-fix behavior of one lazy() payload per PANEL TYPE rather
// than per mount, so a panel that's already resolved doesn't force a fresh
// Suspense flash for a sibling panel's later mount of the exact same,
// already-loaded module. Only replaced with a new "generation" when some
// instance's own ErrorBoundary actually resets — see useRetriableLazy
// below. Keyed by loader identity (loaders are module-scope functions —
// see registry.tsx's/App.tsx's own loadX definitions — so this holds a
// small, fixed number of entries, not a leak).
//
// Test-file note: this cache is module-scoped, so it survives across every
// `it()` within the same test file (Vitest doesn't reset module state
// between tests, only between files) — a real production loader like
// loadBrowserPane keeps whatever generation an earlier test in the same
// file left it at. registry.test.tsx currently has exactly one test that
// renders a real registered lazy panel, so this isn't live today; a second
// one added later should account for it (e.g. a distinct inline loader, or
// asserting on relative rather than absolute call counts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sharedLazyCache = new WeakMap<Loader<any>, SharedEntry>();

function currentShared<Props extends object>(loader: Loader<Props>): SharedEntry {
  const existing = sharedLazyCache.get(loader);
  if (existing) return existing;
  const fresh: SharedEntry = { generation: 0, Component: lazy(loader) };
  sharedLazyCache.set(loader, fresh);
  return fresh;
}

// React 19's lazyInitializer (react/cjs/react.production.js) latches a
// rejected dynamic import forever: once a lazy()'s payload has settled to
// Rejected, every future render synchronously re-throws the same cached
// error, with zero new network requests — the import() call is never
// retried. Remounting the *consumer* under a fresh `key` (the existing
// ErrorBoundary+useResetKey pattern, see panels/registry.tsx) doesn't help
// on its own, because it's still the same lazy() payload object being
// re-thrown.
//
// The only way to actually retry is to build a brand-new lazy() — a fresh
// payload wrapping a fresh import() call — which is what this hook does on
// a `retryKey` change (typically the same resetKey an ErrorBoundary's
// onReset already bumps). `loader` is expected to be referentially stable
// (a module-scope function), so it never forces a rebuild on its own.
//
// Deliberately NOT useMemo: React's own docs reserve the right to discard a
// useMemo cache "if your component suspends during the initial mount" —
// exactly what a lazy()-wrapped component does every time. An evicted cache
// here would silently rebuild the payload (a fresh, unlatched — but also
// unrelated to any actual retry — lazy()) on an ordinary re-render that
// never touched retryKey, remounting the already-loaded child and losing
// its state (an open Settings form, a live BrowserPane). `useState` is real
// per-instance state with no such caching caveat, so it's what's used here
// instead, via React's own documented "adjust state during render" idiom
// for state that should reset when a key changes.
export function useRetriableLazy<Props extends object>(
  loader: Loader<Props>,
  retryKey: number,
): ComponentType<Props> {
  const [state, setState] = useState<LocalState<Props>>(() => {
    const shared = currentShared(loader);
    return { retryKey, generation: shared.generation, Component: shared.Component };
  });

  if (state.retryKey !== retryKey) {
    // This instance's own ErrorBoundary just reset — force a genuinely new
    // shared payload so any FUTURE mount of this same loader also gets the
    // fix, not just this one instance. Bumped off the CURRENT shared
    // generation (not this instance's own, possibly-stale `state.generation`)
    // so two sibling instances resetting around the same time can't race
    // each other into overwriting a newer generation with an older one.
    //
    // Adjusting state during render, not an Effect: React discards this
    // in-progress render and re-runs the function immediately with the
    // updated state before committing anything, so the stale
    // `state.Component` this render pass would otherwise return is never
    // actually painted.
    const currentGeneration = sharedLazyCache.get(loader)?.generation ?? state.generation;
    const fresh: SharedEntry = { generation: currentGeneration + 1, Component: lazy(loader) };
    sharedLazyCache.set(loader, fresh);
    setState({ retryKey, generation: fresh.generation, Component: fresh.Component });
  }
  return state.Component;
}
