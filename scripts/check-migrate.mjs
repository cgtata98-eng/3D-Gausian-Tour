/**
 * Cross-origin migration check.
 *
 * The bug this catches is invisible to `tsc` and to a screenshot: the transfer
 * either moves the IndexedDB blobs across an origin boundary or it silently
 * moves nothing, and both look identical until you open the project list on
 * the new host and the splats are missing.
 *
 * Two `vite preview` servers stand in for the two hosts — different ports are
 * different origins, so the browser gives them separate storage jars, exactly
 * like workers.dev vs cg-rooms.com.
 *
 *   npm run build
 *   node scripts/check-migrate.mjs
 *
 * Exits 1 on any failed assertion.
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(existsSync);

const SOURCE = 'http://localhost:4173';   // the origin we migrate away from
const RECEIVER = 'http://localhost:5173'; // the origin we migrate to

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/* ── servers ─────────────────────────────────────────────────────────────── */

function serve(port) {
  const p = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite', 'preview', '--port', String(port), '--strictPort'],
    { stdio: 'ignore', shell: process.platform === 'win32' },
  );
  return p;
}

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server did not start: ${url}`);
}

/* ── page-side storage helpers (run inside the browser) ──────────────────── */

const IDB_HELPERS = `
  const openDb = () => new Promise((res, rej) => {
    const req = indexedDB.open('3droomtour', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('manifests')) db.createObjectStore('manifests');
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  const put = (store, key, value) => openDb().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const r = tx.objectStore(store).put(value, key);
    r.onsuccess = () => res(); r.onerror = () => rej(r.error);
  }));
  const dump = (store) => openDb().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const s = tx.objectStore(store);
    const kr = s.getAllKeys(); const vr = s.getAll();
    tx.oncomplete = () => res(kr.result.map((k, i) => [k, vr.result[i]]));
    tx.onerror = () => rej(tx.error);
  }));
`;

const AUTH_RECORD = JSON.stringify({ ts: Date.now(), role: 'admin' });

/* ── run ─────────────────────────────────────────────────────────────────── */

const servers = [serve(4173), serve(5173)];
let browser;

try {
  await Promise.all([waitForServer(SOURCE), waitForServer(RECEIVER)]);
  console.log('servers up\n');

  browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-popup-blocking'],
  });

  /* 1. Seed the source origin with projects, manifests and blobs. */
  const src = await browser.newPage();
  await src.goto(SOURCE, { waitUntil: 'domcontentloaded' });
  await src.evaluate(`(async () => {
    ${IDB_HELPERS}
    localStorage.setItem('admin-auth-v1', ${JSON.stringify(AUTH_RECORD)});
    localStorage.setItem('3droomtour:projects:v1', JSON.stringify([
      { id: 'alpha', name: '旧サイトの物件A', type: 'gs', viewMode: 'walk', createdAt: 1 },
      { id: 'bravo', name: '旧サイトの物件B', type: 'gs', viewMode: 'walk', createdAt: 2 },
      { id: 'shared', name: '旧サイト版タイトル', type: 'gs', viewMode: 'walk', createdAt: 3 },
    ]));
    localStorage.setItem('3droomtour:qualityMode', 'HIGH');
    localStorage.setItem('3dcggs:openai-api-key', 'sk-test-source');
    await put('manifests', 'alpha', { sceneId: 'alpha', plans: [{ id: 'p1' }] });
    await put('manifests', 'bravo', { sceneId: 'bravo', plans: [{ id: 'p1' }] });
    await put('blobs', 'splat:alpha:p1:sog/meta.json', new Blob(['x'.repeat(2048)]));
    await put('blobs', 'splat:bravo:p1:sog/meta.json', new Blob(['y'.repeat(4096)]));
    await put('blobs', 'clip:existing', new Blob(['z'.repeat(1024)]));
  })()`);

  /* 2. Seed the receiver with a colliding project + blob, so the skip path is
        exercised rather than an empty-store happy path. */
  const rcv = await browser.newPage();
  await rcv.goto(RECEIVER, { waitUntil: 'domcontentloaded' });
  await rcv.evaluate(`(async () => {
    ${IDB_HELPERS}
    localStorage.setItem('admin-auth-v1', ${JSON.stringify(AUTH_RECORD)});
    localStorage.setItem('3droomtour:projects:v1', JSON.stringify([
      { id: 'shared', name: '新サイト版タイトル', type: 'gs', viewMode: 'walk', createdAt: 9 },
    ]));
    await put('blobs', 'clip:existing', new Blob(['NEW']));
  })()`);

  /* 3. Run the migration through the real UI. */
  await rcv.goto(`${RECEIVER}/migrate`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 600));

  const onMigrateScreen = await rcv.evaluate(() =>
    document.body.innerText.includes('プロジェクトデータの移行'));
  check('receiver reaches /migrate past AuthGate', onMigrateScreen);

  await rcv.evaluate((origin) => {
    const input = document.querySelector('input[type="text"]');
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, origin);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, SOURCE);

  const popupPromise = new Promise((resolve) => {
    browser.once('targetcreated', (t) => resolve(t));
  });

  await rcv.evaluate(() => {
    [...document.querySelectorAll('button')]
      .find((b) => /移行を開始/.test(b.textContent || ''))?.click();
  });

  const popupTarget = await Promise.race([
    popupPromise,
    new Promise((r) => setTimeout(() => r(null), 8000)),
  ]);
  check('source popup opens on the old origin', !!popupTarget,
    popupTarget ? popupTarget.url() : 'no popup target within 8s');

  /* 4. Wait for the receiver to report a result. */
  let finished = false;
  for (let i = 0; i < 60; i++) {
    finished = await rcv.evaluate(() => document.body.innerText.includes('取り込み結果'));
    if (finished) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const receiverText = await rcv.evaluate(() => document.body.innerText);
  check('migration completes', finished, finished ? '' : receiverText.slice(0, 300).replace(/\n/g, ' | '));

  /* 5. Verify what actually landed in the receiver's storage. */
  const state = await rcv.evaluate(`(async () => {
    ${IDB_HELPERS}
    return {
      projects: JSON.parse(localStorage.getItem('3droomtour:projects:v1') || '[]'),
      quality: localStorage.getItem('3droomtour:qualityMode'),
      apiKey: localStorage.getItem('3dcggs:openai-api-key'),
      manifests: (await dump('manifests')).map(([k]) => k),
      blobs: (await dump('blobs')).map(([k, v]) => [k, v.size]),
    };
  })()`);

  const ids = state.projects.map((p) => p.id).sort();
  check('projects merged across origins', JSON.stringify(ids) === JSON.stringify(['alpha', 'bravo', 'shared']),
    ids.join(','));

  const shared = state.projects.find((p) => p.id === 'shared');
  check('colliding project keeps the receiver copy (overwrite off)',
    shared?.name === '新サイト版タイトル', shared?.name);

  check('scene manifests copied', state.manifests.sort().join(',') === 'alpha,bravo',
    state.manifests.join(','));

  const blobMap = Object.fromEntries(state.blobs);
  check('splat blobs copied with their bytes',
    blobMap['splat:alpha:p1:sog/meta.json'] === 2048 && blobMap['splat:bravo:p1:sog/meta.json'] === 4096,
    JSON.stringify(blobMap));

  check('colliding blob is not clobbered (overwrite off)',
    blobMap['clip:existing'] === 3, String(blobMap['clip:existing']));

  check('scalar preference copied when absent', state.quality === 'HIGH', String(state.quality));
  check('API key copied when opted in', state.apiKey === 'sk-test-source', String(state.apiKey));
} finally {
  if (browser) await browser.close();
  for (const s of servers) s.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
