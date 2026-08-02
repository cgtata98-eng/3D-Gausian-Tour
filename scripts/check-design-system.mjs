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

/** Legitimate exceptions — genuinely not design-system surfaces. */
const ALLOW = [
  // Canvas painting and SVG attributes are not CSS surfaces.
  /ctx\./,
  // Directional borders are separators, not surface outlines.
  /border(Top|Bottom|Left|Right)(Color|Width|Style)?:/,
  // Thumbnails and 3D backdrops are content, not chrome.
  /THUMB_GRAD|gradient\(.*deg.*#(cdd|d8d|c39)/,
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

if (process.argv.includes('--strict') && total > 0) process.exit(1);
