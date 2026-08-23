/**
 * 360°動画の描き分け切替を、本物の UI で確かめる。
 *
 * tsc も build も「切り替わるか」「切り替えても場所が飛ばないか」を何ひとつ守らない。
 * 実際に描かせて、画素と再生位置を見るしかない。
 *
 * 素材は 8K の実素材ではなく、その場で作る 640x320 の合成動画を使う。確かめたいのは
 * 絵の中身ではなく **仕掛け** — 背景色でどのバリアントが貼られているかが分かり、
 * 進んでいくバーの位置で再生位置が分かる。実素材だと 1 本 100MB を 3 本読むことに
 * なり、壊れたときに「重いのか壊れているのか」の切り分けもできない。
 *
 * 確かめること:
 *   1. 既定のバリアントで起動する
 *   2. 家具トグルで絵が変わる (色が変わる)
 *   3. 切り替えても再生位置が保たれる (バーの位置が動かない)
 *   4. 素材の無い組み合わせ (夜 x 家具なし) は押せない
 *   5. 押せない組み合わせを API から叩いても、絵が変わらない
 *
 *   node scripts/check-video360-variants.mjs [--base http://localhost:5173]
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
const OUT = '.shots/video360-variants';
const TMP = '.shots/video360-variants/media';
const SCENE_ID = 'v360-variants-check';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await rm(OUT, { recursive: true, force: true });
await mkdir(TMP, { recursive: true });

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`);
};

// ── 1. 合成素材を作る ──────────────────────────────────────────────────────
// 背景色 = どのバリアントか。左から右へ動く黒いバー = 再生位置。
// 3 本とも同じ尺・同じフレーム数にする (実素材の前提と揃える)。
const DUR = 6;
const VARIANTS = [
  { id: 'on_day', label: '通常', furniture: 'on', lighting: 'day', color: 'red' },
  { id: 'off_day', label: '家具なし', furniture: 'off', lighting: 'day', color: 'lime' },
  { id: 'on_night', label: '夜', furniture: 'on', lighting: 'night', color: 'blue' },
];

const run = (cmd, a) => new Promise((res, rej) => {
  const p = spawn(cmd, a, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.on('error', rej);
  p.on('close', (c) => (c === 0 ? res() : rej(new Error(`${cmd} exit ${c}\n${err.slice(-1500)}`))));
});

console.log('=== 1. 合成素材を作る ===');
for (const v of VARIANTS) {
  const dst = path.join(TMP, `${v.id}.webm`);
  // バーは overlay で動かす。drawbox の x 式に `t` を入れても、この ffmpeg では
  // 評価されず箱が一切描かれない (静止値なら描かれる)。overlay は効く。
  await run('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${v.color}:s=640x320:d=${DUR}:r=30`,
    '-f', 'lavfi', '-i', `color=c=black:s=60x40:d=${DUR}:r=30`,
    '-filter_complex', `[0][1]overlay=x='(W-w)*t/${DUR}':y=140`,
    '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-g', '15', '-pix_fmt', 'yuv420p',
    dst,
  ]);
  console.log(`  ${v.id.padEnd(9)} ${v.color}`);
}

const assets = await serveAssets(Object.fromEntries(VARIANTS.map((v) => [v.id, path.join(TMP, `${v.id}.webm`)])));
console.log(`  素材サーバ ${assets.origin}`);

// ── 2. 種を仕込む ──────────────────────────────────────────────────────────
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--window-size=1440,900', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

console.log('\n=== 2. 検証データを注入 ===');
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate(async (payload) => {
  const { sceneId, origin, variants, duration } = payload;
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

  for (const v of variants) {
    await put('blobs', `v360-${v.id}`, await (await fetch(`${origin}/${v.id}`)).blob());
  }

  const nodes = [
    { id: 'p1', label: '入口', t: 0.5, pos: [0, 1.6, 0] },
    { id: 'p2', label: '奥', t: 5.0, pos: [0, 1.6, -4] },
  ];
  await put('manifests', sceneId, {
    id: sceneId,
    name: '360動画バリアント検証',
    settings: { render: { engine: 'playcanvas' } },
    viewerToolbar: { viewpoints: true, map: false },
    plans: [{
      id: 'plan1',
      label: 'メイン',
      startViewpointId: 'p1',
      viewpoints: nodes.map((n) => ({
        id: n.id, label: n.label, position: n.pos,
        target: [n.pos[0], n.pos[1], n.pos[2] - 1], fov: 75,
      })),
      video360: {
        src: `idb:v360-${variants[0].id}`,
        duration, fps: 30,
        sourceName: 'synthetic',
        defaultVariantId: variants[0].id,
        variants: variants.map((v) => ({
          id: v.id, label: v.label, furniture: v.furniture, lighting: v.lighting,
          src: `idb:v360-${v.id}`,
        })),
        nodes: nodes.map((n) => ({ viewpointId: n.id, t: n.t })),
        edges: [{ id: 'e1', from: 'p1', to: 'p2', range: [0.5, 5.0], label: '奥へ' }],
      },
    }],
  });
  localStorage.setItem('3droomtour:projects:v1', JSON.stringify([{
    id: sceneId, name: '360動画バリアント検証', type: 'realestate',
    viewMode: 'video360', createdAt: Date.now(),
  }]));
  localStorage.setItem('admin-auth-v1', JSON.stringify({ ts: Date.now(), role: 'admin' }));
}, { sceneId: SCENE_ID, origin: assets.origin, variants: VARIANTS, duration: DUR });
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
const ready = await page.waitForFunction(
  () => !!window.__sceneManager?.getVideo360?.(),
  { timeout: 60000 },
).then(() => true).catch(() => false);
check('動画ウォークスルーが起動する', ready);
if (!ready) { await finish(); }

await page.waitForFunction(
  () => window.__sceneManager?.getVideo360?.()?.getState?.().mode === 'idle',
  { timeout: 60000 },
).catch(() => {});

// サイドバーは畳まれた状態で開くことがある。家具 / 情景トグルはその中なので、
// 開いておかないと「押せない」ではなく「無い」になり、何を見ているのか分からなくなる。
// 「シーンを表示」(シーンバーの開閉) も同じ語尾なので、スペース付きで区別する ―
// サイドバーのハンドルは `<シーン名> を表示`。
const opened = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => / を表示$/.test(x.getAttribute('title') || ''));
  if (!b) return 'already-open';
  b.click();
  return 'opened';
});
console.log(`  サイドバー: ${opened}`);
await sleep(400);

// 家具 / 情景トグルは左レールの「カラー」節の中。節を開かないと DOM に出ない。
const railOpened = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.ds-rail__item')].find((x) => x.getAttribute('title') === 'カラー');
  if (!b) return 'no-rail-item';
  b.click();
  return 'opened';
});
console.log(`  カラー節: ${railOpened}`);
check('カラー節がレールに出ている (素材があるので自動で出る)', railOpened === 'opened', railOpened);
await sleep(1000);

/**
 * いま何が貼られているか。
 *
 * WebGL のバックバッファは読めない (preserveDrawingBuffer なし) ので、
 * 貼り元の <video> をオフスクリーンに描いて色を測る。テクスチャは毎フレーム
 * この要素から作られているので、ここが答えでいい。
 */
const probe = () => page.evaluate(() => {
  const w = window.__sceneManager?.getVideo360?.();
  if (!w) return null;
  const v = w.videoElement;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 32;
  const g = c.getContext('2d');
  g.drawImage(v, 0, 0, 64, 32);
  const d = g.getImageData(0, 0, 64, 32).data;
  // 背景色 = 中央上寄り (バーの通り道を外す)
  const at = (x, y) => { const i = (y * 64 + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
  // バーの位置 = 一番暗い列
  let darkest = 0; let darkestX = -1;
  for (let x = 0; x < 64; x++) {
    const [r, gg, b] = at(x, 16);
    const lum = r + gg + b;
    if (darkestX < 0 || lum < darkest) { darkest = lum; darkestX = x; }
  }
  return {
    variantId: w.variantId,
    bg: at(32, 3),
    barX: darkestX,
    time: +v.currentTime.toFixed(3),
    state: w.getState(),
  };
});

const hue = (bg) => {
  const [r, g, b] = bg;
  if (r > g + 40 && r > b + 40) return 'red';
  if (g > r + 40 && g > b + 40) return 'lime';
  if (b > r + 40 && b > g + 40) return 'blue';
  return `other(${bg.join(',')})`;
};

const shot = async (n, note) => {
  await page.screenshot({ path: `${OUT}/${n}.png` });
  console.log(`  📸 ${n}  ${note}`);
};

// ── 4. 既定のバリアント ────────────────────────────────────────────────────
console.log('\n=== 4. 既定のバリアント ===');
const a = await probe();
check('既定は on_day (通常)', a?.variantId === 'on_day', `variantId=${a?.variantId}`);
const segs = await page.evaluate(() => [...document.querySelectorAll('.ds-seg__btn')].map((b) => b.textContent?.trim()));
check('家具 / 情景トグルが出ている',
  ['あり', 'なし', '昼', '夜'].every((l) => segs.includes(l)), `segs=${segs.join(',')}`);
check('赤い素材が貼られている', hue(a.bg) === 'red', `bg=${hue(a.bg)}`);
await shot('01-default', `通常 / t=${a.time}`);

// ── 5. トグルで切り替える ──────────────────────────────────────────────────
console.log('\n=== 5. 家具トグルで切り替える ===');
const clickSeg = (label) => page.evaluate((l) => {
  const b = [...document.querySelectorAll('.ds-seg__btn')].find((x) => x.textContent?.trim() === l);
  if (!b) return 'not-found';
  if (b.disabled) return 'disabled';
  b.click();
  return 'clicked';
}, label);

const furnitureOff = await clickSeg('なし');
check('家具「なし」を押せる', furnitureOff === 'clicked', furnitureOff);
await page.waitForFunction(
  () => window.__sceneManager?.getVideo360?.()?.variantId === 'off_day',
  { timeout: 20000 },
).catch(() => {});
await sleep(600);
const b = await probe();
check('家具なしの素材に変わる', b?.variantId === 'off_day' && hue(b.bg) === 'lime',
  `variantId=${b?.variantId} bg=${hue(b.bg)}`);
check('再生位置が保たれる', Math.abs(b.time - a.time) < 0.2 && Math.abs(b.barX - a.barX) <= 2,
  `t ${a.time}→${b.time} / bar ${a.barX}→${b.barX}`);
await shot('02-furniture-off', `家具なし / t=${b.time}`);

// ── 6. 素材の無い組み合わせ ────────────────────────────────────────────────
console.log('\n=== 6. 素材の無い組み合わせ (夜 x 家具なし) ===');
const nightWhileOff = await clickSeg('夜');
check('家具なしのとき「夜」は押せない', nightWhileOff === 'disabled', nightWhileOff);

// 家具を戻せば夜は選べる
await clickSeg('あり');
await page.waitForFunction(
  () => window.__sceneManager?.getVideo360?.()?.variantId === 'on_day',
  { timeout: 20000 },
).catch(() => {});
const nightWhileOn = await clickSeg('夜');
check('家具ありなら「夜」を押せる', nightWhileOn === 'clicked', nightWhileOn);
await page.waitForFunction(
  () => window.__sceneManager?.getVideo360?.()?.variantId === 'on_night',
  { timeout: 20000 },
).catch(() => {});
await sleep(600);
const c = await probe();
check('夜の素材に変わる', c?.variantId === 'on_night' && hue(c.bg) === 'blue',
  `variantId=${c?.variantId} bg=${hue(c.bg)}`);
await shot('03-night', `夜 / t=${c.time}`);

// 夜のまま家具なしは、UI でも API でも通らない
const offWhileNight = await clickSeg('なし');
check('夜のとき「なし」は押せない', offWhileNight === 'disabled', offWhileNight);
const forced = await page.evaluate(async () => {
  await window.__sceneManager.setVideo360Variant('off', 'night');
  return window.__sceneManager.getVideo360().variantId;
});
check('API から叩いても勝手に別の絵にならない', forced === 'on_night', `variantId=${forced}`);

// ── 7. 歩いたあとでも切り替わる ────────────────────────────────────────────
console.log('\n=== 7. 歩いてから切り替える ===');
await page.evaluate(async () => {
  const w = window.__sceneManager.getVideo360();
  const ex = w.exitsOf('p1').find((e) => e.to === 'p2');
  await w.travel(ex);
});
await sleep(1200);
const d1 = await probe();
const moved = d1.barX > a.barX + 4;
check('奥のノードまで歩いた', moved, `bar ${a.barX}→${d1.barX} t=${d1.time}`);
await page.evaluate(() => window.__sceneManager.setVideo360Variant('on', 'day'));
await page.waitForFunction(
  () => window.__sceneManager?.getVideo360?.()?.variantId === 'on_day',
  { timeout: 20000 },
).catch(() => {});
await sleep(600);
const d2 = await probe();
check('歩いた先でも切り替わる', d2?.variantId === 'on_day' && hue(d2.bg) === 'red',
  `variantId=${d2?.variantId} bg=${hue(d2.bg)}`);
check('歩いた先の位置が保たれる', Math.abs(d2.time - d1.time) < 0.2 && Math.abs(d2.barX - d1.barX) <= 2,
  `t ${d1.time}→${d2.time} / bar ${d1.barX}→${d2.barX}`);
await shot('04-after-walk', `歩行後に通常へ / t=${d2.time}`);

await finish();

async function finish() {
  const bad = logs.filter((l) => !/favicon|ERR_/.test(l));
  if (bad.length) {
    console.log('\n=== コンソールエラー ===');
    bad.slice(0, 10).forEach((l) => console.log(`  ${l}`));
  }
  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${failed.length === 0 ? '✅ 全部通った' : `❌ ${failed.length} / ${checks.length} 失敗`}`);
  failed.forEach((f) => console.log(`  - ${f.name}  ${f.detail}`));
  console.log(`スクリーンショット: ${OUT}/`);
  await browser.close();
  assets.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

async function serveAssets(files) {
  const { createServer } = await import('node:http');
  const { createReadStream } = await import('node:fs');
  const { stat } = await import('node:fs/promises');
  const known = {};
  for (const [name, p] of Object.entries(files)) {
    known[name] = { path: p, size: (await stat(p)).size };
  }
  const server = createServer((req, res) => {
    const name = (req.url || '').replace(/^\//, '').split('?')[0];
    const f = known[name];
    if (!f) { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      'Content-Type': 'video/webm',
      'Content-Length': f.size,
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
    });
    createReadStream(f.path).pipe(res);
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
