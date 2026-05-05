/**
 * Common interface for the side-by-side renderer comparison sandbox. Each adapter
 * mounts on a single canvas, loads one PLY, runs its own RAF loop with built-in
 * orbit controls, and tears everything down on `dispose()`.
 *
 * Intentionally minimal — the comparison UI's job is "look at the same splat in
 * each renderer to judge quality", not "reproduce the production viewer". So no
 * viewpoints, no movement modes, no collision.
 */
/** Per-init knobs forwarded to each adapter. Currently empty; reserved for future per-adapter knobs. */
export type AdapterInitOptions = Record<string, never>;

export interface SplatViewerAdapter {
  /**
   * Mount the renderer into `parent` (creating its own canvas) and load the splat.
   * Some libs (mkkellogg / spark) prefer to manage the canvas themselves, hence the
   * parent-element contract instead of a pre-created canvas.
   */
  init(parent: HTMLElement, plyUrl: string, opts?: AdapterInitOptions): Promise<void>;
  /** Tear everything down: stop RAF, free GL resources, drop event listeners. */
  dispose(): void;
}

export type ViewerKind = 'playcanvas' | 'mkkellogg' | 'spark';

export const VIEWER_LABELS: Record<ViewerKind, { label: string; sub: string }> = {
  playcanvas: { label: 'PlayCanvas', sub: '現プロジェクト基盤 / engine v2' },
  mkkellogg:  { label: 'mkkellogg',  sub: 'GaussianSplats3D — three.js' },
  spark:      { label: 'Spark',      sub: 'Niantic / Arrival Space 系' },
};
