// CLI over ffmpeg.mjs — the post-render half of the pipeline.
//
//   node scripts/render/convert.mjs stills [renderRoot] [--format=webp] [--quality=88] [--width=4096]
//   node scripts/render/convert.mjs video <framesDir> <outDir> <name> [--fps=30] [--crf=18]
//
// `stills`: render/**/*.png  →  web/**/*.jpg   (masters are never touched, so a
//           quality change later costs one command instead of one night)
// `video` : a rendered frame folder → <name>_open.mp4 AND <name>_close.mp4
//           (the reverse clip is the same frames back-to-front — no re-render)
import { join, resolve } from 'node:path';
import { convertStills, encodePair } from './ffmpeg.mjs';

const argv = process.argv.slice(2);
const mode = argv[0];
const positional = argv.slice(1).filter((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

if (mode === 'stills') {
  const root = resolve(positional[0] ?? 'render');
  const format = flag('format', 'jpg');
  const width = flag('width') ? Number(flag('width')) : undefined;
  const quality = flag('quality') ? Number(flag('quality')) : undefined;
  const srcDir = join(root, flag('src', '.'));
  const outDir = join(root, flag('out', 'web'));

  console.log(`converting ${srcDir} → ${outDir} (${format}${width ? `, ${width}px wide` : ''})`);
  const t0 = Date.now();
  const n = await convertStills({
    srcDir, outDir, format, quality, width,
    concurrency: Number(flag('concurrency', 4)),
    onProgress: (done, total) => process.stdout.write(`\r  ${done}/${total}   `),
  });
  console.log(`\ndone — ${n} images in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} else if (mode === 'video') {
  const [framesDir, outDir, name] = positional;
  if (!framesDir || !outDir || !name) {
    console.error('usage: node scripts/render/convert.mjs video <framesDir> <outDir> <name>');
    process.exit(1);
  }
  const { open, close } = await encodePair({
    framesDir: resolve(framesDir), outDir: resolve(outDir), name,
    fps: Number(flag('fps', 30)), crf: Number(flag('crf', 18)), preset: flag('preset', 'slow'),
  });
  console.log(`${open.out}  (${open.frames} frames)`);
  console.log(`${close.out}  (${close.frames} frames, reversed)`);
} else {
  console.error('usage: node scripts/render/convert.mjs <stills|video> ...');
  process.exit(1);
}
