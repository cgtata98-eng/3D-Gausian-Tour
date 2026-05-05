/**
 * Browser-side collision-mesh generator. Calls splat-transform programmatically
 * with a WebGPU / WebGL2 PlayCanvas device, no Node CLI required. Used as the
 * fallback path when the dev-only `/api/gen-collision` middleware isn't reachable
 * (e.g. customer / admin opening the deployed Cloudflare URL).
 *
 * Dynamic-imported on first use so the ~3MB splat-transform bundle stays out
 * of the initial page load.
 */
import type { CollisionMeshShape } from '@playcanvas/splat-transform';

export type SplatExt = 'ply' | 'spz' | 'sog' | 'splat';

export interface GenCollisionOptions {
  /** `'smooth'` (default) or `'faces'`. Matches the CLI -K argument. */
  shape?: CollisionMeshShape;
  /** Voxel resolution in world units. Splat-transform default is 0.05. Lower
   *  = more detailed mesh, more memory, slower. Bump up for huge scans. */
  voxelResolution?: number;
}

/**
 * Run the voxel-extraction → collision-GLB pipeline entirely in the browser.
 * Returns the collision GLB as a Blob ready to be saved / uploaded.
 */
export async function generateCollisionInBrowser(
  splat: Blob,
  ext: SplatExt,
  opts: GenCollisionOptions = {},
): Promise<Blob> {
  const shape = opts.shape ?? 'smooth';
  const voxelResolution = opts.voxelResolution ?? 0.05;

  // Dynamic-import keeps the 3MB WASM bundle out of the initial page load.
  const [st, pc] = await Promise.all([
    import('@playcanvas/splat-transform'),
    import('playcanvas'),
  ]);

  // 1. Stuff the splat bytes into an in-memory file system.
  const inputName = `input.${ext}`;
  const readFs = new st.MemoryReadFileSystem();
  readFs.set(inputName, new Uint8Array(await splat.arrayBuffer()));

  // 2. Pick the right reader for the format. PLY / SPZ / Splat take a single
  //    ReadSource; SOG takes a ReadFileSystem because it's a zip of
  //    meta.json + webp parts and the reader resolves those internally.
  let dataTable;
  if (ext === 'sog') {
    const sogSource = await readFs.createSource(inputName);
    const zipFs = new st.ZipReadFileSystem(sogSource);
    dataTable = await st.readSog(zipFs, 'meta.json');
  } else if (ext === 'ply') {
    dataTable = await st.readPly(await readFs.createSource(inputName));
  } else if (ext === 'spz') {
    dataTable = await st.readSpz(await readFs.createSource(inputName));
  } else if (ext === 'splat') {
    dataTable = await st.readSplat(await readFs.createSource(inputName));
  } else {
    throw new Error(`Unsupported splat format: ${ext}`);
  }

  // 3. Voxelize via writeVoxel; PlayCanvas needs a GraphicsDevice for the GPU
  //    compute step. Spin up an offscreen canvas + device so we don't disturb
  //    whatever device is rendering the live splat.
  const offscreen = document.createElement('canvas');
  offscreen.width = 1;
  offscreen.height = 1;
  const device = await pc.createGraphicsDevice(offscreen, {
    deviceTypes: ['webgpu', 'webgl2'],
  });

  const writeFs = new st.MemoryFileSystem();
  try {
    await st.writeVoxel(
      {
        filename: 'out.voxel.json',
        dataTable,
        voxelResolution,
        collisionMesh: shape,
        createDevice: async () => device,
      },
      writeFs,
    );
  } finally {
    // Don't leak the offscreen GPU device — voxelization is one-shot.
    try { device.destroy(); } catch { /* ignore */ }
  }

  const glb = writeFs.results.get('out.collision.glb');
  if (!glb) throw new Error('splat-transform did not produce a collision GLB');
  // Copy through a fresh Uint8Array<ArrayBuffer> so the Blob constructor's
  // BlobPart type is satisfied (the result map can hold SAB-backed views).
  const copy = new Uint8Array(glb.byteLength);
  copy.set(glb);
  return new Blob([copy], { type: 'model/gltf-binary' });
}
