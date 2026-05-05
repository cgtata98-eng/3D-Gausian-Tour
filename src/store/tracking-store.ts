import { create } from 'zustand';

/**
 * Head-tracking state — written by `head-tracker.ts` from the Xrealtracking
 * `tracker.py` WebSocket stream (`ws://localhost:8765`).
 *
 * `yaw` / `pitch` / `roll` are degrees, smoothed by `tracker.py`'s One-Euro filter.
 * `gain` and `invertPitch` mirror the Xrealtracking PoC defaults so motion feels
 * the same.
 */
interface TrackingState {
  connected: boolean;
  /** 'face' | 'pose' | 'none' */
  source: string;
  yaw: number;
  pitch: number;
  roll: number;
  /** Multiplier applied to raw yaw/pitch when driving the camera. PoC default 3.0. */
  gain: number;
  invertYaw: boolean;
  invertPitch: boolean;
  setConnected: (v: boolean) => void;
  setPose: (yaw: number, pitch: number, roll: number, source: string) => void;
  setGain: (v: number) => void;
  setInvertYaw: (v: boolean) => void;
  setInvertPitch: (v: boolean) => void;
}

export const useTrackingStore = create<TrackingState>((set) => ({
  connected: false,
  source: 'none',
  yaw: 0,
  pitch: 0,
  roll: 0,
  gain: 3.0,
  invertYaw: false,
  invertPitch: true,
  setConnected: (connected) => set({ connected }),
  setPose: (yaw, pitch, roll, source) => set({ yaw, pitch, roll, source }),
  setGain: (gain) => set({ gain }),
  setInvertYaw: (invertYaw) => set({ invertYaw }),
  setInvertPitch: (invertPitch) => set({ invertPitch }),
}));
