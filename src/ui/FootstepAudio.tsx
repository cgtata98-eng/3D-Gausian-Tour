import { useEffect, useRef, useState } from 'react';
import { useSceneStore } from '../store/scene-store';
import { useUIStore } from '../store/ui-store';

/**
 * Footstep audio — plays the default walk clip while WASD is held, switches to the
 * default run clip when Shift is also held.
 *
 * Mute follows the same `useUIStore.audioMuted` flag as the BGM. Disabled in 360°
 * panorama mode (teleport-only), in fly mode (no walking), and when the per-scene
 * `settings.footstepEnabled` flag is explicitly false.
 */
const WALK_URL = '/assets/audio/足音.mp3';
const RUN_URL = '/assets/audio/足音・走る.mp3';
const DEFAULT_VOLUME = 0.7;

export function FootstepAudio() {
  const muted = useUIStore((s) => s.audioMuted);
  const viewMode = useUIStore((s) => s.viewMode);
  const movementMode = useUIStore((s) => s.movementMode);
  const enabled = useSceneStore((s) => s.manifest?.settings.footstepEnabled);
  const volumeSetting = useSceneStore((s) => s.manifest?.settings.footstepVolume);
  const audioRef = useRef<HTMLAudioElement>(null);

  const [moving, setMoving] = useState(false);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    const movementKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
    const held = new Set<string>();
    let shiftHeld = false;
    let padMoving = false;
    let padRunning = false;
    const update = () => {
      const m = held.size > 0 || padMoving;
      const r = m && (shiftHeld || padRunning);
      setMoving(m);
      setRunning(r);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { shiftHeld = true; update(); return; }
      if (!movementKeys.has(e.code)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      held.add(e.code); update();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { shiftHeld = false; update(); return; }
      if (!movementKeys.has(e.code)) return;
      held.delete(e.code); update();
    };
    const onBlur = () => { held.clear(); shiftHeld = false; padMoving = false; padRunning = false; update(); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    // Gamepad polling — left stick magnitude past the same 0.20 deadzone the camera
    // controller uses counts as "moving"; R2 ≥ 0.5 (matches the analog-boost ramp)
    // counts as "running". Polled at 50 ms which is plenty for footstep cadence.
    const dz = (v: number, d = 0.20) => Math.abs(v) < d ? 0 : Math.sign(v) * (Math.abs(v) - d) / (1 - d);
    const padId = window.setInterval(() => {
      const gps = navigator.getGamepads ? navigator.getGamepads() : [];
      const valid = [...gps].filter((g): g is Gamepad => !!g);
      if (valid.length === 0) {
        if (padMoving || padRunning) { padMoving = false; padRunning = false; update(); }
        return;
      }
      const pad = valid.find((g) => g.mapping === 'standard') ?? valid[0];
      const sx = dz(pad.axes[0] ?? 0);
      const sy = dz(pad.axes[1] ?? 0);
      const r2 = pad.buttons[7]?.value ?? 0;
      const newPadMoving = Math.hypot(sx, sy) > 0;
      const newPadRunning = newPadMoving && r2 >= 0.5;
      if (newPadMoving !== padMoving || newPadRunning !== padRunning) {
        padMoving = newPadMoving;
        padRunning = newPadRunning;
        update();
      }
    }, 50);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.clearInterval(padId);
    };
  }, []);

  const src = running ? RUN_URL : WALK_URL;
  const isEnabled = enabled !== false; // default ON
  const volume = Math.max(0, Math.min(1, volumeSetting ?? DEFAULT_VOLUME));
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.volume = volume;
    if (muted || !moving || !isEnabled || viewMode === '360' || movementMode === 'fly') {
      el.pause();
    } else {
      el.play().catch(() => { /* autoplay block etc. */ });
    }
  }, [muted, moving, isEnabled, viewMode, movementMode, src, volume]);

  if (!isEnabled) return null;
  return (
    <audio
      ref={audioRef}
      src={src}
      loop
      preload="auto"
      style={{ display: 'none' }}
      aria-hidden="true"
    />
  );
}
