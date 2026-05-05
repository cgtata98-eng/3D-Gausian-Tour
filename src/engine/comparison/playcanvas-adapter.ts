import {
  AppBase,
  AppOptions,
  createGraphicsDevice,
  CameraComponentSystem,
  RenderComponentSystem,
  LightComponentSystem,
  GSplatComponentSystem,
  GSplatHandler,
  Mouse,
  TouchDevice,
  Keyboard,
  Entity,
  Color,
  DEVICETYPE_WEBGL2,
  math,
} from 'playcanvas';
import { loadGSplat } from '../gsplat-loader';
import type { SplatViewerAdapter, AdapterInitOptions } from './types';

/**
 * PlayCanvas v2 adapter for the comparison sandbox. Stripped-down clone of the
 * production app-init / scene-manager, with built-in orbit controls so the user can
 * look around the splat without our SceneManager / camera-controller code path.
 *
 * Only the splat is loaded — no panoramas, no collision. The point is to see what
 * the same renderer + same PLY look like in isolation.
 */
export class PlayCanvasAdapter implements SplatViewerAdapter {
  private app: AppBase | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private cleanups: Array<() => void> = [];

  async init(host: HTMLElement, plyUrl: string, _opts?: AdapterInitOptions): Promise<void> {
    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    host.appendChild(canvas);
    this.canvas = canvas;
    const device = await createGraphicsDevice(canvas, {
      deviceTypes: [DEVICETYPE_WEBGL2],
      antialias: false,
      powerPreference: 'high-performance',
    });

    const app = new AppBase(canvas);
    const opts = new AppOptions();
    opts.graphicsDevice = device;
    opts.componentSystems = [
      CameraComponentSystem,
      RenderComponentSystem,
      LightComponentSystem,
      GSplatComponentSystem,
    ];
    opts.resourceHandlers = [GSplatHandler];
    opts.mouse = new Mouse(canvas);
    opts.touch = new TouchDevice(canvas);
    opts.keyboard = new Keyboard(window);
    app.init(opts);
    app.setCanvasFillMode('NONE' as never);
    app.setCanvasResolution('AUTO' as never);

    app.scene.ambientLight = new Color(0.3, 0.3, 0.3);

    const camera = new Entity('camera');
    camera.addComponent('camera', {
      clearColor: new Color(0.1, 0.1, 0.15),
      fov: 60,
      nearClip: 0.1,
      farClip: 1000,
    });
    app.root.addChild(camera);

    // Resize: track the host element since the canvas itself is sized by us.
    const doResize = () => {
      const r = host.getBoundingClientRect();
      canvas.style.width = `${Math.max(1, Math.round(r.width))}px`;
      canvas.style.height = `${Math.max(1, Math.round(r.height))}px`;
      app.resizeCanvas(Math.round(r.width), Math.round(r.height));
    };
    const ro = new ResizeObserver(doResize);
    ro.observe(host);
    this.cleanups.push(() => ro.disconnect());
    doResize();

    app.start();
    this.app = app;

    await loadGSplat(app, plyUrl, 'splat-pc-compare');

    // Frame the splat: take a guess at a reasonable starting orbit.
    let yaw = 0, pitch = -10, distance = 5;
    const target = { x: 0, y: 0, z: 0 };
    const apply = () => {
      const yr = (yaw * Math.PI) / 180;
      const pr = (pitch * Math.PI) / 180;
      const x = target.x + Math.sin(yr) * Math.cos(pr) * distance;
      const y = target.y + Math.sin(pr) * distance;
      const z = target.z + Math.cos(yr) * Math.cos(pr) * distance;
      camera.setPosition(x, y, z);
      camera.lookAt(target.x, target.y, target.z);
    };
    apply();

    let dragging = false;
    let lx = 0, ly = 0;
    const onDown = (e: MouseEvent) => { if (e.button === 0) { dragging = true; lx = e.clientX; ly = e.clientY; } };
    const onUp   = () => { dragging = false; };
    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      yaw   -= (e.clientX - lx) * 0.3;
      pitch  = math.clamp(pitch - (e.clientY - ly) * 0.3, -89, 89);
      lx = e.clientX; ly = e.clientY;
      apply();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      distance = math.clamp(distance * (e.deltaY < 0 ? 0.9 : 1.1), 0.3, 50);
      apply();
    };
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    this.cleanups.push(() => {
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('wheel', onWheel);
    });
  }

  dispose(): void {
    this.cleanups.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
    this.cleanups = [];
    if (this.app) {
      try { this.app.destroy(); } catch { /* ignore */ }
      this.app = null;
    }
    if (this.canvas?.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
    this.canvas = null;
  }
}
