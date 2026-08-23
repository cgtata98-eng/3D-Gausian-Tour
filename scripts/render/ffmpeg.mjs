// ffmpeg wrappers for the panorama pipeline.
//
// Two jobs:
//   1. Convert the PNG masters Vantage produces into web-sized JPEG / WebP for R2.
//      The PNGs stay on disk, so re-deriving at a different quality later never
//      costs a re-render.
//   2. Encode door-open / day-night panorama clips from a rendered frame folder,
//      forward AND reversed.
//
// Reversal deliberately does NOT use `-vf reverse`: that filter buffers every
// decoded frame uncompressed, and a 4K equirect sequence is ~24 MB/frame, so a
// 3-second clip needs multiple GB and falls over. Feeding the concat demuxer a
// list of the same source frames in reverse order costs nothing extra.
import { spawn } from 'node:child_process';
import { mkdir, readdir, writeFile, unlink } from 'node:fs/promises';
import { dirname, extname, join, resolve, basename } from 'node:path';

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.exr']);

export function run(args, { label = 'ffmpeg' } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(FFMPEG, args, { windowsHide: true });
    let stderr = '';
    // ffmpeg writes progress to stderr; keep only the tail so a failure message
    // is readable and a success never holds megabytes of log in memory.
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (e) => reject(new Error(`${label}: cannot start ffmpeg (${e.message}). Set FFMPEG_PATH if it is not on PATH.`)));
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${label}: ffmpeg exited ${code}\n${stderr}`));
    });
  });
}

/** Sorted image files in a directory (name order — Vantage numbers sequentially). */
export async function listFrames(dir) {
  const names = await readdir(dir);
  return names
    .filter((n) => IMAGE_EXT.has(extname(n).toLowerCase()))
    .sort()
    .map((n) => join(dir, n));
}

// ── Stills → web format ──────────────────────────────────────────────────────

/**
 * Convert every image under `srcDir` (recursively) into `outDir`, mirroring the
 * directory layout. `quality` is ffmpeg's `-q:v` for JPEG (2 = best, 5 ≈ visually
 * clean) or `-quality` for WebP (0-100).
 */
export async function convertStills({
  srcDir, outDir, format = 'jpg', quality, width, concurrency = 4, onProgress,
}) {
  const jobs = [];
  await walk(resolve(srcDir), '');
  async function walk(dir, rel) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(abs, join(rel, entry.name)); continue; }
      if (!IMAGE_EXT.has(extname(entry.name).toLowerCase())) continue;
      jobs.push({ src: abs, out: join(resolve(outDir), rel, `${basename(entry.name, extname(entry.name))}.${format}`) });
    }
  }

  let done = 0;
  const total = jobs.length; // captured before the pool drains `jobs`
  const pool = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    for (;;) {
      const job = jobs.pop();
      if (!job) return;
      await mkdir(dirname(job.out), { recursive: true });
      const args = ['-y', '-i', job.src];
      if (width) args.push('-vf', `scale=${width}:-2:flags=lanczos`);
      if (format === 'webp') args.push('-quality', String(quality ?? 88));
      else args.push('-q:v', String(quality ?? 3));
      args.push(job.out);
      await run(args, { label: basename(job.src) });
      onProgress?.(++done, total);
    }
  });
  await Promise.all(pool);
  return done;
}

// ── Frame sequence → mp4 ─────────────────────────────────────────────────────

/**
 * Encode `framesDir` into an H.264 mp4. `reverse: true` emits the same frames
 * back-to-front — that is how the door-close clip is produced without ever
 * re-rendering it in 3ds Max.
 *
 * libx264 rather than NVENC: these clips are ~90 frames, so encode time is
 * seconds either way and x264 gives noticeably cleaner output at the same size.
 * yuv420p + faststart because the result is played by a browser <video>.
 */
export async function encodeSequence({
  framesDir, out, fps = 30, crf = 18, preset = 'slow', reverse = false, codec = 'libx264',
}) {
  const frames = await listFrames(framesDir);
  if (!frames.length) throw new Error(`no image frames in ${framesDir}`);
  const ordered = reverse ? [...frames].reverse() : frames;

  // concat demuxer list. Forward slashes + single quotes work on Windows too;
  // ffmpeg resolves each entry independently so absolute paths are fine.
  const listPath = join(dirname(resolve(out)), `.concat-${basename(out)}.txt`);
  const dur = (1 / fps).toFixed(6);
  const lines = ordered.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'\nduration ${dur}`);
  // The concat demuxer ignores the final entry's `duration`, so the last frame
  // would be dropped. Repeating the file supplies it — and `-frames:v` below then
  // trims the padding back off, giving exactly `ordered.length` frames. Without
  // the trim this idiom yields N+1 frames, which makes an open/close pair land on
  // a duplicated frame and stutter at the moment the door finishes moving.
  lines.push(`file '${ordered.at(-1).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);

  await mkdir(dirname(resolve(out)), { recursive: true });
  await writeFile(listPath, lines.join('\n') + '\n');
  try {
    await run([
      '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-r', String(fps), '-frames:v', String(ordered.length),
      '-c:v', codec, '-crf', String(crf), '-preset', preset,
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', resolve(out),
    ], { label: basename(out) });
  } finally {
    await unlink(listPath).catch(() => {});
  }
  return { out: resolve(out), frames: ordered.length };
}

/** Both directions from one rendered sequence — `<name>_open.mp4` / `<name>_close.mp4`. */
export async function encodePair({ framesDir, outDir, name, ...opts }) {
  const open = await encodeSequence({ framesDir, out: join(outDir, `${name}_open.mp4`), ...opts });
  const close = await encodeSequence({ framesDir, out: join(outDir, `${name}_close.mp4`), reverse: true, ...opts });
  return { open, close };
}
