/**
 * スマホでの操作まわりを実機に近い形で確かめる。
 *
 * 守っているもの:
 *   1. ツール (レール) が **左** にある
 *   2. 畳んでも戻すハンドルが画面の中にあって押せる ― 一度閉じたら二度と出てこない、
 *      という状態にならない
 *   3. ピンチで画角 (FOV) が変わる。指を広げたら寄る、縮めたら引く
 *   4. ピンチ中に画が回らない (2 本目の指を見回しとして拾わない)
 *
 * マルチタッチは puppeteer の touchscreen では出せないので CDP を直接叩く。
 *
 *   node scripts/check-mobile-tools.mjs [--base http://localhost:5173]
 */
import { mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const BASE = arg('base', 'http://localhost:5173');
const OUT = '.shots/mobile-tools';
const SCENE_ID = 'mobiletools-check';
const VW = 390;
const VH = 844;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`);
};

// 素材 — 単色の 360 動画。確かめたいのは操作であって絵ではない。
const run = (cmd, a) => new Promise((res, rej) => {
  const p = spawn(cmd, a, { stdio: ['ignore', 'ignore', 'pipe'] });
  let e = '';
  p.stderr.on('data', (d) => { e += d; });
  p.on('error', rej);
  p.on('close', (c) => (c === 0 ? res() : rej(new Error(`${cmd} exit ${c}\n${e.slice(-1000)}`))));
});
const video = path.join(OUT, 'tour.webm');
await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=slategray:s=640x320:d=6:r=30',
  '-c:v', 'libvpx-vp9', '-crf', '36', '-b:v', '0', '-g', '15', '-pix_fmt', 'yuv420p', video]);
const assets = await serveAssets({ tour: video });

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio',
    `--window-size=${VW},${VH}`],
});
const page = await browser.newPage();
await page.emulate({
  viewport: { width: VW, height: VH, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const logs = [];
page.on('pageerror', (e) => logs.push(e.message.slice(0, 160)));

console.log('=== 1. 検証データを注入 ===');
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate(async (payload) => {
  const { sceneId, origin } = payload;
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
  await put('blobs', 'mt-tour', await (await fetch(`${origin}/tour`)).blob());
  await put('manifests', sceneId, {
    id: sceneId,
    name: 'スマホ操作の検証',
    settings: { render: { engine: 'playcanvas' } },
    // レールに何か出る組み合わせにする。`quality` は 3DGS 専用、`viewpoints` は
    // レールではなくシーンバー、`fullscreen` はタッチ端末では出ない。
    viewerToolbar: { viewpoints: true, type: true, pins: true },
    plans: [{
      id: 'plan1', label: 'メイン',
      startViewpointId: 'p1',
      viewpoints: [{ id: 'p1', label: '入口', position: [0, 1.6, 0], target: [0, 1.6, -1], fov: 75 }],
      video360: {
        src: 'idb:mt-tour', duration: 6, fps: 30, sourceName: 'tour.webm',
        nodes: [{ viewpointId: 'p1', t: 1 }], edges: [],
      },
    }],
  });
  localStorage.setItem('3droomtour:projects:v1', JSON.stringify([{
    id: sceneId, name: 'スマホ操作の検証', type: 'realestate', viewMode: 'video360', createdAt: Date.now(),
  }]));
  localStorage.setItem('admin-auth-v1', JSON.stringify({ ts: Date.now(), role: 'admin' }));
}, { sceneId: SCENE_ID, origin: assets.origin });

console.log('\n=== 2. ビューアを開く ===');
await page.goto(`${BASE}/viewer/${SCENE_ID}`, { waitUntil: 'networkidle2', timeout: 90000 });
await sleep(3000);
await page.waitForFunction(() => !!window.__sceneManager?.getVideo360?.(), { timeout: 60000 }).catch(() => {});
await sleep(1500);

// サイドバーが畳まれていたら開く
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => / を表示$/.test(x.getAttribute('title') || ''));
  b?.click();
});
await sleep(800);
await page.screenshot({ path: `${OUT}/01-open.png` });

// ── 3. レールは左 ──────────────────────────────────────────────────────────
console.log('\n=== 3. ツールの位置 ===');
const rail = await page.evaluate(() => {
  const el = document.querySelector('.ds-rail');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) };
});
check('レールが出ている', !!rail, JSON.stringify(rail));
check('レールが左にある', !!rail && rail.left < VW / 2, rail ? `left=${rail.left} (画面幅 ${VW})` : '');

const joy = await page.evaluate(() => {
  const el = [...document.querySelectorAll('div')].find((d) => {
    const s = getComputedStyle(d);
    return s.position === 'fixed' && s.zIndex === '50';
  });
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: Math.round(r.left), top: Math.round(r.top) };
});
check('レールがジョイスティックに被らない',
  !rail || !joy || rail.bottom <= joy.top, `レール下端=${rail?.bottom} ジョイスティック上端=${joy?.top ?? '無し'}`);

// ── 4. 畳んでも戻せる ──────────────────────────────────────────────────────
console.log('\n=== 4. 畳んでから戻す ===');
const folded = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('title') || '').startsWith('サイドバーを閉じる'));
  if (!b) return 'not-found';
  b.click();
  return 'clicked';
});
check('サイドバーを畳める', folded === 'clicked', folded);
await sleep(700);
await page.screenshot({ path: `${OUT}/02-folded.png` });

const handle = await page.evaluate((vw, vh) => {
  const b = [...document.querySelectorAll('button')].find((x) => / を表示$/.test(x.getAttribute('title') || ''));
  if (!b) return { found: false };
  const r = b.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  return {
    found: true,
    rect: { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    inView: r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh,
    // その座標で実際に手前に居るのはこのボタンか (何かに隠されていないか)
    onTop: document.elementFromPoint(cx, cy) === b || b.contains(document.elementFromPoint(cx, cy)),
    big: r.width >= 40 && r.height >= 40,
  };
}, VW, VH);
check('戻すハンドルがある', handle.found);
check('ハンドルが画面の中にある', !!handle.inView, JSON.stringify(handle.rect));
check('ハンドルが何にも隠れていない', !!handle.onTop);
check('ハンドルが指で押せる大きさ (44px 以上)', !!handle.big, `${handle.rect?.w}x${handle.rect?.h}`);

const reopened = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => / を表示$/.test(x.getAttribute('title') || ''));
  if (!b) return 'no-handle';
  b.click();
  return 'clicked';
});
await sleep(700);
const railBack = await page.evaluate(() => !!document.querySelector('.ds-rail'));
check('ハンドルを押すとツールが戻る', reopened === 'clicked' && railBack, `${reopened} rail=${railBack}`);

// ── 5. ピンチで画角 ────────────────────────────────────────────────────────
console.log('\n=== 5. ピンチで画角 ===');
const cdp = await page.createCDPSession();
const fov = () => page.evaluate(() => window.__sceneManager?.getCurrentPose?.()?.fov ?? null);
const yaw = () => page.evaluate(() => window.__sceneManager?.getCurrentPose?.()?.target ?? null);

/** 2 本指をキャンバス中央から広げる / 縮める。CDP でないとマルチタッチは出せない。 */
async function pinch(from, to, steps = 8) {
  const cx = VW / 2;
  const cy = VH / 2;
  const pts = (gap) => [
    { x: cx - gap / 2, y: cy, id: 1 },
    { x: cx + gap / 2, y: cy, id: 2 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(from) });
  for (let i = 1; i <= steps; i++) {
    const gap = from + ((to - from) * i) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(gap) });
    await sleep(30);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(250);
}

const f0 = await fov();
const t0 = await yaw();
check('画角が読める', typeof f0 === 'number', `fov=${f0}`);
await pinch(80, 300);           // 広げる = 寄る
const f1 = await fov();
const t1 = await yaw();
check('指を広げると寄る (画角が小さくなる)', f1 < f0 - 1, `${f0?.toFixed(1)}° → ${f1?.toFixed(1)}°`);
check('ピンチ中に画が回らない',
  !!t0 && !!t1 && Math.hypot(t0[0] - t1[0], t0[2] - t1[2]) < 0.02,
  `target ${JSON.stringify(t0?.map((v) => +v.toFixed(3)))} → ${JSON.stringify(t1?.map((v) => +v.toFixed(3)))}`);
await page.screenshot({ path: `${OUT}/03-zoomed-in.png` });

await pinch(300, 80);           // 縮める = 引く
const f2 = await fov();
check('指を縮めると引く (画角が大きくなる)', f2 > f1 + 1, `${f1?.toFixed(1)}° → ${f2?.toFixed(1)}°`);
await page.screenshot({ path: `${OUT}/04-zoomed-out.png` });

// 上限・下限を越えない
await pinch(60, 380);
await pinch(60, 380);
await pinch(60, 380);
const fMin = await fov();
check('寄りすぎない (下限で止まる)', fMin >= 24.9, `fov=${fMin?.toFixed(1)}°`);

const bad = logs.filter((l) => !/favicon|ERR_/.test(l));
if (bad.length) { console.log('\n=== エラー ==='); bad.slice(0, 6).forEach((l) => console.log(`  ${l}`)); }
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
