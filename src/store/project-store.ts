import { create } from 'zustand';
import type { ProjectType, ViewMode } from './ui-store';

export interface Project {
  id: string;
  name: string;
  type: ProjectType;
  viewMode: ViewMode;
  /** Optional thumbnail (data URL or path). */
  thumbnail?: string;
  /** Optional subtitle / description shown under the name in the project list. */
  subtitle?: string;
  /** Unix ms when added. 0 for the seed entries. */
  createdAt: number;
  /** Unix ms of the most recent successful publish. Undefined means never published. */
  publishedAt?: number;
}

const STORAGE_KEY = '3droomtour:projects:v1';

/** Seed entries for the project list — assets live under R2 (or local /assets/scenes
 *  during dev) at `<id>/scene.json`, `<id>/splat.sog`, etc. */
const SEED: Project[] = [];

function loadFromStorage(): Project[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return SEED;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return SEED;
    return parsed;
  } catch {
    return SEED;
  }
}

function persist(list: Project[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // localStorage may be disabled or full; degrade silently.
  }
}

interface State {
  projects: Project[];
  addProject: (p: Omit<Project, 'createdAt'>) => void;
  removeProject: (id: string) => void;
  updateProject: (id: string, patch: Partial<Project>) => void;
  getProject: (id: string) => Project | undefined;
  /** Reset to the seed list (debug helper). */
  resetSeed: () => void;
}

export const useProjectStore = create<State>((set, get) => ({
  projects: loadFromStorage(),
  addProject: (p) => set((s) => {
    const next = [...s.projects, { ...p, createdAt: Date.now() }];
    persist(next);
    return { projects: next };
  }),
  removeProject: (id) => set((s) => {
    const next = s.projects.filter((p) => p.id !== id);
    persist(next);
    return { projects: next };
  }),
  updateProject: (id, patch) => set((s) => {
    const next = s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p));
    persist(next);
    return { projects: next };
  }),
  getProject: (id) => get().projects.find((p) => p.id === id),
  resetSeed: () => set(() => {
    persist(SEED);
    return { projects: SEED };
  }),
}));
