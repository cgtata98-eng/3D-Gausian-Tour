/**
 * 家具・情景バリアント (360画像) を本物の UI で確かめる。
 *
 * 確かめたいのは「トグルを押したら別の絵が貼られるか」で、絵の中身ではない。
 * 素材はその場で作る単色 equirect ― 実素材だと 1 枚 8K を何枚も読むことになり、
 * 壊れたときに「重いのか壊れているのか」の切り分けもできない。
 *
 * ここが守っているもの:
 *   1. 素材を入れただけでトグルが出る (ツールバー表示のチェックは要らない)
 *   2. 押すと視点のパノラマが差し替わる
 *   3. 素材の無い組み合わせは押せない
 *   4. 素材を入れていない視点は、切り替えてもプラン既定のまま (穴が空かない)
 *
 *   node scripts/check-asset-variants.mjs [--base http://localhost:5173]
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
const OUT = '.shots/asset-variants';
const TMP = `${OUT}/media`;
const SCENE_ID = 'assetvar-check';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await rm(OUT, { recursive: true, force: true });
await mkdir(TMP, { recursive: true });

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`);
};

// ── 1. 合成パノラマ ────────────────────────────────────────────────────────
// 単色の equirect。色 = どのバリアントの絵が貼られているか。
const IMAGES = [
  { name: 'base-v1', color: 'gray' },     // プラン既定 (視点1)
  { name: 'base-v2', color: 'white' },    // プラン既定 (視点2) — 差し替えない側
  { name: 'off_day', color: 'lime' },
  { name: 'on_night', color: 'blue' },
];

const run = (cmd, a) => new Promise((res, rej) => {
  const p = spawn(cmd, a, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.on('error', rej);
  p.on('close', (c) => (c === 0 ? res() : rej(new Error(`${cmd} exit ${c}\n${err.slice(-1200)}`))));
});

console.log('=== 1. 合成パノラマを作る ===');
for (const im of IMAGES) {
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
    '-i', `color=c=${im.color}:s=2048x1024`, '-frames:v', '1',
    path.join(TMP, `${im.name}.jpg`)]);
  console.log(`  ${im.name.padEnd(9)} ${im.color}`);
}
const assets = await serveAssets(Object.fromEntries(IMAGES.map((i) => [i.name, path.join(TMP, `${i.name}.jpg`)])));
console.log(`  素材サーバ ${assets.origin}`);

// ── 2. 種を仕込む ──────────────────────────────────────────────────────────
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--window-size=1440,900', '--mute-audio'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

console.log('\n=== 2. 検証データを注入 ===');
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
  for (const n of ['base-v1', 'base-v2', 'off_day', 'on_night']) {
    await put('blobs', `av-${n}`, await (await fetch(`${origin}/${n}`)).blob());
  }

  const vps = [
    { id: 'v1', label: 'リビング', position: [0, 1.6, 0] },
    { id: 'v2', label: '寝室', position: [3, 1.6, -2] },
  ];
  await put('manifests', sceneId, {
    id: sceneId,
    name: '家具情景バリアント検証',
    settings: { render: { engine: 'playcanvas' } },
    viewerToolbar: { viewpoints: true, map: false },
    plans: [{
      id: 'plan1',
      label: 'メイン',
      startViewpointId: 'v1',
      viewpoints: vps.map((v) => ({
        id: v.id, label: v.label, position: v.position,
        target: [v.position[0], v.position[1], v.position[2] - 1], fov: 75,
      })),
      // プラン既定 — バリアントが埋めていない視点はこれが出続けなければならない。
      panoramas: { v1: 'idb:av-base-v1', v2: 'idb:av-base-v2' },
      assetVariants: [
        // v1 だけ差し替える。v2 は既定のまま = 穴が空かないことを見る。
        { id: 'off_day', label: '家具なし', furniture: 'off', lighting: 'day', panoramas: { v1: 'idb:av-off_day' } },
        { id: 'on_night', label: '夜', furniture: 'on', lighting: 'night', panoramas: { v1: 'idb:av-on_night' } },
      ],
    }],
  });
  localStorage.setItem('3droomtour:projects:v1', JSON.stringify([{
    id: sceneId, name: '家具情景バリアント検証', type: 'realestate',
    viewMode: '360', createdAt: Date.now(),
  }]));
  localStorage.setItem('admin-auth-v1', JSON.stringify({ ts: Date.now(), role: 'admin' }));
}, { sceneId: SCENE_ID, origin: assets.origin });
console.log('  注入完了');

// ── 3. ビューアを開く ──────────────────────────────────────────────────────
console.log('\n=== 3. ビューアを開く ===');
await page.goto(`${BASE}/viewer/${SCENE_ID}`, { waitUntil: 'networkidle2', timeout: 90000 });
await sleep(1500);
const gated = await page.$$('input');
if (gated.length >= 2) {
  await gated[0].type('takyu');
  await gated[1].type('1qaz1833');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /ログイン/.test(x.textContent || ''));
    b?.click();
  });
  await sleep(2500);
}
await page.waitForFunction(() => !!window.__sceneManager, { timeout: 60000 }).catch(() => {});
await sleep(2500);

await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => / を表示$/.test(x.getAttribute('title') || ''));
  b?.click();
});
await sleep(400);
const railOpened = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.ds-rail__item')].find((x) => x.getAttribute('title') === 'カラー');
  if (!b) return 'no-rail-item';
  b.click();
  return 'opened';
});
check('素材を入れただけでカラー節が出る (ツールバーのチェック無し)', railOpened === 'opened', railOpened);
await sleep(400);
const segs = await page.evaluate(() => [...document.querySelectorAll('.ds-seg__btn')].map((b) => b.textContent?.trim()));
check('家具 / 情景トグルが出ている', ['あり', 'なし', '昼', '夜'].every((l) => segs.includes(l)), `segs=${segs.join(',')}`);

/**
 * 画面に出ている色。360 はスカイボックスなので、canvas を読むのが唯一の答え。
 * `preserveDrawingBuffer` が無いので、次のフレームを描かせた直後に読む。
 */
const probe = async () => {
  const shot = await page.screenshot({ encoding: 'base64', clip: { x: 700, y: 420, width: 40, height: 40 } });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, 8, 8);
    const d = g.getImageData(3, 3, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, shot);
};
const hue = ([r, g, b]) => {
  if (g > r + 40 && g > b + 40) return 'lime';
  if (b > r + 40 && b > g + 40) return 'blue';
  if (Math.abs(r - g) < 22 && Math.abs(g - b) < 22) return r > 200 ? 'white' : 'gray';
  return `other(${r},${g},${b})`;
};
const shot = async (n, note) => { await page.screenshot({ path: `${OUT}/${n}.png` }); console.log(`  📸 ${n}  ${note}`); };

const clickSeg = (label) => page.evaluate((l) => {
  const b = [...document.querySelectorAll('.ds-seg__btn')].find((x) => x.textContent?.trim() === l);
  if (!b) return 'not-found';
  if (b.disabled) return 'disabled';
  b.click();
  return 'clicked';
}, label);

const gotoVp = (id) => page.evaluate((vp) => window.__sceneManager.jumpToViewpoint(
  window.__sceneManager.manifest?.plans?.[0]?.viewpoints?.find((v) => v.id === vp)
  ?? { id: vp }), id);

// ── 4. 既定 ────────────────────────────────────────────────────────────────
console.log('\n=== 4. 既定 (家具あり × 昼) ===');
const a = await probe();
check('プラン既定の絵が出ている', hue(a) === 'gray', `色=${hue(a)}`);
await shot('01-default', `既定 ${hue(a)}`);

// ── 5. 家具なしへ ──────────────────────────────────────────────────────────
console.log('\n=== 5. 家具「なし」へ ===');
check('家具「なし」を押せる', (await clickSeg('なし')) === 'clicked');
await sleep(1400);
const b = await probe();
check('パノラマが家具なしの絵に変わる', hue(b) === 'lime', `色=${hue(b)}`);
await shot('02-off-day', `家具なし ${hue(b)}`);

// ── 6. 素材を入れていない視点 ──────────────────────────────────────────────
console.log('\n=== 6. 差し替えていない視点は既定のまま ===');
await gotoVp('v2');
await sleep(1400);
const c = await probe();
check('未登録の視点はプラン既定が出る (穴が空かない)', hue(c) === 'white', `色=${hue(c)}`);
await shot('03-v2-fallback', `寝室 ${hue(c)}`);
await gotoVp('v1');
await sleep(1400);

// ── 7. 素材の無い組み合わせ ────────────────────────────────────────────────
console.log('\n=== 7. 夜 × 家具なし は素材が無い ===');
const nightAtOff = await clickSeg('夜');
check('家具なしのとき「夜」は押せない', nightAtOff === 'disabled', nightAtOff);
const backToOn = await clickSeg('あり');
check('既定 (家具あり × 昼) に戻れる', backToOn === 'clicked', backToOn);
await sleep(1400);
const nightClick = await clickSeg('夜');
check('家具ありなら「夜」を押せる', nightClick === 'clicked', nightClick);
await sleep(1400);
const d = await probe();
check('夜の絵に変わる', hue(d) === 'blue', `色=${hue(d)}`);
await shot('04-night', `夜 ${hue(d)}`);
const offAtNight = await clickSeg('なし');
check('夜のとき「なし」は押せない', offAtNight === 'disabled', offAtNight);

const bad = logs.filter((l) => !/favicon|ERR_/.test(l));
if (bad.length) { console.log('\n=== コンソールエラー ==='); bad.slice(0, 10).forEach((l) => console.log(`  ${l}`)); }
const failed = checks.filter((c2) => !c2.pass);
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
      'Content-Type': 'image/jpeg',
      'Content-Length': f.size,
      'Access-Control-Allow-Origin': '*',
    });
    createReadStream(f.path).pipe(res);
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
