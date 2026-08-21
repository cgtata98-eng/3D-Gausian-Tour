/**
 * 360°動画のどこでカメラが止まっているかを割り出す。
 *
 * ウォークスルーの「ノード（立ち止まる場所）」は、撮影者が実際に足を止めた区間に
 * 置くしかない。動きのある瞬間で止めると、ポーズした最後のフレームがブレた絵に
 * なって没入が切れる。手で探すと 3 分の素材で心が折れるので、機械に探させる。
 *
 * 160x90 のグレースケールに落として 1 フレームずつ平均絶対差分を取るだけ。
 * ただし equirect なので上下端（天頂・天底）は面積の割にピクセルが極端に多く、
 * わずかな回転でも差分が跳ねる。緯度で重みを付けて cos で潰す。
 *
 * 出力は Debug の「360°動画」ブロックにそのまま読ませる JSON:
 *   stills    … 静止区間（ノードを置いてよい場所。タイムラインに帯で出す）
 *   calmTimes … 止まっても絵がブレない時刻の一覧（途中ポイントの寄せ先）
 *
 *   node scripts/video360/analyze.mjs <video> [out.json]
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';
const SRC = process.argv[2];
const OUT = process.argv[3] ?? 'video360-analysis.json';
const W = 160;
const H = 90;
const FRAME_BYTES = W * H;

if (!SRC) {
  console.error('使い方: node scripts/video360/analyze.mjs <video> [out.json]');
  process.exit(1);
}

const fps = await probeFps();
const frames = await decode();
if (frames.length < 2) {
  console.error('フレームが読めませんでした');
  process.exit(1);
}

// 緯度重み: 行 y の中心緯度の cos。equirect の面積補正そのもの。
const rowWeight = Array.from({ length: H }, (_, y) => Math.cos((((y + 0.5) / H) - 0.5) * Math.PI));
const weightSum = rowWeight.reduce((a, b) => a + b, 0) * W;

const motion = [];
for (let i = 1; i < frames.length; i++) {
  const a = frames[i - 1];
  const b = frames[i];
  let acc = 0;
  for (let y = 0; y < H; y++) {
    const w = rowWeight[y];
    const base = y * W;
    let row = 0;
    for (let x = 0; x < W; x++) row += Math.abs(b[base + x] - a[base + x]);
    acc += row * w;
  }
  motion.push(acc / weightSum);
}
motion.unshift(motion[0] ?? 0);

// 5 フレーム移動平均。1 フレームだけ跳ねるノイズで区間が切れないように。
const smooth = motion.map((_, i) => {
  const lo = Math.max(0, i - 2);
  const hi = Math.min(motion.length - 1, i + 2);
  let s = 0;
  for (let j = lo; j <= hi; j++) s += motion[j];
  return s / (hi - lo + 1);
});

// しきい値は絶対値で決め打ちできない（素材ごとに露出も動きも違う）。
// 下位 20% 分位を基準に取り、そこから 18% 上までを「静止」とみなす。
const sorted = [...smooth].sort((a, b) => a - b);
const pct = (p) => sorted[Math.floor((sorted.length - 1) * p)];
const threshold = pct(0.20) + (pct(0.80) - pct(0.20)) * 0.18;

const MIN_STILL_FRAMES = Math.round(fps * 0.6);
const stills = [];
let run = -1;
for (let i = 0; i < smooth.length; i++) {
  const quiet = smooth[i] <= threshold;
  if (quiet && run < 0) run = i;
  if ((!quiet || i === smooth.length - 1) && run >= 0) {
    const end = quiet ? i : i - 1;
    if (end - run + 1 >= MIN_STILL_FRAMES) {
      // 一番動きの小さいフレームを代表点に。ポーズしたとき一番シャキッとした絵。
      let best = run;
      for (let j = run; j <= end; j++) if (smooth[j] < smooth[best]) best = j;
      stills.push({
        start: +(run / fps).toFixed(3),
        end: +(end / fps).toFixed(3),
        rest: +(best / fps).toFixed(3),
      });
    }
    run = -1;
  }
}

// 途中で足を止めてよい時刻。局所的な極小値だけを抜く。
// フレームごとの動き量をまるごと持つと 8K・数分で数千要素になるので持たない。
const calmTimes = [];
for (let i = 2; i < smooth.length - 2; i++) {
  if (smooth[i] <= smooth[i - 1] && smooth[i] <= smooth[i + 1]
    && smooth[i] < smooth[i - 2] && smooth[i] < smooth[i + 2]) {
    const t = +(i / fps).toFixed(3);
    // 0.2 秒より近い候補は間引く。密に持っても寄せ先は変わらない。
    if (calmTimes.length === 0 || t - calmTimes[calmTimes.length - 1] > 0.2) calmTimes.push(t);
  }
}

const result = {
  source: SRC,
  fps,
  frameCount: smooth.length,
  duration: +(smooth.length / fps).toFixed(3),
  threshold: +threshold.toFixed(4),
  stills,
  calmTimes,
};
await writeFile(OUT, JSON.stringify(result, null, 2));

console.log(`${SRC}`);
console.log(`  ${result.duration}s / ${result.frameCount}frames @ ${fps}fps`);
console.log(`  静止区間 ${stills.length} / 停止してよい時刻 ${calmTimes.length}`);
for (const s of stills) {
  console.log(`    ${s.start.toFixed(2)}s - ${s.end.toFixed(2)}s  → ノードは rest=${s.rest.toFixed(2)}s に置く`);
}
console.log(`  → ${OUT}`);

function probeFps() {
  return new Promise((res, rej) => {
    const p = spawn(FFPROBE, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate', '-of', 'default=nw=1:nk=1', SRC,
    ], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', rej);
    p.on('close', () => {
      const [n, d] = out.trim().split('/').map(Number);
      const v = d ? n / d : n;
      res(Number.isFinite(v) && v > 0 ? Math.round(v) : 30);
    });
  });
}

function decode() {
  return new Promise((res, rej) => {
    const p = spawn(FFMPEG, [
      '-v', 'error', '-i', SRC, '-an',
      '-vf', `scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-',
    ], { windowsHide: true });
    const out = [];
    let pending = Buffer.alloc(0);
    p.stdout.on('data', (d) => {
      pending = pending.length ? Buffer.concat([pending, d]) : d;
      while (pending.length >= FRAME_BYTES) {
        out.push(pending.subarray(0, FRAME_BYTES));
        pending = pending.subarray(FRAME_BYTES);
      }
    });
    p.on('error', () => rej(new Error(`ffmpeg を起動できません。FFMPEG_PATH を設定してください`)));
    p.on('close', (c) => (c === 0 ? res(out) : rej(new Error(`ffmpeg exited ${c}`))));
  });
}
