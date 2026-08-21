/**
 * 360°動画ウォークスルーを本物の UI で動かして確かめる。
 *
 * tsc も build も lint も「360 が正しく貼れているか」「ポイントが押せるか」を
 * 何ひとつ守らない。実際に描かせて、画素とクリック結果を見るしかない。
 *
 * やること:
 *   1. プロジェクト (localStorage) と manifest / 動画 blob (IDB) を注入
 *   2. ビューアを開いて 360 動画モードで起動
 *   3. 絵が出ているか / 床ポイントが出ているか / 押すと歩くか / 下のシーンバーで飛べるか
 *
 *   node scripts/check-video360.mjs [--base http://localhost:5173] [--video <mp4>] [--rev <mp4>]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const BASE = arg('base', 'http://localhost:5173');
const VIDEO = arg('video', 'C:/Users/takyu/Desktop/video360-proto/media/tour.mp4');
const REV = arg('rev', 'C:/Users/takyu/Desktop/video360-proto/media/tour-rev.mp4');
const ANALYSIS = arg('analysis', null);
// 既存の慣習に合わせて `.shots/` 配下へ。gitignore 済みで、走らせるたび作り直す。
const OUT = '.shots/video360';

const SCENE_ID = 'v360-check';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await mkdir(OUT, { recursive: true });

// 検証データ。プロトタイプで読み取ったルートをそのまま使う。
const analysis = ANALYSIS ? JSON.parse(await readFile(ANALYSIS, 'utf8')) : null;
const NODES = [
  { id: 'p1', label: 'アプローチ', t: 0.20, pos: [0, 1.6, 0] },
  { id: 'p2', label: '玄関ポーチ', t: 8.60, pos: [0, 1.6, -8.4] },
  { id: 'p3', label: '玄関ホール', t: 27.00, pos: [0, 1.6, -17] },
  { id: 'p4', label: '寝室', t: 42.50, pos: [4, 1.6, -24] },
  { id: 'p5', label: '書斎', t: 56.50, pos: [8, 1.6, -28] },
];
const EDGES = [
  { id: 'e1', from: 'p1', to: 'p2', range: [0.20, 8.60], label: '玄関へ進む' },
  { id: 'e2', from: 'p2', to: 'p3', range: [14.53, 23.47], label: '中に入る' },
  { id: 'e3', from: 'p3', to: 'p4', range: [31.07, 39.07], label: '寝室へ' },
  { id: 'e4', from: 'p4', to: 'p5', range: [45.63, 54.00], label: '書斎へ' },
];

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  // 自動再生の許可は --strict-autoplay で外せる。付けたまま検証すると、実ブラウザで
  // 「動画が動かない」という一番よくある壊れ方を丸ごと見逃す。
  args: [
    '--no-sandbox',
    '--window-size=1440,900',
    ...(process.argv.includes('--strict-autoplay') ? [] : ['--autoplay-policy=no-user-gesture-required']),
    '--mute-audio',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`);
};
const shot = async (n, note) => {
  await page.screenshot({ path: `${OUT}/${n}.png` });
  console.log(`  📸 ${n}  ${note}`);
};

// ── 1. 種を仕込む ────────────────────────────────────────────────────────
console.log('\n=== 1. 検証データを注入 ===');
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });

// 動画はページ側に HTTP で取らせる。base64 にして CDP で流し込むと、
// 40MB の素材が 1 メッセージ 60MB 超の文字列になってブラウザごと落ちる。
const assets = await serveAssets({ fwd: VIDEO, rev: REV });
console.log(`  素材サーバ ${assets.origin}`);

await page.evaluate(async (payload) => {
  const { sceneId, nodes, edges, origin, hasRev, stills, calmTimes, duration } = payload;

  // IDB は本体と同じ DB / ストア名 / バージョンで開く
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

  await put('blobs', `video360-${sceneId}-plan1-src`, await (await fetch(`${origin}/fwd`)).blob());
  if (hasRev) {
    await put('blobs', `video360-${sceneId}-plan1-srcReverse`, await (await fetch(`${origin}/rev`)).blob());
  }

  const manifest = {
    id: sceneId,
    name: '360動画ウォークスルー検証',
    settings: { render: { engine: 'playcanvas' } },
    // シーンバー (.ds-scene) は viewerToolbar.viewpoints が true のときだけ出る。
    // `settings` の中ではなく manifest 直下にある。
    viewerToolbar: { viewpoints: true, map: false },
    plans: [{
      id: 'plan1',
      label: 'メイン',
      startViewpointId: nodes[0].id,
      viewpoints: nodes.map((n) => ({
        id: n.id, label: n.label,
        position: n.pos,
        target: [n.pos[0], n.pos[1], n.pos[2] - 1],
        fov: 75,
      })),
      video360: {
        src: `idb:video360-${sceneId}-plan1-src`,
        ...(hasRev ? { srcReverse: `idb:video360-${sceneId}-plan1-srcReverse` } : {}),
        duration, fps: 30,
        sourceName: 'tour.mp4',
        nodes: nodes.map((n) => ({ viewpointId: n.id, t: n.t })),
        edges,
        ...(stills ? { stills } : {}),
        ...(calmTimes ? { calmTimes } : {}),
      },
    }],
  };
  await put('manifests', sceneId, manifest);

  localStorage.setItem('3droomtour:projects:v1', JSON.stringify([{
    id: sceneId, name: '360動画ウォークスルー検証', type: 'realestate',
    viewMode: 'video360', createdAt: Date.now(),
  }]));
  // 認証は本体と同じキー / 同じ形で入れる (utils/auth.ts の AuthRecord)。
  localStorage.setItem('admin-auth-v1', JSON.stringify({ ts: Date.now(), role: 'admin' }));
}, {
  sceneId: SCENE_ID, nodes: NODES, edges: EDGES,
  origin: assets.origin, hasRev: assets.hasRev,
  stills: analysis?.stills ?? null,
  calmTimes: analysis?.calmTimes ?? null,
  duration: analysis?.duration ?? 58.623,
});
console.log(`  注入完了${assets.hasRev ? ' (反転素材あり)' : ' (反転素材なし)'}`);

// ── 2. ビューアを開く ────────────────────────────────────────────────────
console.log('\n=== 2. ビューアを開く ===');
await page.goto(`${BASE}/viewer/${SCENE_ID}`, { waitUntil: 'networkidle2', timeout: 90000 });
await sleep(1500);

// 認証ゲートが出たら通す
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

await page.waitForFunction(
  () => window.__sceneManager?.getVideo360?.()?.getState?.().mode === 'idle',
  { timeout: 60000 },
).catch(() => {});
await sleep(1200);

const probe = () => page.evaluate(() => {
  const c = document.querySelector('canvas');
  const g = c?.getContext('webgl2');
  return {
    state: window.__sceneManager?.getVideo360?.()?.getState?.() ?? null,
    rings: document.querySelectorAll('.ds-v360-rings path[data-ring]').length,
    ringsDrawn: [...document.querySelectorAll('.ds-v360-rings path[data-ring]')]
      .filter((p) => (p.getAttribute('d') || '').length > 10).length,
    scenes: [...document.querySelectorAll('.ds-scene')].map((b) => b.textContent?.trim()),
    canvas: !!g,
  };
});

let st = await probe();
console.log('  ', JSON.stringify(st.state));
await shot('01-start', '開始ノードで静止');
check('開始ノードに立っている', st.state?.mode === 'idle' && st.state?.nodeId === 'p1', `node=${st.state?.nodeId}`);

// 絵が出ているか。readPixels は合成後に空になるので使えない。
// カメラの向きを変えて、実際に描かれた絵が変わるかをスクショのバイト列で見る。
// 空 (真っ黒 / 真っ白) なら、どちらを向いても同じバイト列になる。
const shotBytes = async () => (await page.screenshot({ encoding: 'binary' })).length;
const look = (yaw, pitch) => page.evaluate((y, p) => {
  const cc = window.__sceneManager?.cameraController;
  cc?.setYaw?.(y);
  cc?.setPitch?.(p);
}, yaw, pitch);

await look(0, -10);
await sleep(500);
const bytesA = await shotBytes();
await look(120, -10);
await sleep(500);
const bytesB = await shotBytes();
await look(0, -28);
await sleep(400);
check('動画がスカイボックスに乗っている', Math.abs(bytesA - bytesB) > 2000,
  `向きを変えると絵が変わる (${bytesA}B → ${bytesB}B)`);

// ── 3. 下のシーンバー ────────────────────────────────────────────────────
console.log('\n=== 3. 下のシーンバー ===');
check('シーンバーに全ノードが並ぶ', st.scenes.length === NODES.length, st.scenes.join(' / '));

// ── 4. 床ポイント ────────────────────────────────────────────────────────
console.log('\n=== 4. 床ポイント ===');
await look(0, -28);   // 床が視界に入るよう少し見下ろす
await sleep(600);
st = await probe();
await shot('02-floor-points', '床ポイント');
check('床ポイントが描かれている', st.ringsDrawn > 0, `${st.ringsDrawn} / ${st.rings} 個が描画`);

// ── 5. シーンバーで飛ぶ ──────────────────────────────────────────────────
console.log('\n=== 5. シーンバーから移動 ===');
const t0 = Date.now();
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.ds-scene')].find((x) => /寝室/.test(x.textContent || ''));
  b?.click();
});
await sleep(2000);
st = await probe();
await shot('03-walking', '移動中（区間再生）');
check('シーンバーを押すと歩き出す', st.state?.mode === 'travel', `mode=${st.state?.mode}`);

const arrived = await page.waitForFunction(
  () => window.__sceneManager?.getVideo360?.()?.getState?.().nodeId === 'p4',
  { timeout: 90000 },
).then(() => true).catch(() => false);
st = await probe();
await shot('04-arrived', '寝室に到着');
check('歩いて寝室まで到達', arrived && st.state?.nodeId === 'p4', `${((Date.now() - t0) / 1000).toFixed(1)}s / node=${st.state?.nodeId}`);

// ── 6. 逆走 ──────────────────────────────────────────────────────────────
if (assets.hasRev) {
  console.log('\n=== 6. 逆走して戻る ===');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.ds-scene')].find((x) => /玄関ホール/.test(x.textContent || ''));
    b?.click();
  });
  await sleep(1500);
  st = await probe();
  await shot('05-reverse', '逆再生で戻っている途中');
  check('逆走が始まる', st.state?.mode === 'travel', `mode=${st.state?.mode}`);
  const back = await page.waitForFunction(
    () => window.__sceneManager?.getVideo360?.()?.getState?.().nodeId === 'p3',
    { timeout: 90000 },
  ).then(() => true).catch(() => false);
  check('逆走で玄関ホールに戻れる', back);
  await shot('06-back', '玄関ホールに戻った');
}

// ── 7. Debug 画面が動画用になっているか ────────────────────────────────
console.log('\n=== 7. Debug 画面の出し分け ===');
await page.goto(`${BASE}/scene/${SCENE_ID}`, { waitUntil: 'networkidle2', timeout: 90000 });
await sleep(4000);

// セクションは既定で閉じているので、見出しを総当たりで開く
const openAll = () => page.evaluate(() => {
  for (const el of document.querySelectorAll('button, summary, [role="button"]')) {
    const t = (el.textContent || '').trim();
    if (/各プラン|描画品質|360°動画ウォークスルー/.test(t)) el.click();
  }
});
await openAll();
await sleep(900);

const dbg = await page.evaluate(() => {
  const text = document.body.innerText;
  const titles = [...document.querySelectorAll('*')]
    .filter((e) => e.children.length === 0)
    .map((e) => (e.textContent || '').trim());
  return {
    hasPlanVideoMeta: /動画\s+tour\.mp4|動画\s+\(未設定\)|動画\s+設定済/.test(text),
    hasNodeCount: /ノード\s+\d+/.test(text),
    hasSplatWord: /splat\s+\(/.test(text),
    hasEngineSwitch: titles.includes('ビューアエンジン'),
    hasColorPipeline: titles.includes('カラーパイプライン'),
    hasRenderQuality: titles.includes('描画品質'),
    hasAssembly: /360°動画ウォークスルー/.test(text),
  };
});
await page.screenshot({ path: `${OUT}/07-debug.png`, fullPage: false });
console.log('  📸 07-debug  Debug 画面（動画モード）');

check('プランカードが動画の状態を出す', dbg.hasPlanVideoMeta && dbg.hasNodeCount, JSON.stringify({ 動画: dbg.hasPlanVideoMeta, ノード数: dbg.hasNodeCount }));
check('プランカードに splat の欄が出ない', !dbg.hasSplatWord);
check('3DGS 専用の描画ノブが出ない', !dbg.hasEngineSwitch && !dbg.hasColorPipeline, `エンジン選択=${dbg.hasEngineSwitch} カラーパイプライン=${dbg.hasColorPipeline}`);
check('描画品質そのものは残る（露出・背景色）', dbg.hasRenderQuality);

// ── 8. オーサリング（ワンクリック解析 / ポイント打ち / ドア貼り）──────────
console.log('\n=== 8. オーサリング ===');

// 解析 JSON も反転素材も無いところから始める。ここが今回の主題。
await page.evaluate(async (sceneId) => {
  const db = await new Promise((res, rej) => {
    const req = indexedDB.open('3droomtour', 1);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  const m = await new Promise((res, rej) => {
    const tx = db.transaction('manifests', 'readonly');
    const r = tx.objectStore('manifests').get(sceneId);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const v = m.plans[0].video360;
  delete v.stills;
  delete v.calmTimes;
  delete v.srcReverse;
  v.nodes = [];
  v.edges = [];
  await new Promise((res, rej) => {
    const tx = db.transaction('manifests', 'readwrite');
    tx.objectStore('manifests').put(m, sceneId);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}, SCENE_ID);

await page.goto(`${BASE}/scene/${SCENE_ID}`, { waitUntil: 'networkidle2', timeout: 90000 });
await sleep(4500);
await page.evaluate(() => {
  for (const el of document.querySelectorAll('button, summary, [role="button"]')) {
    const t = (el.textContent || '').trim();
    if (/プラン$|360°動画ウォークスルー/.test(t)) el.click();
  }
});
await sleep(1200);
// プランタブへ
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim().startsWith('プラン'));
  b?.click();
});
await sleep(1200);
await page.evaluate(() => {
  for (const el of document.querySelectorAll('button, summary, [role="button"]')) {
    if (/360°動画ウォークスルー/.test((el.textContent || '').trim())) el.click();
  }
});
await sleep(800);

const hasAnalyzeBtn = await page.evaluate(() =>
  [...document.querySelectorAll('button')].some((b) => /動画を解析する/.test(b.textContent || '')));
check('JSON 無しでも解析ボタンが出る', hasAnalyzeBtn);

if (hasAnalyzeBtn) {
  const t0 = Date.now();
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /動画を解析する/.test(x.textContent || ''));
    b?.click();
  });
  const analysed = await page.waitForFunction(() => {
    const t = document.body.innerText;
    return !/解析中/.test(t) && /解析しなおす/.test(t);
  }, { timeout: 240000, polling: 1000 }).then(() => true).catch(() => false);
  const stills = await page.evaluate(() => {
    const el = [...document.querySelectorAll('button')].find((b) => /静止区間\s*\d+\s*個から/.test(b.textContent || ''));
    const m = el && (el.textContent || '').match(/静止区間\s*(\d+)\s*個から/);
    return m ? Number(m[1]) : 0;
  });
  await page.screenshot({ path: `${OUT}/08-analyzed.png` });
  console.log('  📸 08-analyzed  ワンクリック解析の結果');
  check('ワンクリックで静止区間を検出できる', analysed && stills > 0,
    `${stills} 区間 / ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// 打ち込み: ポイント
const pointOn = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /ポイントを打つ/.test(x.textContent || ''));
  if (!b) return false;
  b.click();
  return true;
});
check('打ち込みモードに入れる', pointOn);
await sleep(600);
const aimShown = await page.evaluate(() => !!document.querySelector('.ds-v360-aim'));
check('照準が出る', aimShown);
await page.screenshot({ path: `${OUT}/09-authoring.png` });
console.log('  📸 09-authoring  打ち込みモード');

// N キーで中央の床に打つ。床が視界に入るよう見下ろしてから。
const before = await page.evaluate(() => {
  const sm = window.__sceneManager;
  const cc = sm?.cameraController;
  cc?.setPitch?.(-30);
  return document.querySelectorAll('.ds-scene').length;
});
await sleep(700);
await page.keyboard.press('n');
await sleep(1200);
const afterN = await page.evaluate(() => document.querySelectorAll('.ds-scene').length);
check('N キーでポイントが打てる', afterN === before + 1, `シーン ${before} → ${afterN}`);

// D キーでドアを貼る
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /ドアを貼る/.test(x.textContent || ''));
  b?.click();
});
await sleep(500);
await page.keyboard.press('d');
await sleep(1200);
const doors = await page.evaluate(() => document.querySelectorAll('.ds-v360-door').length);
await page.screenshot({ path: `${OUT}/10-door.png` });
console.log('  📸 10-door  ドアのマーク');
check('D キーでドアが貼れる', doors > 0, `${doors} 個`);

// ── 9. 実フロー: 動画が無いプランに ⇪ で入れる ────────────────────────────
// ここが今まで抜けていた。種を直接仕込む検証だと「入れた直後に動くか」を一度も
// 通らないので、`setViewMode` が同じモードで即 return して起動しない不具合を見逃す。
console.log('\n=== 9. 実フロー: ⇪ で動画を入れる ===');

await page.evaluate(async (sceneId) => {
  const db = await new Promise((res, rej) => {
    const req = indexedDB.open('3droomtour', 1);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  const m = await new Promise((res, rej) => {
    const tx = db.transaction('manifests', 'readonly');
    const r = tx.objectStore('manifests').get(sceneId);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  delete m.plans[0].video360;          // 動画ごと外して、入れるところからやる
  await new Promise((res, rej) => {
    const tx = db.transaction('manifests', 'readwrite');
    tx.objectStore('manifests').put(m, sceneId);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}, SCENE_ID);

await page.goto(`${BASE}/scene/${SCENE_ID}`, { waitUntil: 'networkidle2', timeout: 90000 });
await sleep(4000);
// 全体タブ →「各プラン」を開く
await page.evaluate(() => {
  for (const el of document.querySelectorAll('button, summary, [role="button"]')) {
    if (/各プラン/.test((el.textContent || '').trim())) el.click();
  }
});
await sleep(900);

const upBtn = await page.$('button[title*="360°動画を入れる"]');
check('プランカードに動画の ⇪ が出る', !!upBtn);
if (upBtn) {
  // ⇪ を実際に押す。input へ直接流し込むと、どのプランに入れるかを覚える
  // state (planVideoTargetId) が立たず、ハンドラが何もせず抜ける。
  const [chooser] = await Promise.all([
    page.waitForFileChooser({ timeout: 15000 }),
    upBtn.click(),
  ]);
  await chooser.accept([VIDEO]);
  // 取り込み → manifest 反映 → syncVideo360 で起動、まで待つ
  const started = await page.waitForFunction(
    () => !!window.__sceneManager?.getVideo360?.(),
    { timeout: 90000 },
  ).then(() => true).catch(() => false);
  await sleep(2500);
  check('入れた直後にウォークスルーが起動する', started);

  // 絵が出ているか。向きを変えて画が変わることで見る。
  const bytes = [];
  for (const yaw of [0, 120]) {
    await page.evaluate((y) => {
      const cc = window.__sceneManager?.cameraController;
      cc?.setYaw?.(y);
      cc?.setPitch?.(-10);
    }, yaw);
    await sleep(600);
    bytes.push((await page.screenshot({ encoding: 'binary' })).length);
  }
  await page.screenshot({ path: `${OUT}/11-uploaded.png` });
  console.log('  📸 11-uploaded  ⇪ で入れた直後');
  check('入れた直後に動画が映る', Math.abs(bytes[0] - bytes[1]) > 2000, `${bytes[0]}B → ${bytes[1]}B`);

  // 再生されるか。素の再生を回して時刻が進むことを見る。
  const played = await page.evaluate(async () => {
    const w = window.__sceneManager.getVideo360();
    w.previewPlay();
    const t0 = w.getState().time;
    await new Promise((r) => setTimeout(r, 2000));
    const t1 = w.getState().time;
    w.previewPause();
    return { t0, t1 };
  });
  check('動画が再生される（時刻が進む）', played.t1 - played.t0 > 0.5,
    `${played.t0.toFixed(2)}s → ${played.t1.toFixed(2)}s`);
}

// ── 10. ワンクリックで反転素材を作る ──────────────────────────────────────
console.log('\n=== 10. 反転素材をボタンで作る ===');
const ping = await page.evaluate(() => fetch('/api/dev/video360/ping').then((r) => r.json()).catch(() => ({ ffmpeg: false })));
check('この端末で ffmpeg が使える', !!ping.ffmpeg, JSON.stringify(ping));

if (ping.ffmpeg) {
  // パネルはプランタブの中の折りたたみセクション。開いてからでないと中身が無い。
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim().startsWith('プラン'));
    b?.click();
  });
  await sleep(1200);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('button, summary, [role="button"]')) {
      if (/360°動画ウォークスルー/.test((el.textContent || '').trim())) el.click();
    }
  });
  await sleep(900);

  const hasBtn = await page.evaluate(() =>
    [...document.querySelectorAll('button')].some((b) => /反転素材を作/.test(b.textContent || '')));
  check('反転素材を作るボタンが出る', hasBtn);

  if (hasBtn) {
    const t0 = Date.now();
    // 確認ダイアログは自動で閉じる
    page.on('dialog', (d) => { void d.accept(); });
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /反転素材を作/.test(x.textContent || ''));
      b?.click();
    });
    const made = await page.waitForFunction(
      () => /反転素材を差し替え/.test(document.body.innerText),
      { timeout: 600000, polling: 2000 },
    ).then(() => true).catch(() => false);
    check('ボタンだけで反転素材ができる', made, `${((Date.now() - t0) / 1000).toFixed(0)}s`);

    // 出来た素材が実際にウォークスルーに入ったか。ノードの数はここでは問わない
    // (この手順は動画を入れ直した直後なので、まだノードを打っていない)。
    const back = await page.evaluate(() => {
      const w = window.__sceneManager?.getVideo360?.();
      if (!w) return { ok: false, why: 'walker なし' };
      const refs = w.sourceRefs;
      return { ok: !!refs.reverse, why: refs.reverse ?? '逆走の素材が入っていない' };
    });
    check('作った反転素材がウォークスルーに入る', back.ok, back.why);
  }
}

await writeFile(`${OUT}/report.json`, JSON.stringify({ checks, logs }, null, 2));
const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} 合格`);
if (logs.length) {
  console.log('--- console ---');
  for (const l of logs.slice(0, 12)) console.log(' ', l);
}
await browser.close();
assets.close();
process.exit(failed.length ? 1 : 0);

/** 素材をページに取らせるための、その場限りの静的サーバ。CORS を開けておく。 */
async function serveAssets(files) {
  const { createServer } = await import('node:http');
  const { createReadStream } = await import('node:fs');
  const { stat } = await import('node:fs/promises');

  const known = {};
  for (const [name, path] of Object.entries(files)) {
    try { known[name] = { path, size: (await stat(path)).size }; } catch { /* 無ければ出さない */ }
  }
  const server = createServer((req, res) => {
    const name = (req.url || '').replace(/^\//, '').split('?')[0];
    const f = known[name];
    if (!f) { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': f.size,
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
    });
    createReadStream(f.path).pipe(res);
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  return {
    origin: `http://127.0.0.1:${port}`,
    hasRev: !!known.rev,
    close: () => server.close(),
  };
}

