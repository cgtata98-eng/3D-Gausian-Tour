// Sync `@mediapipe/tasks-vision/wasm` from node_modules to `public/mediapipe/wasm`
// so the head tracker (`src/utils/head-tracker.ts`) loads version-matched WASM.
// Re-run after `npm install` if @mediapipe/tasks-vision is updated.
//
//   node scripts/copy-mediapipe-wasm.mjs
import { cpSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = resolve(__dirname, '..', 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const dst = resolve(__dirname, '..', 'public', 'mediapipe', 'wasm');

if (!existsSync(src)) {
  console.error(`[copy-mediapipe-wasm] source not found: ${src}`);
  console.error('Run `npm install` first.');
  process.exit(1);
}
if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log(`[copy-mediapipe-wasm] ${src} → ${dst}`);
