/// <reference types="@cloudflare/workers-types" />
import { ADMIN_USERNAME, ADMIN_PASSWORD } from '../shared/admin-credentials';

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
}

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB per request

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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
  const filename = rawFilename.replace(/\.\.+/g, '').replace(/^\/+/, '');
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
