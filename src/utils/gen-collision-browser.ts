/**
 * Browser-side collision-mesh generator. Calls splat-transform programmatically
 * with a WebGPU / WebGL2 PlayCanvas device, no Node CLI required. Used as the
 * fallback path when the dev-only `/api/gen-collision` middleware isn't reachable
 * (e.g. customer / admin opening the deployed Cloudflare URL).
 *
 * Restored from beb6072^ (the auto-generation removal) for B2 — the removal
 * turned out to be premature: walkthrough features need a floor, and manual
 * GLB authoring alone is too slow for multi-plan scenes.
 *
 * Mirrors the recipe matrix used by the Vite middleware:
 *   walkable → floorFill + capsule carve from seed (navigable volume)
 *   block    → exteriorFill + floorFill (solid walls / outside)
 *
 * Dynamic-imported on first use so the ~3MB splat-transform bundle stays out
 * of the initial page load.
 */
import type { Vec3 } from '../core/types';

export type SplatExt = 'ply' | 'spz' | 'sog' | 'splat';
export type CollisionRecipe = 'walkable' | 'block';

export interface GenCollisionOptions {
  /** `'walkable'` carves the navigable capsule-sweep, `'block'` fills the exterior. */
  recipe: CollisionRecipe;
  /** Seed position in world space — must be inside the room. Used by both
   *  carve (walkable) and exterior-fill (block). Defaults to `[0,0,0]`. */
  seed?: Vec3;
  /** Voxel resolution in world units. splat-transform default is 0.05. Lower
   *  = more detail, more memory, slower. */
  voxelResolution?: number;
}

/**
 * Run the voxel-extraction → collision-GLB pipeline entirely in the browser.
 * Returns the collision GLB as a Blob ready to be saved / uploaded.
 */
export async function generateCollisionInBrowser(
  splat: Blob,
  ext: SplatExt,
  opts: GenCollisionOptions,
): Promise<Blob> {
  const seed = opts.seed ?? [0, 0, 0];
  // 10 cm voxels — fine enough to resolve door frames and steps, coarse
  // enough to keep voxel count under V8's ~16.7 M Set limit once the
  // filter-cluster step has cropped the bbox. Mirrors the CLI's
  // `--voxel-params 0.10,0.1`.
  const voxelResolution = opts.voxelResolution ?? 0.10;

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

  // 3. Spin up the GPU device once — both filterCluster and writeVoxel need
  //    one, and creating it twice doubles WebGPU init time. Offscreen canvas
  //    so we don't disturb whatever device is rendering the live splat.
  const offscreen = document.createElement('canvas');
  offscreen.width = 1;
  offscreen.height = 1;
  const device = await pc.createGraphicsDevice(offscreen, {
    deviceTypes: ['webgpu', 'webgl2'],
  });
  const seedVec = new pc.Vec3(seed[0], seed[1], seed[2]);

  // 4. Pre-process: drop floaters via filterCluster (keeps only gaussians in
  //    the connected component around the seed — shrinks the bbox so the
  //    voxel grid fits under V8's Set limit), then decimate to ≤100 K.
  //    Order mirrors the CLI's `-D -F 100000` action sequence.
  dataTable = await st.processDataTable(
    dataTable,
    [
      { kind: 'filterCluster', seed: seedVec },
      { kind: 'decimate', count: 100000, percent: null },
    ],
    { createDevice: async () => device },
  );

  // 5. Voxelize via writeVoxel using the same device.
  const writeFs = new st.MemoryFileSystem();
  // Map recipe → writeVoxel options. These mirror the CLI flags the Vite
  // middleware passes (--voxel-floor-fill 1.6, --voxel-carve 1.6,0.2,
  // --voxel-external-fill 0.3) so dev and prod produce the same geometry.
  const navSeed = { x: seed[0], y: seed[1], z: seed[2] };
  const recipeOpts = opts.recipe === 'walkable'
    ? {
        navSeed,
        floorFill: true,
        floorFillDilation: 1.6,
        navCapsule: { height: 1.6, radius: 0.2 },
      }
    : {
        navSeed,
        // 0.3 m (≈3 voxels at 0.10 m) — large enough to seal sub-decimeter
        // scan gaps but small enough not to punch through thin walls and
        // collapse the navigable interior. Default 1.6 dilates ~16 voxels
        // and routinely traps the player in solid.
        navExteriorRadius: 0.3,
        floorFill: true,
        floorFillDilation: 1.6,
      };

  try {
    await st.writeVoxel(
      {
        filename: 'out.voxel.json',
        dataTable,
        voxelResolution,
        ...recipeOpts,
        collisionMesh: 'smooth',
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
