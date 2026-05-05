export type AppMode = 'viewer' | 'debug' | 'project';

interface ParsedRoute {
  mode: AppMode;
  sceneId: string;
}

/**
 * Path-based routes. The Cloudflare Worker is configured with
 * `not_found_handling: "single-page-application"` so any path falls back to
 * `index.html` and we resolve client-side here.
 */
export function parseRoute(): ParsedRoute {
  const path = window.location.pathname;

  // /viewer/{sceneId}
  const viewerMatch = path.match(/^\/viewer\/([^/]+)/);
  if (viewerMatch) return { mode: 'viewer', sceneId: viewerMatch[1] };

  // /scene/{sceneId} — debug authoring view
  const sceneMatch = path.match(/^\/scene\/([^/]+)/);
  if (sceneMatch) return { mode: 'debug', sceneId: sceneMatch[1] };

  // Anything else falls back to the project list.
  return { mode: 'project', sceneId: '' };
}

/**
 * Navigate without a full page reload. Use instead of `window.location.href = …`
 * so React state survives. Updates `history` and dispatches a `popstate` so
 * `App.tsx`'s listener picks up the new route.
 */
export function navigate(path: string) {
  if (window.location.pathname === path) return;
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/**
 * Backwards-compat: rewrite an existing `#/...` URL to its `/...` equivalent.
 * Old bookmarks / shared links keep working without a redirect server-side.
 * Returns true if a rewrite happened.
 */
export function migrateHashToPath(): boolean {
  if (!window.location.hash.startsWith('#/')) return false;
  const path = window.location.hash.slice(1); // drop leading '#'
  window.history.replaceState(null, '', path + window.location.search);
  return true;
}
