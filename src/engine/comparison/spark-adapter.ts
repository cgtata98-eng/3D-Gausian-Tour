import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import type { SplatViewerAdapter, AdapterInitOptions } from './types';

/**
 * Adapter for `@sparkjsdev/spark` (Niantic). Spark is a three.js-based renderer that
 * wraps splats as a regular `Object3D` (`SplatMesh`), so we set up a normal three.js
 * scene + WebGLRenderer, add the Spark renderer object + a SplatMesh, and use the
 * three OrbitControls for navigation.
 *
 * SH degree / encoding stays at the library defaults (band 3 if the input PLY has
 * the data). This is the closest in spirit to Arrival Space's stack.
 */
export class SparkAdapter implements SplatViewerAdapter {
  private renderer: THREE.WebGLRenderer | null = null;
  private rafId: number | null = null;
  private cleanups: Array<() => void> = [];
  private canvas: HTMLCanvasElement | null = null;
  private controls: { dispose: () => void } | null = null;

  async init(parent: HTMLElement, plyUrl: string, _opts?: AdapterInitOptions): Promise<void> {
    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    parent.appendChild(canvas);
    this.canvas = canvas;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0.1, 0.1, 0.15);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 0, 5);

    // Spark's renderer wraps splats — must be added as a child of the scene so its
    // per-frame `onBeforeRender` hook runs. Pattern from Spark's docs.
    const spark = new SparkRenderer({ renderer });
    scene.add(spark);

    // Pure load — no `lod` flag, since runtime Bhatt LoD construction is too slow
    // (30+ seconds for 5M splats). See three-scene-manager.ts comment for rationale.
    const splat = new SplatMesh({ url: plyUrl });
    // Most PLY exports come out flipped on the X axis vs the world up convention used
    // by the other viewers (PlayCanvas / mkkellogg both bake or compensate for this
    // internally). Spark renders the SplatMesh as-is, so we have to flip it ourselves
    // to match the others' orientation.
    splat.rotation.x = Math.PI;
    scene.add(splat);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    this.controls = controls as unknown as { dispose: () => void };

    const doResize = () => {
      const r = parent.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(doResize);
    ro.observe(parent);
    this.cleanups.push(() => ro.disconnect());
    doResize();

    const frame = () => {
      controls.update();
      renderer.render(scene, camera);
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  dispose(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.cleanups.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
    this.cleanups = [];
    try { this.controls?.dispose(); } catch { /* ignore */ }
    this.controls = null;
    try { this.renderer?.dispose(); } catch { /* ignore */ }
    this.renderer = null;
    if (this.canvas?.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
    this.canvas = null;
  }
}
