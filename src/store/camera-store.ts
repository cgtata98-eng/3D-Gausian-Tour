import { create } from 'zustand';

interface CameraState {
  activeViewpoint: string | null;
  position: [number, number, number];
  pitch: number;
  yaw: number;
  fov: number;
  setActiveViewpoint: (id: string | null) => void;
  setPosition: (pos: [number, number, number]) => void;
  setPitch: (pitch: number) => void;
  setYaw: (yaw: number) => void;
  setFov: (fov: number) => void;
}

export const useCameraStore = create<CameraState>((set) => ({
  activeViewpoint: null,
  position: [0, 1.6, 5],
  pitch: 0,
  yaw: 0,
  fov: 60,
  setActiveViewpoint: (activeViewpoint) => set({ activeViewpoint }),
  setPosition: (position) => set({ position }),
  setPitch: (pitch) => set({ pitch }),
  setYaw: (yaw) => set({ yaw }),
  setFov: (fov) => set({ fov }),
}));
