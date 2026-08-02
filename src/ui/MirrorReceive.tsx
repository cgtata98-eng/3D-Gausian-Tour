import { useEffect, useRef, useState } from 'react';
import { MirrorReceiver } from '../utils/mirror-rtc';

/**
 * Receive-only mirror page. Mounted when the URL contains `?mirror=receive`.
 * Listens for a WebRTC track from the sender tab (signalling over BroadcastChannel)
 * and pipes it into a fullscreen `<video>` element. No camera input, no scene state —
 * this tab is "just a TV" for the sender's canvas.
 */
export function MirrorReceive() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const r = new MirrorReceiver();
    r.start((stream) => {
      const v = videoRef.current;
      if (!v) return;
      v.srcObject = stream;
      void v.play().catch(() => {});
      setConnected(true);
    });
    return () => r.stop();
  }, []);

  return (
    <div className="ds-stage">
      <video ref={videoRef} autoPlay playsInline muted style={video} />
      {!connected && (
        <div style={waiting}>
          <div className="ds-spinner" />
          <div className="ds-title">送信側を待っています…</div>
          <div className="ds-sub">送信側のタブでシーンに入ると、ここに同じ画面が映ります</div>
        </div>
      )}
    </div>
  );
}

/** Layout only. */
const video: React.CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'contain',
};
const waiting: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
};
