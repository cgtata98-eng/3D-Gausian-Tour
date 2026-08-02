/**
 * Fails when a screen describes APPEARANCE inline instead of naming a
 * design-system class.
 *
 * This is the piece that was missing all along. The rule "screens say what a
 * thing is, `design-system.css` says how it looks" is only worth anything if
 * breaking it is visible. Until now a style object that quietly re-implemented
 * a surface looked exactly like one that didn't, and the only way to find it
 * was to notice the wrong pixels on screen — which is what turned this into a
 * long series of "still not fixed".
 *
 * Run it to see the remaining migration backlog, or in CI to stop new drift:
 *
 *   node scripts/check-design-system.mjs            # report
 *   node scripts/check-design-system.mjs --strict   # exit 1 if anything is left
 *
 * A file is clean when a design change in `design-system.css` reaches every
 * one of its surfaces with no edits to the file itself.
 */
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

/** Properties that decide how a surface LOOKS. These belong to the CSS. */
const APPEARANCE = [
  'background', 'backgroundImage', 'backgroundColor',
  'border', 'borderColor', 'borderWidth', 'borderStyle',
  'boxShadow', 'textShadow',
  'fontSize', 'fontWeight', 'fontFamily', 'letterSpacing',
  'color',
  'backdropFilter', 'WebkitBackdropFilter',
];

/**
 * Legitimate exceptions — genuinely not design-system surfaces.
 *
 * The line to hold: a colour the DESIGN chose belongs in the CSS; a colour the
 * DATA carries (a variant's swatch, a status dot whose hue IS the status, an
 * accent passed in as a prop) has to stay at the call site, because the CSS
 * cannot know it. Allowing those is not a loophole — it is the difference
 * between "this file is migrated" and "this file has an excuse".
 */
const ALLOW = [
  // Canvas painting and SVG attributes are not CSS surfaces.
  /ctx\./,
  // Directional borders are separators, not surface outlines.
  /border(Top|Bottom|Left|Right)(Color|Width|Style)?:/,
  // Thumbnails and 3D backdrops are content, not chrome.
  /THUMB_GRAD|gradient\(.*deg.*#(cdd|d8d|c39)/,
  // A swatch shows a colour — that colour is the content.
  /ds-swatch|ds-chip__swatch/,
  // A status light whose colour IS the status, passed in as a value.
  /background: dot\b|background: swatch\b|background: ?v\.swatch|background: ?color\b/,
  // An accent handed to a component as a prop.
  /\{ color: accent \}/,
  // Not a style object: a key called `color` in a label / config / block map,
  // or a parameter named `color` in a signature.
  /^\s*color: ['"]/,
  /^\s*color: \w+ \?/,
  /\(.*\bcolor: string\b/,
  // A token alias table (`const COLOR = { border: tokens.color.border }`) —
  // it re-exports the design system rather than bypassing it.
  /^\s*(border|color|text|panel\d?|bg|borderSoft): tokens\.color\./,
];

const FILES = globSync('src/ui/**/*.tsx');
const rows = [];

for (const file of FILES) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  let hits = 0;
  const samples = [];
  lines.forEach((line, i) => {
    if (ALLOW.some((re) => re.test(line))) return;
    for (const prop of APPEARANCE) {
      // Only inside a style object — `prop:` followed by a value.
      const re = new RegExp(`(^|[\\s{,])${prop}\\s*:`);
      if (re.test(line)) {
        hits++;
        if (samples.length < 3) samples.push(`${i + 1}: ${line.trim().slice(0, 72)}`);
        break;
      }
    }
  });
  const legacy = (src.match(/glass-edge/g) || []).length;
  if (hits || legacy) rows.push({ file, hits, legacy, samples });
}

rows.sort((a, b) => b.hits - a.hits);

const total = rows.reduce((n, r) => n + r.hits, 0);
const totalLegacy = rows.reduce((n, r) => n + r.legacy, 0);

console.log('Inline appearance declarations still bypassing design-system.css\n');
for (const r of rows) {
  console.log(`${String(r.hits).padStart(4)}  ${r.file}${r.legacy ? `   (glass-edge x${r.legacy})` : ''}`);
  for (const s of r.samples) console.log(`        ${s}`);
}
const clean = FILES.length - rows.length;
console.log(`\n${clean}/${FILES.length} files clean · ${total} declarations left · ${totalLegacy} legacy glass-edge`);

/* ── Hand-rolled controls ────────────────────────────────────────────
 * The declaration count above missed the real failure twice, because a
 * hand-written control can be *tidy* — a couple of `tokens.*` lines — and
 * still not be the shared component. The サイドバーサイズ 2-択 sat in the
 * backlog for weeks looking like ordinary inline styling; what was actually
 * wrong was that it wasn't `PillToggle`, so it had no sliding indicator and
 * no liquid shell. Nothing here could say that, so it was only ever found by
 * someone looking at a screenshot.
 *
 * These rules name the shapes that MUST come from a component, so "this was
 * built by hand" is a check result instead of a report from the user.
 */
const SHAPES = [
  {
    name: 'segmented control built by hand',
    // A row of buttons where one is styled as selected — that is `SegmentedControl`
    // / `PillToggle`, which own the indicator that slides between options.
    test: (src) => {
      const out = [];
      const re = /\.map\(\s*\(?\s*(\w+)[^)]*\)?\s*=>\s*\{?[\s\S]{0,900}?<button/g;
      let m;
      while ((m = re.exec(src))) {
        const body = src.slice(m.index, m.index + 1800);
        const selects = /(isActive|isA|active|selected)\s*\?/.test(body);
        const paints = /background:|boxShadow:|borderColor:/.test(body);
        if (selects && paints && !/ds-seg|ds-tile|ds-navitem|ds-scene|ds-chip/.test(body)) {
          out.push(src.slice(0, m.index).split('\n').length);
        }
      }
      return out;
    },
    fix: 'use <SegmentedControl> / <PillToggle> — they carry the sliding indicator',
  },
  {
    name: 'stylesheet injected at runtime',
    // A second, invisible design system. Rules here never reach the checker,
    // never respond to a token change, and silently outrank `.ds-*`.
    test: (src) => {
      const out = [];
      const re = /createElement\(\s*['"]style['"]\s*\)|<style[\s>]/g;
      let m;
      while ((m = re.exec(src))) out.push(src.slice(0, m.index).split('\n').length);
      return out;
    },
    fix: 'move the rules into design-system.css',
  },
  {
    name: 'hover / active state written inline',
    // Inline styles cannot express :hover, so anything reaching for onMouseEnter
    // to repaint a surface is re-implementing what `.ds-pill` already does.
    test: (src) => {
      const out = [];
      const re = /onMouseEnter=\{[\s\S]{0,160}?(background|boxShadow|borderColor|transform)/g;
      let m;
      while ((m = re.exec(src))) out.push(src.slice(0, m.index).split('\n').length);
      return out;
    },
    fix: 'let the .ds-* class own :hover',
  },
];

const shapeRows = [];
for (const file of FILES) {
  const src = readFileSync(file, 'utf8');
  for (const shape of SHAPES) {
    for (const line of shape.test(src)) shapeRows.push({ file, line, shape });
  }
}

if (shapeRows.length) {
  console.log('\nControls that should come from a component\n');
  for (const r of shapeRows) {
    console.log(`      ${r.file}:${r.line}  ${r.shape.name}`);
    console.log(`        → ${r.shape.fix}`);
  }
} else {
  console.log('\nNo hand-rolled controls found.');
}

if (process.argv.includes('--strict') && (total > 0 || shapeRows.length > 0)) process.exit(1);
