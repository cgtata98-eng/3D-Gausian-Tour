/**
 * Side-by-side diff between the design-system spec page and the running app.
 *
 * Reads the computed styles of the equivalent element in each and prints only
 * the properties that differ. Screenshots tell you *that* something is off;
 * this tells you *which declaration* is off, which is the part that has been
 * costing round-trips.
 *
 *   node scripts/compare.mjs
 */
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SPEC = pathToFileURL(resolve('docs/design-system-s1.html')).href;
const APP = 'http://localhost:5173';

/** Properties worth comparing — appearance, not layout position. */
const PROPS = [
  'width', 'height',
  'backgroundImage', 'boxShadow', 'borderRadius', 'borderTopWidth', 'borderTopColor',
  'color', 'fontSize', 'fontWeight', 'letterSpacing', 'textShadow', 'padding',
];

const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });

async function styles(url, pairs, prep) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  await page.goto(url, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 900));
  if (prep) await prep(page);
  const out = await page.evaluate((pairs, PROPS) => {
    const res = {};
    for (const [name, sel] of pairs) {
      const el = document.querySelector(sel);
      if (!el) { res[name] = null; continue; }
      const cs = getComputedStyle(el);
      const o = {};
      for (const p of PROPS) o[p] = cs[p];
      res[name] = o;
    }
    return res;
  }, pairs, PROPS);
  await page.close();
  return out;
}

const specPairs = [
  ['pill/neutral', '.btn.edge.c-neutral'],
  ['pill/accent', '.btn.edge.c-accent'],
  ['card', '.card.edge.c-neutral'],
  ['tag/accent', '.tag.edge.c-accent'],
  ['card-tag', '.card .tag.edge.c-accent'],
  ['card-box', '.cols4 .card.edge.c-neutral'],
];
const appPairs = [
  ['pill/neutral', '.ds-pill.ds-v-neutral'],
  ['pill/accent', '.ds-pill.ds-v-accent'],
  ['card', '.ds-card'],
  ['tag/accent', '.ds-tag.ds-v-accent'],
  ['card-tag', '.ds-card .ds-tag'],
  ['card-box', '.ds-card'],
];

const spec = await styles(SPEC, specPairs);
const app = await styles(APP, appPairs, async (page) => {
  const ins = await page.$$('input');
  if (ins.length >= 2) {
    await ins[0].type('takyu');
    await ins[1].type('1qaz1833');
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => /ログイン/.test(b.textContent || ''))?.click();
    });
    await new Promise((r) => setTimeout(r, 1600));
  }
  // Cards and neutral pills only exist once there is a project, and the
  // headless profile starts empty — comparing against the empty state finds
  // nothing and reports a false "identical".
  const empty = await page.evaluate(() => document.body.innerText.includes('プロジェクトがまだありません'));
  if (empty) {
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => /新規プロジェクト/.test(b.textContent || ''))?.click();
    });
    await new Promise((r) => setTimeout(r, 600));
    const f = await page.$$('input');
    if (f.length) await f[0].type('比較用');
    await page.evaluate(() => {
      const bs = [...document.querySelectorAll('button')];
      (bs.find((b) => /作成|保存|追加/.test(b.textContent || '')) ?? bs[bs.length - 1])?.click();
    });
    await new Promise((r) => setTimeout(r, 1000));
  }
});

for (const [name] of specPairs) {
  const a = spec[name];
  const b = app[name];
  console.log(`\n── ${name}`);
  if (!a) { console.log('   spec: element not found'); continue; }
  if (!b) { console.log('   app: element not found'); continue; }
  let same = true;
  for (const p of PROPS) {
    if (a[p] !== b[p]) {
      same = false;
      console.log(`   ${p}`);
      console.log(`     spec: ${String(a[p]).slice(0, 110)}`);
      console.log(`     app : ${String(b[p]).slice(0, 110)}`);
    }
  }
  if (same) console.log('   identical');
}

await browser.close();
