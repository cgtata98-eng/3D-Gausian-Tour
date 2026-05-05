import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'http';

/**
 * Dev-time middleware that proxies AI image-edit requests to OpenAI.
 *
 * The API key lives in `.env.local` (not committed) and never reaches the
 * browser. The browser POSTs JSON `{ image: <data-url>, prompt: <string> }` to
 * `/api/ai/edit`; this middleware re-packages it as multipart/form-data for
 * `https://api.openai.com/v1/images/edits` and pipes the JSON response back.
 *
 * For production we'll mirror this same endpoint in a Cloudflare Worker (or
 * inside the Tauri shell) so the client code doesn't need to change.
 */
function aiImageProxy(env: Record<string, string>) {
  return {
    name: 'ai-image-proxy',
    configureServer(server: { middlewares: { use: (path: string, fn: (req: IncomingMessage, res: ServerResponse) => void) => void } }) {
      server.middlewares.use('/api/ai/edit', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method Not Allowed');
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let body: { image?: string; images?: string[]; prompt?: string; model?: string; size?: string };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        } catch {
          res.statusCode = 400;
          res.end('Invalid JSON');
          return;
        }
        const apiKey = env.OPENAI_API_KEY;
        if (!apiKey) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: { message: 'OPENAI_API_KEY is not set in .env.local' } }));
          return;
        }
        // Accept either a single `image` (legacy) or `images` array (new). The first
        // entry is treated as the primary input; the rest are attached as additional
        // reference images. OpenAI's edits endpoint accepts multiple `image[]` fields.
        const list = (Array.isArray(body.images) && body.images.length > 0)
          ? body.images
          : (body.image ? [body.image] : []);
        if (list.length === 0) {
          res.statusCode = 400;
          res.end('Missing image(s)');
          return;
        }
        const form = new FormData();
        list.forEach((dataUrl, i) => {
          const m = String(dataUrl).match(/^data:image\/[a-zA-Z]+;base64,(.+)$/);
          const b64 = m ? m[1] : String(dataUrl);
          const buf = Buffer.from(b64, 'base64');
          const blob = new Blob([buf], { type: 'image/png' });
          form.append('image[]', blob, `input_${i}.png`);
        });
        form.append('prompt', String(body.prompt ?? ''));
        // Default to gpt-image-1 until the org is verified; switch to 'gpt-image-2'
        // here once `Verify Organization` has propagated (can take up to 15 min).
        form.append('model', String(body.model ?? 'gpt-image-1'));
        form.append('size', String(body.size ?? '1536x1024'));
        form.append('n', '1');
        try {
          const r = await fetch('https://api.openai.com/v1/images/edits', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}` },
            body: form,
          });
          const text = await r.text();
          res.statusCode = r.status;
          res.setHeader('Content-Type', 'application/json');
          res.end(text);
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
