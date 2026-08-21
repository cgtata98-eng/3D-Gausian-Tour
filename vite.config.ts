import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'http';
import { handleAiEdit } from './src/shared/ai-edit-handler';
import { ffmpegAvailable, makeReverse, saveUpload, sizeOf, streamFile, workDirFor } from './devtools/video360-tools';

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
 * 開発中だけ動く、ローカル ffmpeg の呼び出し口。
 *
 * 逆走用の反転素材はブラウザ内では作れない (動画を後ろから作り直す処理)。
 * 端末を開いてコマンドを打ち、出来たファイルを選び直す往復を無くすため、
 * dev サーバの中で ffmpeg を起動して、出来たものをそのまま返す。
 *
 * 本番 (Cloudflare Worker) にこの経路は無い。UI は `ping` の返事を見て、
 * ffmpeg が使える環境のときだけボタンを出す。
 */
function video360Tools() {
  return {
    name: 'video360-tools',
    configureServer(server: { middlewares: { use: (path: string, fn: (req: IncomingMessage, res: ServerResponse) => void) => void } }) {
      const json = (res: ServerResponse, status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
      };

      // この端末で ffmpeg が使えるか。UI のボタン表示はこれで決める。
      server.middlewares.use('/api/dev/video360/ping', async (_req, res) => {
        json(res, 200, { ffmpeg: await ffmpegAvailable() });
      });

      // 出来た素材を取りに来る口。パスは受け取らず、scene/plan/name から組み立てる
      // ― 任意のパスを読ませると、dev サーバがファイル読み出しの穴になる。
      server.middlewares.use('/api/dev/video360/file', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
          const sceneId = url.searchParams.get('scene') ?? '';
          const planId = url.searchParams.get('plan') ?? '';
          const name = (url.searchParams.get('name') ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
          if (!sceneId || !planId || !name) { json(res, 400, { error: 'scene / plan / name が要ります' }); return; }
          const path = `${workDirFor(sceneId, planId)}/${name}`;
          const size = await sizeOf(path);
          if (size === null) { json(res, 404, { error: 'ファイルがありません' }); return; }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'video/mp4');
          res.setHeader('Content-Length', String(size));
          streamFile(path).pipe(res);
        } catch (e) {
          json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      });

      // 反転素材を作る。進捗を NDJSON で流しながら、最後に出来たファイルの場所を返す。
      // 8K・数分だと数分かかるので、押しっぱなしで無反応にはしない。
      server.middlewares.use('/api/dev/video360/reverse', async (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { error: 'POST only' }); return; }
        try {
          const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
          const sceneId = url.searchParams.get('scene') ?? 'scene';
          const planId = url.searchParams.get('plan') ?? 'plan';
          const name = (url.searchParams.get('name') ?? 'tour.mp4').replace(/[^A-Za-z0-9._-]/g, '_');

          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = Buffer.concat(chunks);
          if (body.byteLength === 0) { json(res, 400, { error: '動画が空です' }); return; }

          const dir = workDirFor(sceneId, planId);
          const inputPath = await saveUpload(dir, name, body);
          const outName = name.replace(/\.[^.]+$/, '') + '-rev.mp4';
          const outPath = `${dir}/${outName}`;

          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/x-ndjson');
          res.setHeader('Cache-Control', 'no-cache');
          const emit = (o: unknown) => res.write(`${JSON.stringify(o)}\n`);
          emit({ stage: 'saved', message: `${inputPath} に保存しました` });

          await makeReverse(inputPath, outPath, (pr) => emit(pr));

          const size = await sizeOf(outPath);
          if (size === null) { emit({ error: '反転素材を作れませんでした' }); res.end(); return; }
          // 中身は返さない。8K・数分だと数百 MB〜GB になり、base64 にした時点で
          // サーバもブラウザもメモリを持っていかれる。場所だけ返して別口で取らせる。
          emit({ stage: 'result', path: outPath, name: outName, bytes: size });
          res.end();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (res.headersSent) { res.write(`${JSON.stringify({ error: msg })}\n`); res.end(); }
          else json(res, 500, { error: msg });
        }
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), aiImageProxy(env), video360Tools()],
  };
});
