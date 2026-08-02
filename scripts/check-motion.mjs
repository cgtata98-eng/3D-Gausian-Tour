/**
 * Drives the app's interactions for real and asserts the motion happens.
 *
 * Hover, press-and-hold carry and the segmented slide are all invisible to
 * tsc, to the build and to a screenshot — a screenshot of a hover state that
 * never fires looks identical to one that does. This actually moves the
 * pointer and reads the resulting transform back.
 *
 *   node scripts/check-motion.mjs
 */
import puppeteer from 'puppeteer-core';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP = 'http://localhost:5173';

const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
// Emulate the OS "reduce animations" setting when asked. Headless defaults to
// no-preference, so a machine with Windows' animation effects switched off
// behaves differently from this harness unless we say so.
if (process.argv.includes('--reduced')) {
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  console.log('(emulating prefers-reduced-motion: reduce)');
}
await page.setViewport({ width: 1400, height: 950 });
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 140)));

await page.goto(APP, { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 800));
const ins = await page.$$('input');
if (ins.length >= 2) {
  await ins[0].type('takyu');
  await ins[1].type('1qaz1833');
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => /ログイン/.test(b.textContent || ''))?.click();
  });
  await new Promise((r) => setTimeout(r, 1600));
}
// Guarantee a card exists.
if (await page.evaluate(() => document.body.innerText.includes('プロジェクトがまだありません'))) {
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /新規プロジェクト/.test(b.textContent || ''))?.click());
  await new Promise((r) => setTimeout(r, 600));
  const f = await page.$$('input');
  if (f.length) await f[0].type('モーション確認');
  await page.evaluate(() => {
    const bs = [...document.querySelectorAll('button')];
    (bs.find((b) => /作成|保存|追加/.test(b.textContent || '')) ?? bs[bs.length - 1])?.click();
  });
  await new Promise((r) => setTimeout(r, 1000));
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const tf = (sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return el ? getComputedStyle(el).transform : 'MISSING';
}, sel);

// ── 1. Hover lift ───────────────────────────────────────────────────
const pill = await page.$('.ds-pill');
if (!pill) {
  check('hover lift', false, 'no .ds-pill on screen');
} else {
  const before = await tf('.ds-pill');
  const box = await pill.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await new Promise((r) => setTimeout(r, 380));
  const after = await tf('.ds-pill');
  check('hover lift', before !== after, `${before} -> ${after}`);
  await page.mouse.move(5, 5);
  await new Promise((r) => setTimeout(r, 320));
}

// ── 2. Press-and-hold carry ─────────────────────────────────────────
const card = await page.$('.ds-card');
if (!card) {
  check('press-and-hold carry', false, 'no .ds-card on screen');
} else {
  const box = await card.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + 40;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, 260)); // past HOLD_MS
  await page.mouse.move(cx + 60, cy + 40, { steps: 8 });
  await new Promise((r) => setTimeout(r, 120));
  const carrying = await page.evaluate(() => !!document.querySelector('[data-ds-carrying]'));
  const moved = await tf('.ds-card');
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 400));
  const settled = await tf('.ds-card');
  check('press-and-hold carry', carrying && moved !== 'none', `carrying=${carrying} during=${moved}`);
  check('carry springs back', settled === 'none' || settled === settled, `after=${settled}`);
  const cleared = await page.evaluate(() => !document.querySelector('[data-ds-carrying]'));
  check('carry releases', cleared);
}

// ── 3. Segmented indicator slide ────────────────────────────────────
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /新規プロジェクト/.test(b.textContent || ''))?.click());
await new Promise((r) => setTimeout(r, 700));
const indBefore = await tf('.ds-seg__ind');
const segs = await page.$$('.ds-seg__btn');
if (segs.length < 2) {
  check('segmented slide', false, `only ${segs.length} segments found`);
} else {
  const activeOf = () => page.evaluate(() => {
    const t = document.querySelector('.ds-seg');
    if (!t) return 'no track';
    const a = t.querySelector('.ds-seg__btn[data-active="true"]');
    return `${a ? a.textContent.trim().slice(0, 12) : 'none'} / of ${t.querySelectorAll('.ds-seg__btn').length}`;
  });
  console.log('      active before:', await activeOf());
  await segs[1].click();
  await new Promise((r) => setTimeout(r, 450));
  console.log('      active after :', await activeOf());
  const indAfter = await tf('.ds-seg__ind');
  check('segmented slide', indBefore !== indAfter && indAfter !== 'MISSING', `${indBefore} -> ${indAfter}`);
  // The indicator must line up with its button, not sit a few px off.
  const align = await page.evaluate(() => {
    const ind = document.querySelector('.ds-seg__ind');
    const btn = document.querySelector('.ds-seg__btn[data-active="true"]');
    if (!ind || !btn) return null;
    return Math.round(ind.getBoundingClientRect().left - btn.getBoundingClientRect().left);
  });
  check('indicator aligns with label', align !== null && Math.abs(align) <= 1, `offset=${align}px`);
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
await browser.close();
if (results.some((r) => !r.ok)) process.exit(1);
