import { create } from 'zustand';
import type { SceneManifest, SceneInfo, SceneSettings, SplatTransform, ViewerToolbarConfig, Viewpoint, Plan, FloorPlanConfig, AiGenerationEntry } from '../core/types';
import { useCameraStore } from './camera-store';
import { useProjectStore } from './project-store';

const DEFAULT_FLOOR_PLAN: FloorPlanConfig = {
  image: '',
  bounds: { min: [-10, -10], max: [10, 10] },
  worldToImage: { offsetX: 0, offsetZ: 0, scaleX: 1, scaleZ: 1, rotation: 0 },
};

/**
 * Build a single default plan by absorbing every legacy top-level field on the manifest:
 * splat / info / collision / floorPlan / viewpoints / settings.fixedPosition,
 * plus per-viewpoint legacy panorama360 / thumbnail.
 */
function synthesizeDefaultPlan(m: SceneManifest): Plan {
  const legacyVps = m.viewpoints ?? [];
  const panoramas: Record<string, string> = {};
  const thumbnails: Record<string, string> = {};
  for (const vp of legacyVps) {
    if (vp.panorama360) panoramas[vp.id] = vp.panorama360;
    if (vp.thumbnail) thumbnails[vp.id] = vp.thumbnail;
  }
  // Strip legacy per-viewpoint fields as we copy into the plan.
  const cleanedVps: Viewpoint[] = legacyVps.map(({ panorama360: _p, thumbnail: _t, ...rest }) => rest);
  return {
    id: 'default',
    label: 'デフォルト',
    splat: m.splat,
    splatSpz: m.splatSpz,
    panoramas: Object.keys(panoramas).length > 0 ? panoramas : undefined,
    thumbnails: Object.keys(thumbnails).length > 0 ? thumbnails : undefined,
    info: m.info,
    floorPlan: m.floorPlan,
    collision: m.collision,
    viewpoints: cleanedVps,
    fixedPosition: (m.settings as unknown as { fixedPosition?: Plan['fixedPosition'] }).fixedPosition,
  };
}

/**
 * Wipe the legacy top-level fields once the default plan has absorbed them, leaving
 * `plans[]` as the single source of truth for visual / layout content.
 */
function stripLegacyTopLevelFields(m: SceneManifest): SceneManifest {
  const next: SceneManifest = { ...m };
  delete next.splat;
  delete next.splatSpz;
  delete next.info;
  delete next.collision;
  delete next.floorPlan;
  delete next.viewpoints;
  // settings.fixedPosition was absorbed too; settings type no longer carries it.
  if (next.settings) {
    const cleaned = { ...next.settings } as SceneSettingsLike;
    delete cleaned.fixedPosition;
    next.settings = cleaned;
  }
  return next;
}

type SceneSettingsLike = SceneManifest['settings'] & { fixedPosition?: unknown };

/** Ensure manifest.plans is populated (synthesising one entry from legacy fields if needed). */
function ensurePlans(m: SceneManifest): SceneManifest {
  if (m.plans && m.plans.length > 0) return stripLegacyTopLevelFields(m);
  return stripLegacyTopLevelFields({ ...m, plans: [synthesizeDefaultPlan(m)] });
}

interface SceneState {
  manifest: SceneManifest | null;
  isLoading: boolean;
  isLoaded: boolean;
  error: string | null;
  /**
   * Auto-captured viewpoint thumbnails keyed by **plan id** then viewpoint id.
   * Auto thumbnails are runtime-only (regenerated each session); manual overrides
   * live on `Plan.thumbnails` so they persist with the manifest.
   */
  viewpointThumbnails: Record<string, Record<string, string>>;
  /** Currently active plan id; mirrors manifest.plans[*].id. */
  activePlanId: string | null;
  setManifest: (manifest: SceneManifest) => void;
  setActivePlanId: (id: string | null) => void;
  addPlan: (plan: Plan) => void;
  removePlan: (id: string) => void;
  updatePlanLabel: (id: string, label: string) => void;
  setPlanSplat: (id: string, splat: string | undefined) => void;
  /** Set / clear the SOG bundle marker for a plan. The actual files live in IDB
   *  under the prefix `splat:<sceneId>:<planId>:sog/<filename>`. */
  setPlanSplatSog: (id: string, splatSog: string | undefined) => void;
  /** Update the splat transform (rotation / position) for a plan. Pass `null` to clear. */
  setPlanSplatTransform: (id: string, transform: SplatTransform | null) => void;
  setPlanPanorama: (planId: string, viewpointId: string, panorama: string | undefined) => void;
  setLoading: (loading: boolean) => void;
  setLoaded: (loaded: boolean) => void;
  setError: (error: string | null) => void;
  // ── Active-plan-scoped mutators (UI signatures unchanged) ─────────
  addViewpoint: (vp: Viewpoint) => void;
  removeViewpoint: (id: string) => void;
  updateViewpointLabel: (id: string, label: string) => void;
  setFloorPlanImage: (dataUrl: string) => void;
  updateInfo: (patch: Partial<SceneInfo>) => void;
  // ── Thumbnails ────────────────────────────────────────────────────
  /** Replace the auto thumbnails for one plan (used after a full capture pass). */
  setViewpointThumbnails: (planId: string, thumbs: Record<string, string>) => void;
  /** Save a single auto-captured thumbnail for `planId`/`vpId`. */
  setViewpointThumbnail: (planId: string, vpId: string, dataUrl: string) => void;
  /**
   * Set the **manual** thumbnail (lives on `Plan.thumbnails`, persists with the manifest).
   * Pass `undefined` to clear and fall back to the auto capture.
   */
  setViewpointManualThumbnail: (planId: string, vpId: string, dataUrl: string | undefined) => void;
  // ── Scene-level (global) ──────────────────────────────────────────
  setSceneName: (name: string) => void;
  /** Patch the scene-level settings (camera defaults, zoom bounds, pitch limit, etc). */
  updateSettings: (patch: Partial<SceneSettings>) => void;
  /** Attach ambient audio (BGM) to the manifest. Pass undefined to remove. */
  setSceneAudio: (audio: string | undefined) => void;
  /** Patch the viewer toolbar visibility config. Pass `null` to reset (= all visible). */
  setViewerToolbar: (patch: ViewerToolbarConfig | null) => void;
  // ── AI generation history ─────────────────────────────────────────
  /** Append a new AI generation entry to the active plan's history. */
  addAiGenerationEntry: (entry: AiGenerationEntry) => void;
  /** Remove an AI generation entry by id. */
  removeAiGenerationEntry: (id: string) => void;
  /** Update label / prompt / panoramas / thumbnail of an existing entry. */
  updateAiGenerationEntry: (id: string, patch: Partial<AiGenerationEntry>) => void;
}

/**
 * Helper: mutate the currently active plan, returning the updated manifest. If no manifest
 * or no active plan is set, returns state unchanged.
 */
function withActivePlan(s: SceneState, fn: (p: Plan) => Plan): Partial<SceneState> {
  if (!s.manifest?.plans || !s.activePlanId) return s;
  const plans = s.manifest.plans.map((p) => (p.id === s.activePlanId ? fn(p) : p));
  return { manifest: { ...s.manifest, plans } };
}

export const useSceneStore = create<SceneState>((set) => ({
  manifest: null,
  isLoading: false,
  isLoaded: false,
  error: null,
  viewpointThumbnails: {},
  activePlanId: null,
  setManifest: (manifest) => set(() => {
    const ensured = ensurePlans(manifest);
    return { manifest: ensured, activePlanId: ensured.plans?.[0]?.id ?? null };
  }),
  setActivePlanId: (id) => set((s) => {
    if (s.activePlanId === id) return s;
    const plan = s.manifest?.plans?.find((p) => p.id === id);
    // Reset the active viewpoint to the new plan's first viewpoint (or null) — coords don't translate.
    useCameraStore.getState().setActiveViewpoint(plan?.viewpoints[0]?.id ?? null);
    return { activePlanId: id };
  }),
  addPlan: (plan) => set((s) => {
    if (!s.manifest) return s;
    const next = [...(s.manifest.plans ?? []), plan];
    return { manifest: { ...s.manifest, plans: next } };
  }),
  removePlan: (id) => set((s) => {
    if (!s.manifest?.plans) return s;
    if (s.manifest.plans.length <= 1) return s; // never drop below 1 plan
    const next = s.manifest.plans.filter((p) => p.id !== id);
    const newActive = s.activePlanId === id ? (next[0]?.id ?? null) : s.activePlanId;
    if (newActive !== s.activePlanId) {
      const plan = next.find((p) => p.id === newActive);
      useCameraStore.getState().setActiveViewpoint(plan?.viewpoints[0]?.id ?? null);
    }
    return { manifest: { ...s.manifest, plans: next }, activePlanId: newActive };
  }),
  updatePlanLabel: (id, label) => set((s) => {
    if (!s.manifest?.plans) return s;
    return {
      manifest: {
        ...s.manifest,
        plans: s.manifest.plans.map((p) => p.id === id ? { ...p, label } : p),
      },
    };
  }),
  setPlanSplat: (id, splat) => set((s) => {
    if (!s.manifest?.plans) return s;
    return {
      manifest: {
        ...s.manifest,
        plans: s.manifest.plans.map((p) => p.id === id ? { ...p, splat } : p),
      },
    };
  }),
  setPlanSplatSog: (id, splatSog) => set((s) => {
    if (!s.manifest?.plans) return s;
    return {
      manifest: {
        ...s.manifest,
        plans: s.manifest.plans.map((p) => {
          if (p.id !== id) return p;
          const next = { ...p };
          if (splatSog === undefined) delete next.splatSog;
          else next.splatSog = splatSog;
          return next;
        }),
      },
    };
  }),
  setPlanSplatTransform: (id, transform) => set((s) => {
    if (!s.manifest?.plans) return s;
    return {
      manifest: {
        ...s.manifest,
        plans: s.manifest.plans.map((p) => p.id === id
          ? { ...p, splatTransform: transform === null ? undefined : transform }
          : p),
      },
    };
  }),
  setPlanPanorama: (planId, viewpointId, panorama) => set((s) => {
    if (!s.manifest?.plans) return s;
    return {
      manifest: {
        ...s.manifest,
        plans: s.manifest.plans.map((p) => {
          if (p.id !== planId) return p;
          const next = { ...(p.panoramas ?? {}) };
          if (panorama === undefined) delete next[viewpointId];
          else next[viewpointId] = panorama;
          const cleaned = Object.keys(next).length > 0 ? next : undefined;
          return { ...p, panoramas: cleaned };
        }),
      },
    };
  }),
  setViewpointThumbnails: (planId, thumbs) => set((s) => ({
    viewpointThumbnails: { ...s.viewpointThumbnails, [planId]: thumbs },
  })),
  setLoading: (isLoading) => set({ isLoading }),
  setLoaded: (isLoaded) => set({ isLoaded }),
  setError: (error) => set({ error }),

  // ── Active-plan-scoped (write to current plan's content) ───────────
  addViewpoint: (vp) => set((s) => withActivePlan(s, (p) => ({
    ...p,
    viewpoints: [...p.viewpoints, vp],
  }))),
  removeViewpoint: (id) => set((s) => withActivePlan(s, (p) => ({
    ...p,
    viewpoints: p.viewpoints.filter((v) => v.id !== id),
  }))),
  updateViewpointLabel: (id, label) => set((s) => withActivePlan(s, (p) => ({
    ...p,
    viewpoints: p.viewpoints.map((v) => (v.id === id ? { ...v, label } : v)),
  }))),
  setFloorPlanImage: (dataUrl) => set((s) => withActivePlan(s, (p) => ({
    ...p,
    floorPlan: { ...(p.floorPlan ?? DEFAULT_FLOOR_PLAN), image: dataUrl },
  }))),
  updateInfo: (patch) => set((s) => withActivePlan(s, (p) => ({
    ...p,
    info: { ...(p.info ?? {}), ...patch },
  }))),

  setViewpointThumbnail: (planId, vpId, dataUrl) => set((s) => ({
    viewpointThumbnails: {
      ...s.viewpointThumbnails,
      [planId]: { ...(s.viewpointThumbnails[planId] ?? {}), [vpId]: dataUrl },
    },
  })),
  setViewpointManualThumbnail: (planId, vpId, dataUrl) => set((s) => {
    if (!s.manifest?.plans) return s;
    return {
      manifest: {
        ...s.manifest,
        plans: s.manifest.plans.map((p) => {
          if (p.id !== planId) return p;
          const next = { ...(p.thumbnails ?? {}) };
          if (dataUrl === undefined) delete next[vpId];
          else next[vpId] = dataUrl;
          const cleaned = Object.keys(next).length > 0 ? next : undefined;
          return { ...p, thumbnails: cleaned };
        }),
      },
    };
  }),
  setSceneName: (name) => set((s) => {
    if (!s.manifest) return s;
    // The Project list (ProjectScreen) is backed by `useProjectStore`, which holds
    // an independent `name` per project. Mirror the change there so the rename
    // propagates to the project list / cards immediately.
    useProjectStore.getState().updateProject(s.manifest.id, { name });
    return { manifest: { ...s.manifest, name } };
  }),
  updateSettings: (patch) => set((s) => {
    if (!s.manifest) return s;
    return { manifest: { ...s.manifest, settings: { ...s.manifest.settings, ...patch } } };
  }),
  setSceneAudio: (audio) => set((s) => {
    if (!s.manifest) return s;
    const next = { ...s.manifest };
    if (audio === undefined) delete next.audio;
    else next.audio = audio;
    return { manifest: next };
  }),
  setViewerToolbar: (patch) => set((s) => {
    if (!s.manifest) return s;
    const next = { ...s.manifest };
    if (patch === null) {
      delete next.viewerToolbar;
    } else {
      next.viewerToolbar = patch;
    }
    return { manifest: next };
  }),
  addAiGenerationEntry: (entry) => set((s) => withActivePlan(s, (p) => ({
    ...p,
    aiHistory: [...(p.aiHistory ?? []), entry],
  }))),
  removeAiGenerationEntry: (id) => set((s) => withActivePlan(s, (p) => ({
    ...p,
    aiHistory: (p.aiHistory ?? []).filter((e) => e.id !== id),
  }))),
  updateAiGenerationEntry: (id, patch) => set((s) => withActivePlan(s, (p) => ({
    ...p,
    aiHistory: (p.aiHistory ?? []).map((e) => e.id === id ? { ...e, ...patch } : e),
  }))),
}));
