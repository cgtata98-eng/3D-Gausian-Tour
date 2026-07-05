import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'http';
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

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), aiImageProxy(env)],
  };
});
