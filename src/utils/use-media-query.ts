import { useCallback, useSyncExternalStore } from 'react';

/** One MediaQueryList per query string — getSnapshot runs on EVERY render of every
 *  consumer, and `window.matchMedia` parses the query + allocates a fresh list each
 *  call. MediaQueryLists live for the page lifetime anyway, so caching is free. */
const mqCache = new Map<string, MediaQueryList>();
function getMq(query: string): MediaQueryList {
  let mq = mqCache.get(query);
  if (!mq) {
    mq = window.matchMedia(query);
    mqCache.set(query, mq);
  }
  return mq;
}

/**
 * Subscribe to a CSS media query as React state (e.g. `(pointer: coarse)` for
 * touch devices, `(orientation: portrait)` for rotation).
 *
 * Built on `useSyncExternalStore` — matchMedia is an external store, so this is
 * the idiomatic subscription shape: no `setState` inside an effect body (the
 * `react-hooks/set-state-in-effect` pattern the old copies of this logic
 * tripped), no initial-value flash, and rotation / input changes re-render
 * exactly the components that read the query.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const mq = getMq(query);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [query]);
  return useSyncExternalStore(
    subscribe,
    () => getMq(query).matches,
    () => false, // SSR / non-browser snapshot
  );
}
