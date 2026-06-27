/// <reference types="@cloudflare/workers-types" />
import { ADMIN_USERNAME, ADMIN_PASSWORD, SHARE_USERNAME, SHARE_PASSWORD } from '../shared/admin-credentials';

/**
 * Cloudflare Worker entry. Routes:
 *   - `PUT  /api/publish/<sceneId>/<filename>`    upload to R2
 *   - `DELETE /api/publish/<sceneId>/<filename>`  remove from R2
 *   - everything else → static assets (Vite build under ./dist)
 *
 * Auth: Basic Auth header. Credentials match the frontend AuthGate. Casual
 * deterrence, not real security — see `src/shared/admin-credentials.ts`.
 */

interface Env {
  ASSETS: Fetcher;
  BUCKET: R2Bucket;
  /** Optional server-side prepaid API keys (set via `wrangler secret put GEMINI_API_KEY`).
   *  Used ONLY as a fallback when the browser sends no X-*-Key header AND the request
   *  passes the site Basic Auth — lets you share a spend-capped key without exposing it
   *  to the recipient. The prepaid cap is the real protection; the password is bundled
   *  (casual deterrence). */
  GEMINI_API_KEY?: string;
  OPENAI_API_KEY?: string;
}

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB per request

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/ai/config') {
      // Which providers have a server-side (embedded) key. Booleans only — no secret.
      return jsonResponse({ gemini: !!env.GEMINI_API_KEY, openai: !!env.OPENAI_API_KEY });
    }
    if (url.pathname === '/api/ai/edit') {
      return handleAiEdit(request, url, env);
    }
    if (url.pathname.startsWith('/api/publish/')) {
      return handlePublish(request, env, url);
    }
    if (url.pathname === '/api/debug/list') {
      return handleListDebug(request, env);
    }
    // Anything else: serve from the static-asset bundle. The asset handler
    // honours `not_found_handling: "single-page-application"` so SPA routes
    // (e.g. `/viewer/<id>`) still resolve to index.html.
    return env.ASSETS.fetch(request);
  },
};

/**
 * AI image-generation proxy — the production mirror of the dev-only Vite
 * `aiImageProxy` middleware (see vite.config.ts). The browser POSTs JSON
 * `{ provider, model, images: dataUrl[], prompt, aspectRatio?, imageSize? }`
 * and the per-request API key as `X-OpenAI-Key` / `X-Gemini-Key` (entered via the
 * ⚙ settings UI). The Worker forwards to OpenAI images/edits (Bearer) or Gemini
 * generateContent (`x-goog-api-key`) and normalizes both to `{ data:[{ b64_json }] }`.
 *
 * Key handling: HEADER ONLY — the Worker holds no server-side API key, so the caller
 * always pays with their own key. Pre-body guards (same-origin, key header required,
 * size cap) stop the public route from being a no-key DoS / open relay; pair with a
 * Cloudflare rate-limit rule on /api/ai/edit for volumetric abuse. The customer viewer
 * never calls this; only the authoring UI does.
 */
async function handleAiEdit(request: Request, url: URL, env: Env): Promise<Response> {
  const json = (status: number, obj: unknown) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });

  if (request.method !== 'POST') return json(405, { error: { message: 'Method Not Allowed' } });

  // ── Pre-body guards (cheap, before buffering/parsing the body) ──
  // 1. Same-origin only — this endpoint is for the authoring UI served from this Worker.
  //    Blocks cross-origin browser abuse. (Non-browser clients can omit Origin, but the
  //    key-header + size cap below still gate them; add a CF rate-limit rule for volume.)
  const originRef = request.headers.get('Origin') ?? request.headers.get('Referer');
  if (originRef) {
    let sameOrigin = false;
    try { sameOrigin = new URL(originRef).host === url.host; } catch { sameOrigin = false; }
    if (!sameOrigin) return json(403, { error: { message: 'Forbidden origin' } });
  }
  // 2. Either a BYO key header, or pass the site Basic Auth (to use the embedded server
  //    key). A keyless + unauthenticated caller can't force a body parse / use the
  //    server key. NOTE: the password is bundled (casual deterrence); the prepaid spend
  //    cap on the embedded key is the real protection against abuse.
  const oaKey = request.headers.get('x-openai-key')?.trim();
  const gemKey = request.headers.get('x-gemini-key')?.trim();
  // Accept the personal admin OR the restricted "share" login for using the embedded key.
  // (Publish/R2 routes stay admin-only, so the share role can't touch your data.)
  const authVal = request.headers.get('Authorization') ?? '';
  const isAuthed = authVal === 'Basic ' + btoa(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`)
    || authVal === 'Basic ' + btoa(`${SHARE_USERNAME}:${SHARE_PASSWORD}`);
  if (!oaKey && !gemKey && !isAuthed) {
    return json(401, { error: { message: 'API キーが未設定です。右上の ⚙ からキーを入力してください。' } });
  }
  // 3. Cap the declared body size (handlePublish caps too; this route previously had none).
  const MAX_BODY = 40 * 1024 * 1024; // 40 MB
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY) {
    return json(413, { error: { message: 'Payload too large' } });
  }

  type AiBody = {
    image?: string; images?: string[]; prompt?: string;
    provider?: string; model?: string; size?: string;
    aspectRatio?: string; imageSize?: string;
  };
  let body: AiBody;
  try {
    body = await request.json<AiBody>();
  } catch {
    return json(400, { error: { message: 'Invalid JSON' } });
  }

  const list = (Array.isArray(body.images) && body.images.length > 0)
    ? body.images.map((x) => String(x))
    : (body.image ? [String(body.image)] : []);
  if (list.length === 0) return json(400, { error: { message: 'Missing image(s)' } });
  const prompt = String(body.prompt ?? '');
  const provider = body.provider === 'gemini' ? 'gemini' : 'openai';
  // The model id is interpolated into the Gemini request URL — restrict its charset
  // so a crafted value can't manipulate the path (this endpoint is publicly reachable).
  if (body.model !== undefined && !/^[a-zA-Z0-9.-]+$/.test(String(body.model))) {
    return json(400, { error: { message: 'Invalid model id' } });
  }

  // Parse a `data:<mime>;base64,<data>` URL (no decode). Gemini consumes base64 directly;
  // only the OpenAI multipart path needs raw bytes, decoded lazily via toBytes().
  const parseDataUrl = (dataUrl: string): { mime: string; base64: string } => {
    const m = dataUrl.match(/^data:([a-zA-Z0-9.+/-]+);base64,(.+)$/);
    return m ? { mime: m[1], base64: m[2] } : { mime: 'image/png', base64: dataUrl };
  };
  const toBytes = (base64: string): Uint8Array => {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };

  // Abort a hung upstream call so it doesn't hold billed Worker duration indefinitely.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    if (provider === 'gemini') {
      // BYO header key, else the embedded server key (only for site-authed requests).
      const key = gemKey || (isAuthed ? env.GEMINI_API_KEY?.trim() : undefined);
      if (!key) return json(401, { error: { message: 'Gemini API キーが未設定です。右上の ⚙ から Gemini キーを入力してください。' } });
      const model = String(body.model ?? 'gemini-3.1-flash-image');
      // gemini-2.5-flash-image accepts only 3 input images total; clamp for safety.
      const imgs = model === 'gemini-2.5-flash-image' ? list.slice(0, 3) : list;
      const parts = [
        { text: prompt },
        ...imgs.map((d) => {
          const { mime, base64 } = parseDataUrl(d);
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
        signal: ctrl.signal,
      });
      const j = await r.json() as {
        candidates?: { content?: { parts?: { inlineData?: { data?: string }; inline_data?: { data?: string } }[] }; finishReason?: string }[];
        promptFeedback?: { blockReason?: string };
        error?: { message?: string };
      };
      if (!r.ok) return json(r.status, j?.error ? j : { error: { message: JSON.stringify(j) } });
      const rparts = j?.candidates?.[0]?.content?.parts ?? [];
      const imgPart = rparts.find((p) => p.inlineData ?? p.inline_data);
      const b64 = imgPart?.inlineData?.data ?? imgPart?.inline_data?.data;
      if (!b64) {
        const reason = j?.candidates?.[0]?.finishReason ?? j?.promptFeedback?.blockReason ?? 'unknown';
        return json(422, { error: { message: `Gemini が画像を返しませんでした（safety block / finishReason: ${reason}）` } });
      }
      return json(200, { data: [{ b64_json: b64 }] });
    }

    // OpenAI (default) — images/edits, multipart/form-data, Bearer auth.
    const key = oaKey || (isAuthed ? env.OPENAI_API_KEY?.trim() : undefined);
    if (!key) return json(401, { error: { message: 'OpenAI API キーが未設定です。右上の ⚙ から OpenAI キーを入力してください。' } });
    const form = new FormData();
    list.forEach((dataUrl, i) => {
      const { mime, base64 } = parseDataUrl(dataUrl);
      const ext = (mime.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
      form.append('image[]', new Blob([toBytes(base64)], { type: mime }), `input_${i}.${ext}`);
    });
    form.append('prompt', prompt);
    form.append('model', String(body.model ?? 'gpt-image-1'));
    // gpt-image-1 supports only 1024x1024 / 1536x1024 / 1024x1536 — map aspect to nearest.
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
      signal: ctrl.signal,
    });
    // Already { data:[{b64_json}] } / { error } — pass through verbatim.
    const text = await r.text();
    return new Response(text, {
      status: r.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === 'AbortError') {
      return json(504, { error: { message: '生成がタイムアウトしました（90秒）。もう一度お試しください。' } });
    }
    return json(502, { error: { message: e instanceof Error ? e.message : String(e) } });
  } finally {
    clearTimeout(timer);
  }
}

async function handlePublish(request: Request, env: Env, url: URL): Promise<Response> {
  // ── Auth ──
  const auth = request.headers.get('Authorization') ?? '';
  const expected = 'Basic ' + btoa(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`);
  if (auth !== expected) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="cg-gaussian admin"' },
    });
  }

  // ── Path parsing: /api/publish/<sceneId>/<filename...> ──
  const match = url.pathname.match(/^\/api\/publish\/([^/]+)\/(.+)$/);
  if (!match) return new Response('Bad Request', { status: 400 });
  const [, rawSceneId, rawFilename] = match;

  const sceneId = rawSceneId.replace(/[^a-zA-Z0-9_-]/g, '');
  // The client `encodeURIComponent`s the whole filename, so multibyte chars and
  // path slashes both arrive percent-encoded. Decode so R2 keys are stored
  // with their original UTF-8 (e.g. `_name_京都ホテル/.placeholder`).
  let decodedFilename: string;
  try { decodedFilename = decodeURIComponent(rawFilename); }
  catch { decodedFilename = rawFilename; }
  const filename = decodedFilename.replace(/\.\.+/g, '').replace(/^\/+/, '');
  if (!sceneId || !filename) return new Response('Bad path', { status: 400 });
  const r2Key = `${sceneId}/${filename}`;
  const action = url.searchParams.get('action');

  // ── Multipart upload (for files larger than the Worker body limit) ──
  // Flow: client POSTs ?action=create → uploadId, PUTs parts as
  // ?action=part&uploadId=X&part=N (each ≤ ~50MB), POSTs ?action=complete with
  // the parts list. Mirrors S3 multipart conventions; R2's binding handles it
  // natively.
  if (action === 'create' && request.method === 'POST') {
    const contentType = url.searchParams.get('contentType') ?? 'application/octet-stream';
    const upload = await env.BUCKET.createMultipartUpload(r2Key, { httpMetadata: { contentType } });
    return jsonResponse({ uploadId: upload.uploadId });
  }

  if (action === 'part' && (request.method === 'PUT' || request.method === 'POST')) {
    const uploadId = url.searchParams.get('uploadId');
    const partNum = Number(url.searchParams.get('part'));
    if (!uploadId || !partNum || partNum < 1) return new Response('Bad part params', { status: 400 });
    if (!request.body) return new Response('Empty body', { status: 400 });
    const upload = env.BUCKET.resumeMultipartUpload(r2Key, uploadId);
    const part = await upload.uploadPart(partNum, request.body);
    return jsonResponse({ partNumber: part.partNumber, etag: part.etag });
  }

  if (action === 'complete' && request.method === 'POST') {
    const uploadId = url.searchParams.get('uploadId');
    if (!uploadId) return new Response('Missing uploadId', { status: 400 });
    const body = await request.json<{ parts: Array<{ partNumber: number; etag: string }> }>();
    if (!Array.isArray(body?.parts)) return new Response('Bad parts list', { status: 400 });
    const upload = env.BUCKET.resumeMultipartUpload(r2Key, uploadId);
    await upload.complete(body.parts);
    return jsonResponse({ ok: true, key: r2Key });
  }

  if (action === 'abort' && request.method === 'POST') {
    const uploadId = url.searchParams.get('uploadId');
    if (!uploadId) return new Response('Missing uploadId', { status: 400 });
    const upload = env.BUCKET.resumeMultipartUpload(r2Key, uploadId);
    await upload.abort();
    return jsonResponse({ ok: true });
  }

  // ── Single-shot upload (under the body limit, simpler) ──
  if (request.method === 'PUT' || request.method === 'POST') {
    const contentLength = Number(request.headers.get('Content-Length') ?? 0);
    if (contentLength > MAX_UPLOAD_BYTES) {
      return new Response('Payload too large', { status: 413 });
    }
    const contentType = request.headers.get('Content-Type') ?? 'application/octet-stream';
    if (!request.body) return new Response('Empty body', { status: 400 });
    await env.BUCKET.put(r2Key, request.body, { httpMetadata: { contentType } });
    return jsonResponse({ ok: true, key: r2Key });
  }

  if (request.method === 'DELETE') {
    await env.BUCKET.delete(r2Key);
    return jsonResponse({ ok: true, deleted: r2Key });
  }

  return new Response('Method Not Allowed', { status: 405 });
}

/** Lists keys in the bound R2 bucket. Auth-gated debug helper to verify the
 *  Worker really is talking to the bucket the public R2 URL serves. */
async function handleListDebug(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get('Authorization') ?? '';
  const expected = 'Basic ' + btoa(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`);
  if (auth !== expected) return new Response('Unauthorized', { status: 401 });
  const list = await env.BUCKET.list({ limit: 30 });
  return jsonResponse({
    bucket_keys: list.objects.map((o) => ({ key: o.key, size: o.size })),
    truncated: list.truncated,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Same-origin only, but explicit so the dev server (different port)
      // can also call this in the future.
      'Cache-Control': 'no-store',
    },
  });
}
