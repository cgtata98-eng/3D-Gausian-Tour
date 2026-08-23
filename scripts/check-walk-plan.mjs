/**
 * 「ウォークスルー案を取り込む」が本当にノード・エッジ・扉を起こすかを、
 * Debug 画面をそのまま操作して確かめる。
 *
 * 案 JSON は手で書いた小さなものを使う。確かめたいのは検出の精度ではなく
 * **取り込みの配管** ― 案が入ったら視点が作られ、ノードとエッジが並び、扉が
 * 浮かぶマーカーとして貼られるか。検出そのものは plan-walk.mjs 側の話。
 *
 *   node scripts/check-walk-plan.mjs [--base http://localhost:5173]
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const BASE = arg('base', 'http://localhost:5173');
const OUT = '.shots/walk-plan';
const SCENE_ID = 'walkplan-check';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`);
};

// ── 素材と案 ───────────────────────────────────────────────────────────────
const DUR = 6;
const run = (cmd, a) => new Promise((res, rej) => {
  const p = spawn(cmd, a, { stdio: ['ignore', 'ignore', 'pipe'] });
  let e = '';
  p.stderr.on('data', (d) => { e += d; });
  p.on('error', rej);
  p.on('close', (c) => (c === 0 ? res() : rej(new Error(`${cmd} exit ${c}\n${e.slice(-1200)}`))));
});
const video = path.join(OUT, 'tour.webm');
await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=teal:s=640x320:d=${DUR}:r=30`,
  '-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0', '-g', '15', '-pix_fmt', 'yuv420p', video]);

const PLAN = {
  source: 'tour.webm', fps: 30, duration: DUR, frames: DUR * 30, mode: 'even:4',
  nodes: [
    { index: 1, label: 'ポイント 1', t: 0.0 },
    { index: 2, label: 'ポイント 2', t: 1.5 },
    { index: 3, label: 'ポイント 3', t: 3.0 },
    { index: 4, label: 'ポイント 4', t: 4.5 },
    { index: 5, label: 'ポイント 5', t: 5.9 },
  ],
  edges: [],
  doors: [
    { index: 1, label: '扉 1', range: [1.2, 1.9], yaw: 120, pitch: 5, node: 2 },
    { index: 2, label: '扉 2', range: [4.2, 4.8], yaw: 250, pitch: -8, node: 4 },
  ],
  stills: [{ start: 0, end: 0.4, rest: 0.2 }],
  calmTimes: [0.2, 1.5, 3.0],
};
const planPath = path.join(OUT, 'video360-walk-plan.json');
await writeFile(planPath, JSON.stringify(PLAN, null, 2), 'utf8');

const assets = await serveAssets({ tour: video });

// ── 注入 ───────────────────────────────────────────────────────────────────
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--window-size=1600,1000', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('dialog', (d) => { void d.accept().catch(() => {}); });

console.log('=== 1. 検証データを注入 ===');
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate(async (payload) => {
  const { sceneId, origin, duration } = payload;
  const db = await new Promise((res, rej) => {
    const req = indexedDB.open('3droomtour', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('manifests')) d.createObjectStore('manifests');
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  const put = (store, key, value) => new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  await put('blobs', 'wp-tour', await (await fetch(`${origin}/tour`)).blob());
  await put('manifests', sceneId, {
    id: sceneId,
    name: 'ウォークスルー案の取り込み検証',
    settings: { render: { engine: 'playcanvas' } },
    viewerToolbar: { viewpoints: true },
    // 視点は 0 件から始める。案の取り込みが視点まで作ることを見る。
    plans: [{
      id: 'plan1', label: 'メイン', viewpoints: [],
      video360: {
        src: 'idb:wp-tour', duration, fps: 30, sourceName: 'tour.webm',
        nodes: [], edges: [],
      },
    }],
  });
  localStorage.setItem('3droomtour:projects:v1', JSON.stringify([{
    id: sceneId, name: 'ウォークスルー案の取り込み検証', type: 'realestate',
    viewMode: 'video360', createdAt: Date.now(),
  }]));
  localStorage.setItem('admin-auth-v1', JSON.stringify({ ts: Date.now(), role: 'admin' }));
}, { sceneId: SCENE_ID, origin: assets.origin, duration: DUR });
console.log('  注入完了');

// ── Debug 画面 ─────────────────────────────────────────────────────────────
console.log('\n=== 2. Debug 画面を開く ===');
await page.goto(`${BASE}/scene/${SCENE_ID}`, { waitUntil: 'networkidle2', timeout: 90000 });
await sleep(2000);
const gated = await page.$$('input[type=password]');
if (gated.length) {
  const ins = await page.$$('input');
  await ins[0].type('takyu');
  await ins[1].type('1qaz1833');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /ログイン/.test(x.textContent || ''));
    b?.click();
  });
  await sleep(2500);
}

// Debug は「プロジェクト」タブで開く。360°動画は「プラン」タブの中。
const tabbed = await page.evaluate(() => {
  const el = [...document.querySelectorAll('button, [role=tab]')]
    .find((x) => (x.textContent || '').trim().startsWith('プラン'));
  if (!el) return 'not-found';
  el.click();
  return 'clicked';
});
check('プランタブに切り替わる', tabbed === 'clicked', tabbed);
await sleep(1200);

// 「360°動画ウォークスルー」の節を開く
// 節の見出しを実際にクリックする。祖先へ順に click を投げると外側の別の節まで
// 開いてしまうので、見出しの座標を取って 1 回だけ押す。
const headerBox = await page.evaluate(() => {
  const leaf = [...document.querySelectorAll('*')]
    .find((x) => x.children.length === 0 && (x.textContent || '').trim() === '360°動画ウォークスルー');
  if (!leaf) return null;
  const r = (leaf.closest('button, summary, [role=button]') ?? leaf.parentElement ?? leaf).getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
const opened = headerBox ? 'clicked' : 'not-found';
if (headerBox) await page.mouse.click(headerBox.x, headerBox.y);
await sleep(1200);
check('360°動画セクションが開く', opened === 'clicked', opened);

const beforeCounts = await page.evaluate(() => document.body.innerText.match(/ノード（(\d+)）/)?.[1] ?? 'なし');
check('取り込み前はノード 0', beforeCounts === '0', `ノード=${beforeCounts}`);
await page.screenshot({ path: `${OUT}/01-before.png` });

// ── 取り込み ───────────────────────────────────────────────────────────────
console.log('\n=== 3. 案 JSON を読ませる ===');
const inputs = await page.$$('input[type=file]');
let picked = false;
for (const inp of inputs) {
  // FilePick は <button> と隠し <input> の兄弟。label で包まれていない。
  const label = await inp.evaluate((el) => (el.closest('label')?.textContent
    ?? el.previousElementSibling?.textContent ?? '').trim());
  if (label.includes('案 JSON を読む')) {
    await inp.uploadFile(path.resolve(planPath));
    picked = true;
    break;
  }
}
check('「案 JSON を読む」がある', picked);
await sleep(2500);

const after = await page.evaluate(() => {
  const t = document.body.innerText;
  return {
    nodes: t.match(/ノード（(\d+)）/)?.[1] ?? '?',
    edges: t.match(/エッジ（(\d+)）/)?.[1] ?? '?',
    hasPoint5: t.includes('ポイント 5'),
  };
});
check('ノードが 5 個になる', after.nodes === '5', `ノード=${after.nodes}`);
// 移動エッジ 4 本 + 扉 2 個
check('エッジが 6 本 (移動 4 + 扉 2)', after.edges === '6', `エッジ=${after.edges}`);
check('視点が作られる (ポイント 5 まで)', after.hasPoint5);
await page.screenshot({ path: `${OUT}/02-after.png` });

// ── 保存されたか ───────────────────────────────────────────────────────────
console.log('\n=== 4. 中身を確かめる ===');
const stored = await page.evaluate(async (sceneId) => {
  const db = await new Promise((res) => {
    const r = indexedDB.open('3droomtour', 1);
    r.onsuccess = () => res(r.result);
  });
  const m = await new Promise((res) => {
    const tx = db.transaction('manifests', 'readonly');
    const rq = tx.objectStore('manifests').get(sceneId);
    rq.onsuccess = () => res(rq.result);
  });
  const p = m?.plans?.[0];
  const doors = (p?.video360?.edges ?? []).filter((e) => e.kind === 'door');
  return {
    viewpoints: p?.viewpoints?.length ?? 0,
    nodes: p?.video360?.nodes?.length ?? 0,
    doors: doors.map((d) => ({ id: d.id, label: d.label, yaw: d.doorYaw, pitch: d.doorPitch, range: d.range, from: d.from })),
    calm: p?.video360?.calmTimes?.length ?? 0,
  };
}, SCENE_ID);
check('視点が 5 件できている', stored.viewpoints === 5, `視点=${stored.viewpoints}`);
check('扉の向きが保存されている', stored.doors.length === 2
  && stored.doors[0].yaw === 120 && stored.doors[1].yaw === 250,
  JSON.stringify(stored.doors.map((d) => `${d.id} yaw${d.yaw} pitch${d.pitch}`)));
check('扉が正しいノードに付く', stored.doors[0]?.from?.endsWith('2') === true, `from=${stored.doors[0]?.from}`);
check('扉のラベルが引き継がれる',
  stored.doors[0]?.label === '扉 1' && stored.doors[1]?.label === '扉 2',
  stored.doors.map((d) => d.label).join(' / '));
check('扉の区間が入る',
  stored.doors[0]?.range?.[0] === 1.2 && stored.doors[0]?.range?.[1] === 1.9,
  JSON.stringify(stored.doors[0]?.range));
check('calmTimes も取り込まれる', stored.calm === 3, `calm=${stored.calm}`);

const bad = logs.filter((l) => !/favicon|ERR_|Failed to load resource/.test(l));
if (bad.length) { console.log('\n=== コンソールエラー ==='); bad.slice(0, 8).forEach((l) => console.log(`  ${l}`)); }
const failed = checks.filter((c) => !c.pass);
console.log(`\n${failed.length === 0 ? '✅ 全部通った' : `❌ ${failed.length} / ${checks.length} 失敗`}`);
failed.forEach((f) => console.log(`  - ${f.name}  ${f.detail}`));
console.log(`スクリーンショット: ${OUT}/`);
await browser.close();
assets.close();
process.exit(failed.length === 0 ? 0 : 1);

async function serveAssets(files) {
  const { createServer } = await import('node:http');
  const { createReadStream } = await import('node:fs');
  const { stat } = await import('node:fs/promises');
  const known = {};
  for (const [name, p] of Object.entries(files)) known[name] = { path: p, size: (await stat(p)).size };
  const server = createServer((req, res) => {
    const name = (req.url || '').replace(/^\//, '').split('?')[0];
    const f = known[name];
    if (!f) { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      'Content-Type': 'video/webm', 'Content-Length': f.size,
      'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes',
    });
    createReadStream(f.path).pipe(res);
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
