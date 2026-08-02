import { useEffect, useRef, useState } from 'react';
import { MirrorReceiver } from '../utils/mirror-rtc';
import { tokens } from './design-tokens';

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
    <div style={wrap}>
      <video ref={videoRef} autoPlay playsInline muted style={video} />
      {!connected && (
        <div style={waiting}>
          <div style={spinner} />
          <div style={waitingTitle}>送信側を待っています…</div>
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
  fontFamily: tokens.font.family,
  fontSize: 12.5,
  letterSpacing: 0.5,
};
const waitingTitle: React.CSSProperties = {
  fontWeight: tokens.font.weight.strong,
};
const waitingSub: React.CSSProperties = {
  fontSize: 10.5,
  color: 'rgba(255,255,255,0.55)',
  marginTop: -6,
  fontWeight: tokens.font.weight.medium,
};
const spinner: React.CSSProperties = {
  width: 36,
  height: 36,
  border: '2px solid rgba(255,255,255,0.15)',
  // Use the same accent hue as the rest of the design — keeps the loading
  // visual identifiable as part of this app even on the black mirror canvas.
  borderTopColor: tokens.color.accent,
  borderRadius: '50%',
  animation: 'spin 0.9s linear infinite',
};
