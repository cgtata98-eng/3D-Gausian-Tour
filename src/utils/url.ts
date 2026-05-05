export type AppMode = 'viewer' | 'debug' | 'project';

interface ParsedRoute {
  mode: AppMode;
  sceneId: string;
}

export function parseRoute(): ParsedRoute {
  const hash = window.location.hash;

  // #/viewer/{sceneId}
  const viewerMatch = hash.match(/#\/viewer\/([^/]+)/);
  if (viewerMatch) {
    return { mode: 'viewer', sceneId: viewerMatch[1] };
  }

  // #/scene/{sceneId} — debug
  const sceneMatch = hash.match(/#\/scene\/([^/]+)/);
  if (sceneMatch) {
    return { mode: 'debug', sceneId: sceneMatch[1] };
  }

  // #/project — project selection screen (default landing)
  // Default to project; legacy "no hash" also lands here.
  return { mode: 'project', sceneId: '' };
}
