/**
 * Visual verification harness.
 *
 * Drives the local dev server in headless Edge and writes screenshots to
 * `.shots/`. Exists because "did the design system actually land on this
 * screen?" cannot be answered by reading source — a screen can import the
 * right tokens and still paint the old look if it re-implements the surface
 * on top of them.
 *
 * Auth and project state are seeded through localStorage before the app
 * boots, so the run lands directly on the screen under test.
 *
 *   node scripts/shot.mjs
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://localhost:5173';
const OUT = '.shots';

mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--force-device-scale-factor=2', '--window-size=1600,1000'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });

page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 160)); });
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));

// Log in through the real gate rather than guessing at its storage key —
// the key has moved between versions and a wrong guess silently leaves the
// run stuck on the login card.
await page.goto(BASE, { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 800));
const inputs = await page.$$('input');
if (inputs.length >= 2) {
  await inputs[0].type('takyu');
  await inputs[1].type('1qaz1833');
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const login = btns.find((b) => /ログイン/.test(b.textContent || ''));
    login?.click();
  });
  await new Promise((r) => setTimeout(r, 1500));
}

async function shot(name, url, waitMs = 2500) {
  await page.goto(BASE + url, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, waitMs));
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const info = await page.evaluate(() => {
    const rings = document.querySelectorAll('.glass-edge').length;
    // Any element still painting a solid, visible 1px outline is a surface
    // the shell never reached.
    let stale = 0;
    const samples = [];
    for (const el of document.querySelectorAll('div,button,span,a,input')) {
      const cs = getComputedStyle(el);
      const bw = parseFloat(cs.borderTopWidth) || 0;
      const bc = cs.borderTopColor || '';
      if (bw > 0 && bc && !/rgba\(0, 0, 0, 0\)|transparent/.test(bc)) {
        const r = el.getBoundingClientRect();
        if (r.width > 24 && r.height > 12) {
          stale++;
          if (samples.length < 6) {
            samples.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().slice(0, 22)} ${bw}px ${bc}`);
          }
        }
      }
    }
    // A component that owns its padding, rendered with none, is almost always
    // an inline `padding` at the call site winning over the class. It is not a
    // "wrong colour" bug so nothing else here catches it, and it does not look
    // broken in code — padding reads as layout, which style objects are still
    // allowed to carry. It looks broken only on screen: the label and the
    // close button end up sitting on the corner radius with the ring through
    // them. That is what happened to every block in the viewer sidebar.
    const crushed = [];
    for (const sel of ['.ds-block', '.ds-panel', '.ds-section__body', '.ds-well', '.ds-dialog']) {
      for (const el of document.querySelectorAll(sel)) {
        const cs = getComputedStyle(el);
        const pad = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].map((p) => parseFloat(cs[p]) || 0);
        if (pad.every((v) => v === 0)) {
          crushed.push(`${sel} "${(el.textContent || '').trim().slice(0, 14)}"`);
        }
      }
    }
    return { rings, stale, samples, crushed, title: document.title };
  });
  console.log(`\n== ${name} (${url})`);
  console.log(`   .glass-edge: ${info.rings}   solid-border surfaces left: ${info.stale}`);
  info.samples.forEach((s) => console.log('    -', s));
  if (info.crushed.length) {
    console.log(`   !! padding crushed to 0 on ${info.crushed.length} design-system surface(s):`);
    info.crushed.slice(0, 6).forEach((s) => console.log('    -', s));
  }
}

await shot('01-projects-empty', '/');

// Create a project through the real dialog so the card, the dialog itself and
// the downstream screens all get exercised.
const hasProject = await page.evaluate(() => document.body.innerText.includes('プロジェクトがまだありません'));
if (hasProject) {
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => /新規プロジェクト/.test(b.textContent || ''))?.click();
  });
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: `${OUT}/01b-dialog.png` });
  const dlgInputs = await page.$$('input');
  if (dlgInputs.length) await dlgInputs[0].type('港区 3LDK モデルルーム');
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    (btns.find((b) => /作成|保存|追加/.test(b.textContent || '')) ?? btns[btns.length - 1])?.click();
  });
  await new Promise((r) => setTimeout(r, 900));
}
await shot('01c-projects', '/');

// The API-key dialog. Worth its own shot: it is the one surface where a
// missing fill is fatal rather than cosmetic — it sits over the project grid,
// so transparency puts its own body text on top of other content.
await page.evaluate(() => {
  [...document.querySelectorAll('button')]
    .find((b) => (b.getAttribute('title') || '').includes('API') || b.querySelector('svg circle'))
    ?.click();
});
await new Promise((r) => setTimeout(r, 700));
await page.screenshot({ path: `${OUT}/01d-apikey.png` });
const dlgOpaque = await page.evaluate(() => {
  const el = [...document.querySelectorAll('div')].find((d) => /API キー設定/.test(d.textContent || '') && d.clientWidth > 300 && d.clientWidth < 600);
  if (!el) return 'dialog not found';
  const cs = getComputedStyle(el);
  return `bg=${cs.backgroundColor} img=${cs.backgroundImage.slice(0, 42)}`;
});
console.log('   api dialog surface:', dlgOpaque);
await page.keyboard.press('Escape');
await page.evaluate(() => {
  [...document.querySelectorAll('button')].find((b) => /閉じる/.test(b.textContent || ''))?.click();
});
await new Promise((r) => setTimeout(r, 400));

// Open the first project's debug/editor screen — that is where the bulk of
// the un-migrated chrome lives.
const firstId = await page.evaluate(() => {
  try {
    for (const k of Object.keys(localStorage)) {
      if (!/project/i.test(k)) continue;
      const v = JSON.parse(localStorage.getItem(k) || 'null');
      const list = v?.state?.projects ?? v?.projects ?? (Array.isArray(v) ? v : null);
      if (Array.isArray(list) && list.length) return list[0].id;
    }
  } catch { /* not the projects key */ }
  return null;
});
console.log('\nfirst project id:', firstId);
if (firstId) {
  await shot('02-debug', `/scene/${firstId}`, 6000);
  await shot('03-viewer', `/viewer/${firstId}`, 6000);

  // Expand every collapsed LeftPanel section so the AI block — with the five
  // native <select>s that stayed OS-chromed the longest — is actually on
  // screen. A screenshot of a collapsed panel proves nothing.
  await page.evaluate(() => {
    document.querySelectorAll('button').forEach((b) => {
      if (/ヘッドトラッキング|画質|AI 画像生成|環境音/.test(b.textContent || '')) b.click();
    });
  });
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: `${OUT}/04-leftpanel.png` });
  const sel = await page.evaluate(() => {
    const s = document.querySelector('select');
    if (!s) return 'no select on screen';
    const cs = getComputedStyle(s);
    return `appearance=${cs.appearance} radius=${cs.borderTopLeftRadius} borderW=${cs.borderTopWidth}`;
  });
  console.log('   select computed:', sel);
}

await browser.close();
console.log('\nwrote screenshots to', OUT);
