/**
 * Phone-width regression check.
 *
 * The failure this catches is the one you cannot see on a desktop monitor and
 * cannot see in a screenshot either, because the page looks fine until you try
 * to scroll it: a single element wider than the viewport makes the whole body
 * scroll sideways, and every fixed overlay drifts off the screen with it.
 *
 * It also flags controls below the 44px touch target and text under 11px,
 * both of which are only wrong at this size.
 *
 *   node scripts/check-mobile.mjs            # report
 *   node scripts/check-mobile.mjs --strict   # exit 1 on any finding
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(existsSync);
const BASE = 'http://localhost:5173';

/** iPhone 14 / Pixel 7 class. Portrait is the case that actually breaks. */
const DEVICES = [
  { name: 'phone portrait',  width: 390, height: 844, dpr: 3, touch: true },
  { name: 'phone landscape', width: 844, height: 390, dpr: 3, touch: true },
  { name: 'tablet portrait', width: 820, height: 1180, dpr: 2, touch: true },
];

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});

async function signIn(page) {
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 900));
  const fields = await page.$$('input[type="text"], input[type="password"]');
  if (fields.length >= 2) {
    await fields[0].type('takyu');
    await fields[1].type('1qaz1833');
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => /ログイン/.test(b.textContent || ''))?.click();
    });
    await new Promise((r) => setTimeout(r, 1600));
  }
  if (await page.evaluate(() => document.body.innerText.includes('プロジェクトがまだありません'))) {
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => /新規プロジェクト/.test(b.textContent || ''))?.click();
    });
    await new Promise((r) => setTimeout(r, 800));
    const dlg = await page.$$('input[type="text"]');
    if (dlg.length) await dlg[0].type('mobile');
    await page.evaluate(() => {
      const bs = [...document.querySelectorAll('button')];
      (bs.find((b) => /^作成$/.test((b.textContent || '').trim())) ?? bs[bs.length - 1])?.click();
    });
    await new Promise((r) => setTimeout(r, 1400));
  }
  return page.evaluate(() => {
    try { return (JSON.parse(localStorage.getItem('3droomtour:projects:v1') || '[]')[0] || {}).id ?? null; }
    catch { return null; }
  });
}

/** Everything measured inside the page, so these are painted facts. */
const AUDIT = () => {
  const vw = document.documentElement.clientWidth;
  const overflow = [];
  const smallTargets = [];
  const smallText = [];
  const seen = new Set();

  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const r = el.getBoundingClientRect();
    // Zero area in either axis means it is not on screen (a collapsed
    // container, a file input hidden by layout). Not a small target — no
    // target. Counting it produces a finding nobody can act on.
    if (r.width === 0 || r.height === 0) continue;

    // Sideways overflow: sticking out past the right edge, or starting left of 0.
    // A wide element inside a container that SCROLLS horizontally is correct —
    // you can still reach it. `overflow: hidden` is not the same thing and must
    // not be excused: it clips the content away silently, so the page looks
    // tidy and a third of the toolbar is simply gone. Treating hidden as
    // "handled" is what made this check pass on a screen that was visibly cut
    // off in its own screenshot.
    let scrollableAncestor = false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') { scrollableAncestor = true; break; }
    }
    if (!scrollableAncestor && (r.right > vw + 1 || r.left < -1)) {
      const key = el.tagName + '.' + (el.className || '').toString().slice(0, 60);
      if (!seen.has(key)) {
        seen.add(key);
        overflow.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().slice(0, 70),
          left: Math.round(r.left),
          right: Math.round(r.right),
          over: Math.round(r.right - vw),
        });
      }
    }

    // Touch targets. 44px is the smallest reliably hittable control.
    const interactive = el.matches('button, a[href], select, input:not([type=hidden]), [role=button]');
    if (interactive && !el.disabled && (r.height < 44 || r.width < 44)) {
      const key = 'T' + el.tagName + (el.className || '').toString().slice(0, 50) + Math.round(r.height);
      if (!seen.has(key)) {
        seen.add(key);
        smallTargets.push({
          label: (el.getAttribute('title') || el.textContent || el.tagName).trim().slice(0, 28),
          cls: (el.className || '').toString().slice(0, 46),
          w: Math.round(r.width), h: Math.round(r.height),
        });
      }
    }

    // Type that is legible on a desktop but not in the hand.
    const fs = parseFloat(cs.fontSize);
    if (fs && fs < 11 && el.textContent && el.textContent.trim() && el.children.length === 0) {
      const key = 'F' + fs + (el.className || '').toString().slice(0, 40);
      if (!seen.has(key)) {
        seen.add(key);
        smallText.push({ px: fs, cls: (el.className || '').toString().slice(0, 46), text: el.textContent.trim().slice(0, 24) });
      }
    }
  }

  return {
    bodyScrollsSideways: document.documentElement.scrollWidth > vw + 1,
    scrollWidth: document.documentElement.scrollWidth,
    viewport: vw,
    overflow: overflow.slice(0, 10),
    smallTargets: smallTargets.slice(0, 12),
    smallText: smallText.slice(0, 10),
  };
};

let findings = 0;

for (const dev of DEVICES) {
  const page = await browser.newPage();
  await page.setViewport({
    width: dev.width, height: dev.height,
    deviceScaleFactor: 1, isMobile: dev.touch, hasTouch: dev.touch,
  });
  const id = await signIn(page);

  for (const [label, url] of [['viewer', `${BASE}/viewer/${id}`], ['debug', `${BASE}/scene/${id}`]]) {
    await page.goto(url, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 5000));
    const a = await page.evaluate(AUDIT);

    console.log(`\n== ${dev.name} · ${label}  (${dev.width}x${dev.height})`);
    if (a.bodyScrollsSideways) {
      findings++;
      console.log(`   SIDEWAYS SCROLL  page is ${a.scrollWidth}px wide in a ${a.viewport}px viewport`);
    } else {
      console.log('   no sideways scroll');
    }
    for (const o of a.overflow) {
      findings++;
      console.log(`   overflow  +${o.over}px  <${o.tag} class="${o.cls}">`);
    }
    if (a.smallTargets.length) {
      console.log(`   touch targets under 44px: ${a.smallTargets.length}`);
      for (const t of a.smallTargets.slice(0, 6)) {
        console.log(`      ${t.w}x${t.h}  "${t.label}"  .${t.cls}`);
      }
    }
    if (a.smallText.length) {
      console.log(`   text under 11px: ${a.smallText.length}`);
      for (const t of a.smallText.slice(0, 4)) console.log(`      ${t.px}px  "${t.text}"  .${t.cls}`);
    }
    await page.screenshot({ path: `.shots/m-${dev.name.replace(/ /g, '-')}-${label}.png` });
  }
  await page.close();
}

await browser.close();
console.log(`\n${findings} layout finding(s)`);
if (process.argv.includes('--strict') && findings > 0) process.exit(1);
