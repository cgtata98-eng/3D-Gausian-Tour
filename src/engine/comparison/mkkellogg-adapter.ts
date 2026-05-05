import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import type { SplatViewerAdapter, AdapterInitOptions } from './types';

/**
 * Adapter for `@mkkellogg/gaussian-splats-3d`. Self-driven mode = the library owns
 * the canvas, RAF loop, and orbit controls. We only give it a host div.
 *
 * Loads with full SH degree 3 (its default) so we get the best quality this lib has
 * for view-dependent shading.
 */
export class MkkelloggAdapter implements SplatViewerAdapter {
  private viewer: { dispose?: () => Promise<void> | void } | null = null;
  private host: HTMLDivElement | null = null;

  async init(parent: HTMLElement, plyUrl: string, _opts?: AdapterInitOptions): Promise<void> {
    const host = document.createElement('div');
    host.style.position = 'relative';
    host.style.width = '100%';
    host.style.height = '100%';
    parent.appendChild(host);
    this.host = host;

    const Viewer = (GaussianSplats3D as { Viewer: new (opts: Record<string, unknown>) => unknown }).Viewer;
    const SceneFormat = (GaussianSplats3D as { SceneFormat: { Ply: number } }).SceneFormat;

    const viewer = new Viewer({
      cameraUp: [0, -1, 0],
      initialCameraPosition: [0, 0, 5],
      initialCameraLookAt: [0, 0, 0],
      rootElement: host,
      ignoreDevicePixelRatio: false,
      useBuiltInControls: true,
      selfDrivenMode: true,
      sphericalHarmonicsDegree: 3,
      sharedMemoryForWorkers: false,
    }) as {
      start: () => void;
      addSplatScene: (url: string, opts?: Record<string, unknown>) => Promise<void>;
      dispose?: () => Promise<void> | void;
    };

    viewer.start();
    await viewer.addSplatScene(plyUrl, { format: SceneFormat.Ply, showLoadingUI: false });
    this.viewer = viewer;
  }

  dispose(): void {
    if (this.viewer?.dispose) {
      try { void this.viewer.dispose(); } catch { /* ignore */ }
    }
    this.viewer = null;
    if (this.host?.parentElement) {
      this.host.parentElement.removeChild(this.host);
    }
    this.host = null;
  }
}
