import { useEffect } from 'react';
import { useUIStore } from '../store/ui-store';
import { useTrackingStore } from '../store/tracking-store';
import { startHeadTracker, stopHeadTracker } from '../utils/head-tracker';

/** Anything that exposes `setTrackingOffset(yaw, pitch)` — both `ThreeSceneManager`
 *  and the PlayCanvas `SceneManager` qualify. */
interface TrackingTarget {
  setTrackingOffset: (yawDeg: number, pitchDeg: number) => void;
}

/**
 * Demo mode plumbing for the 3DGS viewer:
 * - Starts the browser-side head tracker (`utils/head-tracker.ts` — MediaPipe
 *   FaceLandmarker on the webcam) when `demoMode` is on. No external Python
 *   tracker is required.
 * - Reads the smoothed head pose from `useTrackingStore` each frame and pushes it
 *   to the camera as a *render-only* offset (saved viewpoint targets, `mapYaw`,
 *   and stored yaw/pitch are never mutated — head tracking is layered, not
 *   destructive).
 * - Stops the tracker and resets the offset when demo mode turns off, the view
 *   switches to 360° (no movement concept), or the manager unmounts.
 *
 * The PoC defaults (`gain=3`, `invertPitch=true`) live in `tracking-store.ts` and
 * mirror the Xrealtracking PoC behaviour 1:1.
 */
export function useDemoModeCamera(sceneManager: TrackingTarget | null) {
  const demoMode = useUIStore((s) => s.demoMode);
  const viewMode = useUIStore((s) => s.viewMode);
  const enabled = demoMode && viewMode !== '360' && !!sceneManager;

  // Start / stop the browser head tracker (MediaPipe FaceLandmarker + webcam).
  useEffect(() => {
    if (!enabled) {
      stopHeadTracker();
      return;
    }
    void startHeadTracker();
    return () => stopHeadTracker();
  }, [enabled]);

  // Drive the camera per-frame from the tracking store. Pure render-time overlay —
  // smoothing already happens inside tracker.py (One-Euro filter), so we just read
  // the latest values and apply gain.
  useEffect(() => {
    if (!enabled || !sceneManager) return;
    let raf = 0;
    const tick = () => {
      const t = useTrackingStore.getState();
      const yawSign = t.invertYaw ? -1 : 1;
      const pitchSign = t.invertPitch ? -1 : 1;
      sceneManager.setTrackingOffset(yawSign * t.yaw * t.gain, pitchSign * t.pitch * t.gain);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      sceneManager.setTrackingOffset(0, 0);
    };
  }, [enabled, sceneManager]);
}
