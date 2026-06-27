import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'http';

/**
 * Dev-time middleware that proxies AI image-edit requests to OpenAI or Google Gemini.
 *
 * The browser POSTs JSON `{ provider, model, images: dataUrl[], prompt }` to
 * `/api/ai/edit`. API keys never reach the customer build — in dev they come from the
 * per-request header (`X-OpenAI-Key` / `X-Gemini-Key`, entered via the ⚙ settings UI)
 * or fall back to `.env.local` (`OPENAI_API_KEY` / `GEMINI_API_KEY`). Both providers are
 * normalized to OpenAI's `{ data: [{ b64_json }] }` shape so the client parser is simple.
 *
 * Auth differs by provider: OpenAI uses `Authorization: Bearer`, Gemini uses the
 * `x-goog-api-key` header (NOT Bearer). For production we'll mirror this in a Cloudflare
 * Worker so the client code doesn't change.
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
        const sendJson = (status: number, obj: unknown) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(obj));
        };
        if (req.method !== 'POST') { sendJson(405, { error: { message: 'Method Not Allowed' } }); return; }

        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let body: { image?: string; images?: string[]; prompt?: string; provider?: string; model?: string; size?: string; aspectRatio?: string; imageSize?: string };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        } catch {
          sendJson(400, { error: { message: 'Invalid JSON' } });
          return;
        }

        const list = (Array.isArray(body.images) && body.images.length > 0)
          ? body.images
          : (body.image ? [body.image] : []);
        if (list.length === 0) { sendJson(400, { error: { message: 'Missing image(s)' } }); return; }
        const prompt = String(body.prompt ?? '');
        const provider = body.provider === 'gemini' ? 'gemini' : 'openai';

        // Decode a `data:<mime>;base64,<data>` URL into its parts (default png).
        const decode = (dataUrl: string): { mime: string; base64: string } => {
          const m = String(dataUrl).match(/^data:([a-zA-Z0-9.+/-]+);base64,(.+)$/);
          return m ? { mime: m[1], base64: m[2] } : { mime: 'image/png', base64: String(dataUrl) };
        };

        try {
          if (provider === 'gemini') {
            const key = (req.headers['x-gemini-key'] as string | undefined)?.trim() || env.GEMINI_API_KEY;
            if (!key) {
              sendJson(500, { error: { message: 'Gemini API キーが未設定です。右上の ⚙ から Gemini キーを入力するか、.env.local に GEMINI_API_KEY を設定してください。' } });
              return;
            }
            const model = String(body.model ?? 'gemini-3.1-flash-image');
            // gemini-2.5-flash-image accepts only 3 input images total; clamp for safety.
            const imgs = model === 'gemini-2.5-flash-image' ? list.slice(0, 3) : list;
            const parts = [
              { text: prompt },
              ...imgs.map((d) => {
                const { mime, base64 } = decode(d);
                return { inline_data: { mime_type: mime, data: base64 } };
              }),
            ];
            // Optional sizing/shape. 4K is only reliable on the Pro model — clamp others to 2K.
            const aspectRatio = typeof body.aspectRatio === 'string' ? body.aspectRatio : '';
            let imageSize = typeof body.imageSize === 'string' ? body.imageSize : '';
            if (imageSize === '4K' && model !== 'gemini-3-pro-image') imageSize = '2K';
            const imageConfig: Record<string, string> = {};
            if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
            if (imageSize) imageConfig.imageSize = imageSize;
            const generationConfig: Record<string, unknown> = { responseModalities: ['IMAGE'] };
            if (Object.keys(imageConfig).length > 0) generationConfig.imageConfig = imageConfig;
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
              body: JSON.stringify({ contents: [{ parts }], generationConfig }),
            });
            const j = await r.json() as {
              candidates?: { content?: { parts?: { inlineData?: { data?: string }; inline_data?: { data?: string } }[] }; finishReason?: string }[];
              promptFeedback?: { blockReason?: string };
              error?: { message?: string };
            };
            if (!r.ok) { sendJson(r.status, j?.error ? j : { error: { message: JSON.stringify(j) } }); return; }
            const rparts = j?.candidates?.[0]?.content?.parts ?? [];
            const imgPart = rparts.find((p) => p.inlineData ?? p.inline_data);
            const b64 = imgPart?.inlineData?.data ?? imgPart?.inline_data?.data;
            if (!b64) {
              const reason = j?.candidates?.[0]?.finishReason ?? j?.promptFeedback?.blockReason ?? 'unknown';
              sendJson(422, { error: { message: `Gemini が画像を返しませんでした（safety block / finishReason: ${reason}）` } });
              return;
            }
            sendJson(200, { data: [{ b64_json: b64 }] });
            return;
          }

          // OpenAI (default) — images/edits, multipart/form-data, Bearer auth.
          const key = (req.headers['x-openai-key'] as string | undefined)?.trim() || env.OPENAI_API_KEY;
          if (!key) {
            sendJson(500, { error: { message: 'OpenAI API キーが未設定です。右上の ⚙ から OpenAI キーを入力するか、.env.local に OPENAI_API_KEY を設定してください。' } });
            return;
          }
          const form = new FormData();
          list.forEach((dataUrl, i) => {
            const { mime, base64 } = decode(dataUrl);
            const ext = (mime.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
            const buf = Buffer.from(base64, 'base64');
            form.append('image[]', new Blob([buf], { type: mime }), `input_${i}.${ext}`);
          });
          form.append('prompt', prompt);
          // Default to gpt-image-1; the client sends the selected model (e.g. gpt-image-2).
          // NOTE: every gpt-image model requires OpenAI organization verification.
          form.append('model', String(body.model ?? 'gpt-image-1'));
          // gpt-image-1 supports only 1024x1024 / 1536x1024 / 1024x1536 — map the requested
          // aspect ratio to the nearest (K resolution isn't selectable on gpt-image-1).
          const arm = String(body.aspectRatio ?? '').match(/^(\d+):(\d+)$/);
          const arRatio = arm ? Number(arm[1]) / Number(arm[2]) : 0;
          const oaSize = body.size ? String(body.size)
            : arRatio > 1.2 ? '1536x1024'
              : (arRatio > 0 && arRatio < 0.83) ? '1024x1536'
                : arRatio === 0 ? '1536x1024' : '1024x1024';
          form.append('size', oaSize);
          form.append('n', '1');
          const r = await fetch('https://api.openai.com/v1/images/edits', {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}` },
            body: form,
          });
          // Response is already { data:[{b64_json}] } / { error } — pipe through verbatim
          // (incl. the 403 org-verification body so the UI can surface it).
          const text = await r.text();
          res.statusCode = r.status;
          res.setHeader('Content-Type', 'application/json');
          res.end(text);
        } catch (e) {
          sendJson(502, { error: { message: e instanceof Error ? e.message : String(e) } });
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
