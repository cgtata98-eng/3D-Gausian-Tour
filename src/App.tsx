import { useState, useEffect } from 'react';
import { Viewer } from './ui/Viewer';
import { DebugViewer } from './ui/DebugViewer';
import { ProjectScreen } from './ui/ProjectScreen';
import { MirrorReceive } from './ui/MirrorReceive';
import { parseRoute } from './utils/url';
import { useUIStore } from './store/ui-store';

function App() {
  const [route, setRoute] = useState(() => parseRoute());
  const [mirrorParam] = useState(() => new URLSearchParams(window.location.search).get('mirror'));

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
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

  if (route.mode === 'project') {
    return <ProjectScreen />;
  }
  if (route.mode === 'viewer') {
    return <Viewer sceneId={route.sceneId} />;
  }
  return <DebugViewer sceneId={route.sceneId} />;
}

export default App;
