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
      // Some browsers need an explicit play() after srcObject is assigned even
      // with `autoPlay`; ignore the AbortError that fires if we're already playing.
      void v.play().catch(() => {});
      setConnected(true);
    });
    return () => r.stop();
  }, []);

  return (
    <div style={wrap}>
      <video ref={videoRef} autoPlay playsInline muted style={video} />
      {!connected && (
        <div style={waiting}>
          <div style={spinner} />
          <div>送信側を待っています…</div>
          <div style={waitingSub}>送信側のタブでシーンに入ると、ここに同じ画面が映ります</div>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}
    </div>
  );
}

const wrap: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: '#000',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};
const video: React.CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'contain',
  background: '#000',
};
const waiting: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 14,
  color: '#fff',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  fontSize: 14,
  letterSpacing: 0.5,
};
const waitingSub: React.CSSProperties = {
  fontSize: 11,
  color: 'rgba(255,255,255,0.6)',
  marginTop: -8,
};
const spinner: React.CSSProperties = {
  width: 36,
  height: 36,
  border: '2px solid rgba(255,255,255,0.15)',
  borderTopColor: '#3b82f6',
  borderRadius: '50%',
  animation: 'spin 0.9s linear infinite',
};
