import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'http';
import { spawn } from 'child_process';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import { handleAiEdit } from './src/shared/ai-edit-handler';

/**
 * Dev-time middleware that proxies AI image-edit requests to OpenAI or Google Gemini.
 *
 * The actual proxy logic lives in `src/shared/ai-edit-handler.ts` and is SHARED with
 * the production Cloudflare Worker — this middleware only bridges Node's
 * IncomingMessage/ServerResponse to the web-standard Request/Response the handler
 * speaks. That way every guard (same-origin, key/auth requirement, body-size cap,
 * model-id charset) and every error shape is identical in dev and production; the
 * proxies can no longer drift apart ("works in dev, 401s in prod").
 *
 * Server-side fallback keys come from `.env.local` (`OPENAI_API_KEY` /
 * `GEMINI_API_KEY`) — the dev equivalent of the Worker's `wrangler secret`s.
 */
function aiImageProxy(env: Record<string, string>) {
  return {
    name: 'ai-image-proxy',
    configureServer(server: { middlewares: { use: (path: string, fn: (req: IncomingMessage, res: ServerResponse) => void) => void } }) {
      // Which providers have a server-side (.env.local) key — mirrors the Worker's
      // /api/ai/config so the UI can offer key-free generation in dev too.
      server.middlewares.use('/api/ai/config', (_req, res) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ gemini: !!env.GEMINI_API_KEY, openai: !!env.OPENAI_API_KEY }));
      });
      server.middlewares.use('/api/ai/edit', async (req, res) => {
        try {
          // Bridge Node → web-standard Request, then run the SAME handler as the
          // production Worker. Buffer the body first so Content-Length is exact
          // (the handler's size cap reads it).
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const bodyBuf = Buffer.concat(chunks);
          const url = new URL('/api/ai/edit', `http://${req.headers.host ?? 'localhost'}`);
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === 'string') headers.set(k, v);
            else if (Array.isArray(v)) headers.set(k, v.join(', '));
          }
          headers.set('content-length', String(bodyBuf.byteLength));
          const request = new Request(url, {
            method: req.method ?? 'POST',
            headers,
            body: bodyBuf.byteLength > 0 ? bodyBuf : undefined,
          });
          const response = await handleAiEdit(request, {
            gemini: env.GEMINI_API_KEY,
            openai: env.OPENAI_API_KEY,
          });
          res.statusCode = response.status;
          response.headers.forEach((val, key) => res.setHeader(key, val));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (e) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: { message: e instanceof Error ? e.message : String(e) } }));
        }
      });
    },
  };
}

/**
 * Dev-time middleware that runs `splat-transform` as a child process to extract
 * a collision GLB from a splat file. The browser POSTs splat bytes plus headers
 * describing the recipe (`X-Recipe: walkable | block`), input format, and a
 * seed position inside the room (`X-Seed: x,y,z`). The middleware writes a
 * temp file, runs the CLI with recipe-specific voxel-pipeline flags, reads
 * back the generated `.collision.glb`, and pipes it back as
 * `model/gltf-binary`.
 *
 * Restored from beb6072^ for B2 (auto collision generation revival). The CLI
 * path is much faster than the in-browser WASM fallback
 * (src/utils/gen-collision-browser.ts) — the browser tries this first in dev.
 *
 * Two recipes — both follow the official splat-transform voxel pipeline.
 * Three knobs balance precision vs the well-known `RangeError: Set maximum
 * size exceeded` (V8 caps Set at ~16.7 M entries):
 *   `-D` (filter-cluster)        — keeps only the connected gaussian
 *                                  cluster around the seed; deletes far
 *                                  floaters that bloat the bbox.
 *   `--voxel-params 0.10,0.1`    — 10 cm voxels. Default 5 cm produces
 *                                  excessively detailed walls; 15 cm was
 *                                  too coarse around door frames / steps.
 *   `-F 100000`                  — cap working set at 100 K gaussians.
 *
 * | recipe   | flags                                                   | output |
 * |----------|---------------------------------------------------------|--------|
 * | walkable | `--voxel-params 0.10,0.1 --seed-pos S --voxel-floor-fill 1.6 --voxel-carve 1.6,0.2 -K input -D -F 100000 output` | mesh of the carved capsule-swept navigable volume |
 * | block    | `--voxel-params 0.10,0.1 --seed-pos S --voxel-external-fill 0.3 --voxel-floor-fill 1.6 -K input -D -F 100000 output` | mesh of the exterior-filled solid (walls + outside) |
 *
 * Production deploy doesn't carry the CLI — the customer-facing Worker has no
 * Node runtime, so this is dev-only; the browser WASM path covers production.
 */
function collisionGen() {
  return {
    name: 'gen-collision',
    configureServer(server: { middlewares: { use: (path: string, fn: (req: IncomingMessage, res: ServerResponse) => void) => void } }) {
      server.middlewares.use('/api/gen-collision', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method Not Allowed');
          return;
        }
        const ext = String(req.headers['x-input-ext'] ?? '').toLowerCase();
        if (!['ply', 'spz', 'sog', 'splat'].includes(ext)) {
          res.statusCode = 400;
          res.end('Bad X-Input-Ext (expected ply/spz/sog/splat)');
          return;
        }
        const recipe = String(req.headers['x-recipe'] ?? '').toLowerCase();
        if (!['walkable', 'block'].includes(recipe)) {
          res.statusCode = 400;
          res.end('Bad X-Recipe (expected walkable/block)');
          return;
        }
        const seedRaw = String(req.headers['x-seed'] ?? '0,0,0');
        // Reject anything that isn't three comma-separated finite numbers.
        // The seed becomes a CLI arg so we don't want shell-injection bait.
        const seedParts = seedRaw.split(',').map((s) => Number(s.trim()));
        if (seedParts.length !== 3 || seedParts.some((n) => !Number.isFinite(n))) {
          res.statusCode = 400;
          res.end('Bad X-Seed (expected "x,y,z" with finite numbers)');
          return;
        }
        const seed = seedParts.join(',');

        // Stream the request body to a temp file so we don't buffer huge splats
        // in memory.
        let tmp: string | null = null;
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = Buffer.concat(chunks);

          tmp = await mkdtemp(join(tmpdir(), 'gencol-'));
          const inFile = join(tmp, `input.${ext}`);
          const outBase = join(tmp, 'out.voxel.json');
          const collisionFile = join(tmp, 'out.collision.glb');
          await writeFile(inFile, body);

          // Recipe-specific voxel-pipeline flags. See the table in the JSDoc
          // above for what each recipe produces. `--voxel-params / --seed-pos
          // / --voxel-* / -K` are GLOBAL options (go before the input file).
          // `-D` (filter-cluster) and `-F` (decimate) are ACTIONS applied
          // to the working set after input is read.
          //
          // Order matters: `-D` first to drop floaters and shrink the bbox,
          // THEN `-F` to thin to 100 K. Doing -F first would decimate
          // floaters proportionally and the bbox would still be huge.
          const globalArgs = recipe === 'walkable'
            ? ['--voxel-params', '0.10,0.1', '--seed-pos', seed, '--voxel-floor-fill', '1.6', '--voxel-carve', '1.6,0.2', '-K']
            // Default --voxel-external-fill 1.6 dilates the exterior 1.6 m
            // (≈16 voxels at 0.10 m). On scans with thin walls that dilation
            // punches through and seals shut the navigable interior, leaving
            // the player trapped in a solid block. 0.3 m (3 voxels at 10 cm)
            // is just enough to bridge sub-decimeter scan gaps without
            // eating room.
            : ['--voxel-params', '0.10,0.1', '--seed-pos', seed, '--voxel-external-fill', '0.3', '--voxel-floor-fill', '1.6', '-K'];
          const inputActions = ['-D', '-F', '100000'];

          // Resolve the locally-installed CLI script and invoke it via the
          // current Node binary. Avoids `npx`, which on a clean cache will
          // hit the npm registry for an unscoped `splat-transform` package
          // that doesn't exist (the real package is `@playcanvas/...`) and
          // 404 within ~1s. The package's `exports` field hides
          // ./package.json, so resolve the main entry (dist/index.{c,m}js)
          // and walk up to bin/cli.mjs.
          const require = createRequire(import.meta.url);
          const mainPath = require.resolve('@playcanvas/splat-transform');
          const cliPath = join(dirname(dirname(mainPath)), 'bin', 'cli.mjs');
          const cliArgs = [cliPath, ...globalArgs, inFile, ...inputActions, outBase];
          const proc = spawn(
            process.execPath,
            cliArgs,
            { stdio: ['ignore', 'pipe', 'pipe'], shell: false },
          );

          // If the browser aborts mid-flight (page reload, click again,
          // navigate away) the child process otherwise keeps running, eats
          // 1 GB+ of RAM, and we have no way to reach it from elsewhere.
          // Hook the request lifecycle and reap the process explicitly.
          let aborted = false;
          const cleanup = () => {
            if (proc.exitCode !== null) return;
            aborted = true;
            try { proc.kill('SIGTERM'); } catch { /* already dead */ }
            // Win32 SIGTERM doesn't always propagate; force after a beat.
            setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 500);
          };
          req.on('close', cleanup);
          res.on('close', cleanup);
          // Mirror progress to the Vite console so the developer can see
          // BVH-build / voxelize phases — voxelization is the long step
          // (multiple minutes for ~1M-gaussian splats) and otherwise looks
          // like the request is hung.
          console.log(`[gen-collision] ${recipe} ${ext} ${(body.length / 1024 / 1024).toFixed(1)}MB seed=${seed} → splat-transform ${globalArgs.join(' ')} <input> ${inputActions.join(' ')} <output>`);
          let stderr = '';
          proc.stderr.on('data', (c) => {
            const s = c.toString();
            stderr += s;
            process.stderr.write(s);
          });
          // The CLI prints progress to stdout (▸ Build voxels, etc).
          let stdout = '';
          proc.stdout.on('data', (c) => {
            const s = c.toString();
            stdout += s;
            process.stdout.write(s);
          });
          const code: number = await new Promise((resolve) => {
            proc.on('close', resolve);
            proc.on('error', () => resolve(1));
          });
          // Client gave up — don't bother responding (socket is gone anyway).
          if (aborted) return;
          if (code !== 0) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: 'splat-transform failed',
              code,
              stderr: stderr.slice(-2000),
              stdout: stdout.slice(-2000),
            }));
            return;
          }

          let glb: Buffer;
          try {
            glb = await readFile(collisionFile);
          } catch {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'collision GLB missing', stderr: stderr.slice(-2000) }));
            return;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'model/gltf-binary');
          res.setHeader('Content-Length', String(glb.length));
          res.end(glb);
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        } finally {
          if (tmp) {
            // Best-effort cleanup; don't block the response.
            void rm(tmp, { recursive: true, force: true });
          }
        }
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), aiImageProxy(env), collisionGen()],
  };
});
