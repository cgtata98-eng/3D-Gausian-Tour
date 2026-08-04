import { useState, useEffect } from 'react';
import { Viewer } from './ui/Viewer';
import { DebugViewer } from './ui/DebugViewer';
import { ProjectScreen } from './ui/ProjectScreen';
import { MirrorReceive } from './ui/MirrorReceive';
import { MigrateScreen } from './ui/MigrateScreen';
import { parseRoute, migrateHashToPath } from './utils/url';
import { useUIStore } from './store/ui-store';
import { AuthGate } from './ui/AuthGate';

function App() {
  const [route, setRoute] = useState(() => {
    // Old shared URLs use `#/...`; rewrite them to the new path-based form
    // before the first parse so the user lands on the same page.
    migrateHashToPath();
    return parseRoute();
  });
  const [mirrorParam] = useState(() => new URLSearchParams(window.location.search).get('mirror'));

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Mirror handshake: ProjectScreen の「📡 ミラーリング開始」ボタンが受信タブを
  // `?mirror=receive` 付きで開く。`receive` の場合は MirrorReceive 専用画面を出すので
  // 通常のルーティングはバイパス。`send` の場合は `mirrorMode` を立てておくことで、
  // ユーザーがビューアに入った瞬間に Viewer 側 useEffect が canvas を WebRTC で配信する。
  useEffect(() => {
    if (mirrorParam === 'send') useUIStore.getState().setMirrorMode('send');
    if (mirrorParam === 'receive') useUIStore.getState().setMirrorMode('receive');
  }, [mirrorParam]);

  if (mirrorParam === 'receive') {
    return <MirrorReceive />;
  }

  // Public route: viewer is always reachable so customer URLs keep working.
  if (route.mode === 'viewer') {
    return <Viewer sceneId={route.sceneId} />;
  }
  // Migration. The source window is opened programmatically by the receiving
  // origin, so it cannot sit behind AuthGate — a login prompt there would
  // strand the handshake. It only ever posts to an allow-listed opener.
  if (route.mode === 'migrate') {
    const isSource = new URLSearchParams(window.location.search).get('source') === '1';
    return isSource ? <MigrateScreen /> : <AuthGate><MigrateScreen /></AuthGate>;
  }
  // Admin / debug routes are gated by simple ID + password.
  if (route.mode === 'project') {
    return <AuthGate><ProjectScreen /></AuthGate>;
  }
  return <AuthGate><DebugViewer sceneId={route.sceneId} /></AuthGate>;
}

export default App;
