// Convert a PLY 3D-Gaussian-Splat to SPZ using @sparkjsdev/spark's transcodeSpz.
// SPZ is Niantic's compressed format — typically ~10-20x smaller than PLY and
// loads dramatically faster. Run with:
//   node --max-old-space-size=8192 scripts/convert-ply-to-spz.mjs <input.ply> [output.spz]
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname, basename, extname } from 'node:path';

// Spark's bundle references `self` at module load (for its Worker setup helper).
// Node has no `self`; alias it to globalThis so the `typeof self !== "undefined"`
// check passes and `self.Blob` resolves (Node 18+ has Blob built-in). The Worker
// path is only invoked when rendering, not during transcodeSpz, so this is safe.
globalThis.self = globalThis;

const argv = process.argv.slice(2);
if (argv.length < 1) {
  console.error('usage: node scripts/convert-ply-to-spz.mjs <input.ply> [output.spz]');
  process.exit(1);
}
const inputPath = resolve(argv[0]);
const outputPath = resolve(
  argv[1] ?? `${dirname(inputPath)}/${basename(inputPath, extname(inputPath))}.spz`
);

const t0 = performance.now();
const inStat = await stat(inputPath);
console.log(`reading ${inputPath} (${(inStat.size / 1048576).toFixed(1)} MB)...`);
const buf = await readFile(inputPath);
const fileBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
console.log(`read in ${((performance.now() - t0) / 1000).toFixed(1)}s, transcoding...`);

const { transcodeSpz, SplatFileType } = await import('@sparkjsdev/spark');

const t1 = performance.now();
const result = await transcodeSpz({
  inputs: [{ fileBytes, fileType: SplatFileType.PLY, pathOrUrl: inputPath }],
});
const dt = ((performance.now() - t1) / 1000).toFixed(1);

await writeFile(outputPath, result.fileBytes);
const outStat = await stat(outputPath);
const ratio = (inStat.size / outStat.size).toFixed(2);
console.log(
  `done in ${dt}s — ${outputPath} (${(outStat.size / 1048576).toFixed(1)} MB, ${ratio}x smaller)`
);
