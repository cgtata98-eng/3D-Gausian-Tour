import { useEffect, useRef, useState } from 'react';
import { useUIStore } from '../store/ui-store';
import { tokens } from './design-tokens';

/** スティック中心からのオフセットがこれ未満なら「動いていない」扱いにする。
 *  足音判定 (`mobileJoystickActive`) はこの値の外側でのみ true。
 *  THUMB が中心から少し揺れる程度では誤検知しないように緩めに 0.15。 */
const FOOTSTEP_DEADZONE = 0.15;

interface Props {
  /** Called every frame the joystick is touched. `x` / `y` are normalised
   *  to -1..1 (top-left = (-1,-1), bottom-right = (1,1)). Released → (0,0). */
  onChange: (x: number, y: number) => void;
}

const BASE_SIZE = 110;
const THUMB_SIZE = 50;
const MAX_OFFSET = (BASE_SIZE - THUMB_SIZE) / 2;

/**
 * Bottom-left bottom virtual joystick for touch devices. Only renders on
 * pointer-coarse media (phones / tablets). Captures its own pointer events so
 * the canvas's existing single-touch look-around drag still works for the
 * other thumb on the right side of the screen.
 */
export function MobileJoystick({ onChange }: Props) {
  const baseRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef<number | null>(null);
  const [thumb, setThumb] = useState({ x: 0, y: 0 });
  const [isTouchDevice, setIsTouchDevice] = useState(false);

  // Show only on touch / coarse-pointer devices so it doesn't clutter desktop.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(pointer: coarse)');
    setIsTouchDevice(mq.matches);
    const onChange = () => setIsTouchDevice(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  // Use pointer events (unified mouse / touch / pen). `setPointerCapture`
  // means the move events keep firing even if the finger drifts off the
  // joystick bounds, so the user can swing freely.
  const handleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeIdRef.current !== null) return; // already tracking another finger
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    activeIdRef.current = e.pointerId;
    updateFromPointer(e.clientX, e.clientY);
  };

  const handleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== activeIdRef.current) return;
    e.preventDefault();
    updateFromPointer(e.clientX, e.clientY);
  };

  const handleUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== activeIdRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    activeIdRef.current = null;
    setThumb({ x: 0, y: 0 });
    onChange(0, 0);
    useUIStore.getState().setMobileJoystickActive(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const updateFromPointer = (clientX: number, clientY: number) => {
    const base = baseRef.current;
    if (!base) return;
    const rect = base.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > MAX_OFFSET) {
      dx = (dx / dist) * MAX_OFFSET;
      dy = (dy / dist) * MAX_OFFSET;
    }
    setThumb({ x: dx, y: dy });
    const nx = dx / MAX_OFFSET;
    const ny = dy / MAX_OFFSET;
    onChange(nx, ny);
    // 足音用フラグ — デッドゾーン外なら「歩行中」。set 自体は冪等なので、
    // ストア値が同じなら zustand は再描画をトリガーしない (subscribe 側は浅い比較)。
    useUIStore.getState().setMobileJoystickActive(Math.hypot(nx, ny) > FOOTSTEP_DEADZONE);
  };

  if (!isTouchDevice) return null;

  return (
    <div
      ref={baseRef}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      style={{
        position: 'fixed',
        left: 'max(env(safe-area-inset-left, 16px), 16px)',
        bottom: 'max(env(safe-area-inset-bottom, 24px), 24px)',
        width: BASE_SIZE,
        height: BASE_SIZE,
        borderRadius: '50%',
        background: tokens.glass.surface,
        backdropFilter: tokens.backdrop,
        WebkitBackdropFilter: tokens.backdrop,
        border: `1px solid ${tokens.color.border}`,
        boxShadow: tokens.shadow.glass,
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        zIndex: 50,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: THUMB_SIZE,
          height: THUMB_SIZE,
          marginLeft: -THUMB_SIZE / 2,
          marginTop: -THUMB_SIZE / 2,
          borderRadius: '50%',
          background: tokens.gradient.surface,
          border: `1px solid ${tokens.color.border}`,
          boxShadow: tokens.shadow.glass,
          transform: `translate(${thumb.x}px, ${thumb.y}px)`,
          transition: activeIdRef.current === null ? 'transform 180ms ease-out' : 'none',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
