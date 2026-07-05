import { ADMIN_USERNAME, ADMIN_PASSWORD, SHARE_USERNAME, SHARE_PASSWORD } from './admin-credentials';

/**
 * AI image-generation proxy core — SHARED between the production Cloudflare
 * Worker (`src/worker/index.ts`) and the dev-only Vite middleware
 * (`vite.config.ts` `aiImageProxy`). Both call this exact function so the
 * guards (same-origin, key/auth requirement, body-size cap, model-id charset)
 * and error shapes can never drift apart again — previously the dev proxy had
 * none of the guards, so requests passed in dev and failed in production.
 *
 * The browser POSTs JSON `{ provider, model, images: dataUrl[], prompt,
 * aspectRatio?, imageSize? }` and the per-request API key as `X-OpenAI-Key` /
 * `X-Gemini-Key` (entered via the ⚙ settings UI). We forward to OpenAI
 * images/edits (Bearer) or Gemini generateContent (`x-goog-api-key`) and
 * normalize both to `{ data:[{ b64_json }] }`.
 *
 * Key handling: BYO header key first; else the server-side key from
 * `serverKeys` (Worker: `wrangler secret`, dev: `.env.local`) — but ONLY when
 * the request passes the site Basic Auth, so a keyless + unauthenticated
 * caller can't spend the embedded key. The prepaid cap on that key is the real
 * protection; the bundled password is casual deterrence.
 */

export interface AiEditServerKeys {
  gemini?: string;
  openai?: string;
}

type AiBody = {
  image?: string; images?: string[]; prompt?: string;
  provider?: string; model?: string; size?: string;
  aspectRatio?: string; imageSize?: string;
};

export async function handleAiEdit(request: Request, serverKeys: AiEditServerKeys): Promise<Response> {
  const json = (status: number, obj: unknown) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });

  // Derive the origin-check host from the request itself — a separate url param
  // would be a second source of truth the same-origin guard could disagree with.
  const url = new URL(request.url);

  if (request.method !== 'POST') return json(405, { error: { message: 'Method Not Allowed' } });

  // ── Pre-body guards (cheap, before buffering/parsing the body) ──
  // 1. Same-origin only — this endpoint is for the authoring UI served from this host.
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
  //    server key. Accept the personal admin OR the restricted "share" login here
  //    (publish/R2 routes stay admin-only, so the share role can't touch your data).
  const oaKey = request.headers.get('x-openai-key')?.trim();
  const gemKey = request.headers.get('x-gemini-key')?.trim();
  const authVal = request.headers.get('Authorization') ?? '';
  const isAuthed = authVal === 'Basic ' + btoa(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`)
    || authVal === 'Basic ' + btoa(`${SHARE_USERNAME}:${SHARE_PASSWORD}`);
  if (!oaKey && !gemKey && !isAuthed) {
    return json(401, { error: { message: 'API キーが未設定です。右上の ⚙ からキーを入力してください。' } });
  }
  // 3. Cap the declared body size.
  const MAX_BODY = 40 * 1024 * 1024; // 40 MB
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY) {
    return json(413, { error: { message: 'Payload too large' } });
  }

  let body: AiBody;
  try {
    body = await request.json() as AiBody;
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
  const toBytes = (base64: string): Uint8Array<ArrayBuffer> => {
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
      const key = gemKey || (isAuthed ? serverKeys.gemini?.trim() : undefined);
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
      // Optional sizing/shape. `imageConfig.imageSize` is a Gemini 3.x feature —
      // 2.5-era image models reject the field with a 400, so drop it for them
      // (aspectRatio is fine on 2.5+). 4K is only reliable on the Pro model —
      // clamp others to 2K.
      const aspectRatio = typeof body.aspectRatio === 'string' ? body.aspectRatio : '';
      let imageSize = typeof body.imageSize === 'string' ? body.imageSize : '';
      if (!model.startsWith('gemini-3')) imageSize = '';
      else if (imageSize === '4K' && model !== 'gemini-3-pro-image') imageSize = '2K';
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
    const key = oaKey || (isAuthed ? serverKeys.openai?.trim() : undefined);
    if (!key) return json(401, { error: { message: 'OpenAI API キーが未設定です。右上の ⚙ から OpenAI キーを入力してください。' } });
    const form = new FormData();
    list.forEach((dataUrl, i) => {
      const { mime, base64 } = parseDataUrl(dataUrl);
      const ext = (mime.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
      form.append('image[]', new Blob([toBytes(base64)], { type: mime }), `input_${i}.${ext}`);
    });
    form.append('prompt', prompt);
    // Default to gpt-image-1; the client sends the selected model (e.g. gpt-image-2).
    // NOTE: every gpt-image model requires OpenAI organization verification.
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
    // Already { data:[{b64_json}] } / { error } — pass through verbatim
    // (incl. the 403 org-verification body so the UI can surface it).
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
