/**
 * 360°動画から「どこで止めるか」「どこに扉があるか」を出して、取り込み用の案を書き出す。
 *
 * ## なぜ動き量で決まるのか
 *
 * ノードは「止まっても絵がブレない時刻」に置く必要がある。歩行中のフレームで止めると
 * ブレた絵が貼りっぱなしになって没入が切れる。CG レンダリングでも同じで、カメラが
 * 動いているコマはモーションブラーが乗っている。だからフレーム間の動き量を実測して、
 * 谷 (= カメラが止まっている区間) を探す。
 *
 * 扉も同じ計測から落ちてくる。**カメラが止まっているのに絵が変わり続ける区間**は、
 * 世界の中で何かが動いているということで、この手の物件動画ではそれは扉しかない。
 * 動きが集中している列と行から、equirect の座標 → 向きに直す。
 *
 * ## equirect の列 → 向き
 *
 * スカイのシェーダ (`equirect-skybox.ts`) は
 *   `lon = atan(dir.x, dir.z)` / `u = lon / 2PI + 0.5` / `v = 1 - (lat / PI + 0.5)`
 * ビューアの向きは PlayCanvas 準拠で `dir = (-sin(yaw), sin(pitch), -cos(yaw))`。
 * 突き合わせると `lon = yaw + 180°`、つまり **yaw = 360 * x / W**、
 * **pitch = 90 - 180 * y / H**。ここは推測ではなく式から出ている。
 *
 * ## 使い方
 *
 *   node scripts/video360/plan-walk.mjs --video <mp4|webm> [--nodes even:10|stills]
 *                                       [--out <dir>] [--publish <sceneId>]
 *
 *   --nodes even:N  尺を N 等分して N+1 ポイント (既定)。それぞれ **近くの静止コマに寄せる** ―
 *                   等分点をそのまま使うと歩行中のブレたコマで止まることになる。
 *   --nodes stills  検出した静止区間そのものにポイントを置く。数は素材まかせ。
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const VIDEO = arg('video');
const TRACK_CSV = arg('track');
/** 動画の先頭を何コマ落としたか。CSV は元のレンダー全長ぶんあるので、その分ずらす。 */
const TRACK_OFFSET = Number(arg('track-offset', '0'));
const NODES = arg('nodes', 'even:10');
const OUT_DIR = arg('out', path.dirname(VIDEO ?? '.'));
const PUBLISH = arg('publish');
const HOST = arg('host', 'https://cg-rooms.com');

if (!VIDEO || !existsSync(VIDEO)) {
  console.error('必須: --video <mp4|webm>');
  process.exit(1);
}

// 解析用の解像度。元が 6000x3000 でもここは小さくてよい ― 見ているのは
// 「動いたかどうか」で、細部ではない。大きくすると読み込みだけで数分かかる。
const W = 256;
const H = 128;
const N = W * H;

/** 静止と見なす動き量 (最大値に対する比)。 */
const STILL_RATIO = 0.12;
/** 静止区間として採るのに必要な最短の長さ (フレーム)。 */
const MIN_STILL_FRAMES = 6;
/** 扉と見なすのに必要な、静止区間の中の残り動き (平均) と長さ (秒)。 */
const DOOR_MIN_MOTION = 0.5;
const DOOR_MIN_SECONDS = 0.5;
/** 扉からこれ以上離れたポイントしか無ければ、扉の前にポイントを足す (秒)。 */
const DOOR_NODE_MAX_SEC = 0.5;

const run = (cmd, a) => new Promise((res, rej) => {
  const p = spawn(cmd, a, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.on('error', rej);
  p.on('close', (c) => (c === 0 ? res() : rej(new Error(`${cmd} exit ${c}\n${err.slice(-1500)}`))));
});

async function probe(file) {
  const out = await new Promise((res, rej) => {
    const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate,width,height', '-show_entries', 'format=duration',
      '-of', 'json', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let s = '';
    p.stdout.on('data', (d) => { s += d; });
    p.on('error', rej);
    p.on('close', () => res(s));
  });
  const j = JSON.parse(out);
  const [num, den] = j.streams[0].r_frame_rate.split('/').map(Number);
  return { fps: num / den, duration: Number(j.format.duration) };
}

const info = await probe(VIDEO);
console.log(`素材: ${path.basename(VIDEO)}  ${info.duration.toFixed(3)}s @ ${info.fps.toFixed(3)}fps`);

// ── 1. グレースケールで全フレームを読む ────────────────────────────────────
const tmp = path.join(os.tmpdir(), `walkplan-${process.pid}.raw`);
console.log('動き量を計測中…');
await run('ffmpeg', ['-v', 'error', '-y', '-i', VIDEO, '-vf', `scale=${W}:${H}`,
  '-pix_fmt', 'gray', '-f', 'rawvideo', tmp]);
const buf = await readFile(tmp);
const frames = Math.floor(buf.length / N);
const fps = info.fps;
const tOf = (f) => +(f / fps).toFixed(3);

// ── 2. フレーム間の動き量 ──────────────────────────────────────────────────
const diffs = new Float64Array(frames - 1);
for (let f = 1; f < frames; f++) {
  let s = 0;
  const a = f * N;
  const b = (f - 1) * N;
  for (let i = 0; i < N; i++) { const d = buf[a + i] - buf[b + i]; s += d < 0 ? -d : d; }
  diffs[f - 1] = s / N;
}
const maxDiff = Math.max(...diffs);
const stillTh = maxDiff * STILL_RATIO;

// ── 3. 静止区間 ────────────────────────────────────────────────────────────
const stills = [];
let run0 = null;
for (let i = 0; i < diffs.length; i++) {
  if (diffs[i] < stillTh) { if (!run0) run0 = { s: i, e: i }; else run0.e = i; }
  else { if (run0 && run0.e - run0.s + 1 >= MIN_STILL_FRAMES) stills.push(run0); run0 = null; }
}
if (run0 && run0.e - run0.s + 1 >= MIN_STILL_FRAMES) stills.push(run0);

/** 区間の中で一番動きの小さいコマ。ここで止めるのが一番ブレない。 */
const restOf = (r) => {
  let best = r.s;
  for (let i = r.s; i <= r.e; i++) if (diffs[i] < diffs[best]) best = i;
  return best;
};

// ── 4. 静止区間の中の「残り動き」= 扉 ──────────────────────────────────────
/**
 * カメラが止まっているのに絵が変わる区間を探し、動きが集中している場所を出す。
 *
 * 中心 (重心) ではなく **山の頂上** を使う。カメラがわずかに漂うと画面全体が薄く
 * 変化し、重心は画面中央へ引っ張られて意味を失う。頂上の周りだけを見れば、
 * 漂いに埋もれずに動いている物そのものを指せる。
 */
function analyzeSegment(r) {
  const colE = new Float64Array(W);
  const rowE = new Float64Array(H);
  let total = 0;
  for (let f = r.s + 1; f <= r.e; f++) {
    const a = f * N;
    const b = (f - 1) * N;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d = Math.abs(buf[a + y * W + x] - buf[b + y * W + x]);
        if (d > 8) { colE[x] += d; rowE[y] += d; total += d; }
      }
    }
  }
  const seconds = (r.e - r.s + 1) / fps;
  let motion = 0;
  for (let i = r.s; i <= r.e; i++) motion += diffs[i];
  motion /= (r.e - r.s + 1);

  // 列は円環。頂上の周りを ±10% の窓で見る (equirect の端をまたいでも切れない)。
  const smooth = new Float64Array(W);
  const k = 4;
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let d = -k; d <= k; d++) s += colE[(x + d + W) % W];
    smooth[x] = s;
  }
  let peak = 0;
  for (let x = 1; x < W; x++) if (smooth[x] > smooth[peak]) peak = x;
  const win = Math.round(W * 0.1);
  let num = 0;
  let den = 0;
  let inWin = 0;
  for (let d = -win; d <= win; d++) {
    const x = (peak + d + W) % W;
    num += colE[x] * d;
    den += colE[x];
    inWin += colE[x];
  }
  const cx = den > 0 ? (peak + num / den + W) % W : peak;
  // 行は円環ではない。窓の中の重心をそのまま使う。
  let ry = 0;
  let rd = 0;
  for (let y = 0; y < H; y++) { ry += rowE[y] * y; rd += rowE[y]; }
  const cy = rd > 0 ? ry / rd : H / 2;

  return {
    seconds,
    motion: +motion.toFixed(3),
    energy: Math.round(total),
    /** 山の周りに集まっているエネルギーの割合。低いと画面全体の漂い。 */
    focus: total > 0 ? +(inWin / total).toFixed(3) : 0,
    // 式は冒頭のコメントのとおり。推測ではない。
    yaw: +(((cx / W) * 360) % 360).toFixed(1),
    pitch: +(90 - (cy / H) * 180).toFixed(1),
  };
}

const segments = stills.map((r) => {
  const a = analyzeSegment(r);
  return {
    from: tOf(r.s), to: tOf(r.e), rest: tOf(restOf(r)),
    frames: [r.s, r.e],
    ...a,
    isDoor: a.seconds >= DOOR_MIN_SECONDS && a.motion >= DOOR_MIN_MOTION,
  };
});

console.log(`\n静止区間 ${segments.length} 個 (最大動き ${maxDiff.toFixed(1)} / しきい ${stillTh.toFixed(2)})`);
for (const s of segments) {
  console.log(`  ${s.from.toFixed(2)}-${s.to.toFixed(2)}s (${s.seconds.toFixed(2)}s)  `
    + `残り動き ${s.motion.toFixed(2)}  集中 ${(s.focus * 100).toFixed(0)}%  `
    + (s.isDoor ? `🚪 扉 yaw ${s.yaw}° pitch ${s.pitch}°` : '静止のみ'));
}

// ── 5. ノードを決める ──────────────────────────────────────────────────────
/** 狙った時刻の近くで、一番動きの小さいコマに寄せる。 */
function snapToCalm(t, radiusSec = 0.7) {
  const c = Math.round(t * fps);
  const r = Math.round(radiusSec * fps);
  let best = Math.max(0, Math.min(diffs.length - 1, c));
  for (let i = Math.max(0, c - r); i <= Math.min(diffs.length - 1, c + r); i++) {
    if (diffs[i] < diffs[best]) best = i;
  }
  return best;
}

let nodeTimes = [];
let mode = NODES;
if (NODES.startsWith('even:')) {
  const n = Number(NODES.slice(5));
  if (!(n >= 1)) throw new Error(`--nodes even:N の N が読めません: ${NODES}`);
  // 両端を含めて N+1 点。最後の部屋にも立てるため。
  const raw = Array.from({ length: n + 1 }, (_, i) => (info.duration * i) / n);
  nodeTimes = raw.map((t) => {
    const f = snapToCalm(t);
    return { t: tOf(f), wanted: +t.toFixed(3), movedBy: +(Math.abs(f / fps - t)).toFixed(3) };
  });
} else {
  mode = 'stills';
  nodeTimes = segments.map((s) => ({ t: s.rest, wanted: s.rest, movedBy: 0 }));
}
/**
 * 扉の前に立てる場所が無ければ足す。
 *
 * 扉の印は「そこに立ったときだけ」出す。だから扉のそばにポイントが無いと、
 * 開けに行けない扉ができるか、遠くのポイントに紐づいて壁の中に印が浮く。
 * 実測では 5 等分だと 2 つの扉が 3.8m / 7.6m 離れたポイントに付いた。
 *
 * 等分の指定を勝手に増やすことになるが、立てない扉を残すよりはいい。
 * `--no-door-nodes` で切れる。
 */
if (!argv.includes('--no-door-nodes')) {
  const added = [];
  for (const seg of segments.filter((x) => x.isDoor)) {
    const mid = (seg.from + seg.to) / 2;
    const near = nodeTimes.reduce((b, n) => (Math.abs(n.t - mid) < Math.abs(b.t - mid) ? n : b), nodeTimes[0]);
    const gap = near.t < seg.from ? seg.from - near.t : near.t > seg.to ? near.t - seg.to : 0;
    if (gap > DOOR_NODE_MAX_SEC) {
      nodeTimes.push({ t: seg.rest, wanted: seg.rest, movedBy: 0, forDoor: true });
      added.push(seg.rest);
    }
  }
  if (added.length) {
    console.log(`
扉の前に立つポイントを ${added.length} 個足しました: `
      + added.map((t) => `${t.toFixed(2)}s`).join(', '));
  }
}

// 同じコマに落ちたものは畳む。同じ絵で止まる 2 地点に意味が無い。
const seen = new Set();
nodeTimes = nodeTimes.filter((n) => (seen.has(n.t) ? false : (seen.add(n.t), true)))
  .sort((a, b) => a.t - b.t);

const nodes = nodeTimes.map((n, i) => ({
  index: i + 1, label: `ポイント ${i + 1}`, t: n.t, wanted: n.wanted, movedBy: n.movedBy,
  ...(n.forDoor ? { forDoor: true } : {}),
}));
const edges = [];
for (let i = 0; i + 1 < nodes.length; i++) {
  edges.push({ from: i + 1, to: i + 2, range: [nodes[i].t, nodes[i + 1].t] });
}

// ── 6. 扉をノードに紐づける ────────────────────────────────────────────────
// 扉は「そこから開ける」ものなので、どのノードに属すかを決める必要がある。
// 扉が動いている最中に一番近くで止まっているノードが答え。
const doors = segments.filter((s) => s.isDoor).map((s, i) => {
  let near = nodes[0];
  let bestD = Infinity;
  for (const n of nodes) {
    const d = n.t < s.from ? s.from - n.t : n.t > s.to ? n.t - s.to : 0;
    if (d < bestD) { bestD = d; near = n; }
  }
  return {
    index: i + 1,
    label: `扉 ${i + 1}`,
    range: [s.from, s.to],
    yaw: s.yaw,
    pitch: s.pitch,
    node: near.index,
    distanceSec: +bestD.toFixed(3),
  };
});

console.log(`\nノード ${nodes.length} 個 (${mode})`);
for (const n of nodes) {
  console.log(`  ${String(n.index).padStart(2)}  ${n.t.toFixed(2)}s`
    + (n.forDoor ? '  (扉の前)' : '')
    + (n.movedBy > 0.001 ? `  (等分点 ${n.wanted.toFixed(2)}s から ${n.movedBy.toFixed(2)}s 寄せた)` : ''));
}
console.log(`\n扉 ${doors.length} 個`);
for (const d of doors) {
  console.log(`  ${d.label}  ${d.range[0].toFixed(2)}-${d.range[1].toFixed(2)}s  `
    + `yaw ${d.yaw}° pitch ${d.pitch}°  → ポイント ${d.node}`
    + (d.distanceSec > 0 ? ` (${d.distanceSec.toFixed(2)}s 離れている)` : ''));
}

// ── カメラ軌跡 (SphereAlign の CSV) ────────────────────────────────────────
/**
 * 3ds Max の書き出しをビューアの座標系に直す。
 *
 * Max は **Z-up 右手系**、ビューア (PlayCanvas) は **Y-up 右手系**。
 * `(x, y, z)_max → (x, z, -y)_pc` で右手系のまま倒せる。単位は mm → m。
 *
 * yaw はカメラのローカル -Z (Max の見ている向き) から出す。PlayCanvas は
 * `dir = (-sin yaw, sin pitch, -cos yaw)` なので `yaw = atan2(-dir.x, -dir.z)`。
 *
 * CSV は元のレンダー全長ぶんある。動画の先頭を削っているなら、その分だけ
 * 頭を捨てないとフレーム番号が 1 対 1 にならない ― ここがずれると、ポイントが
 * 隣の部屋の座標に置かれる。
 */
function parseTrackCsv(text, offset) {
  const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const head = lines[0].split(',').map((h) => h.trim());
  const col = (n) => head.indexOf(n);
  const [iPx, iPy, iPz] = ['px', 'py', 'pz'].map(col);
  const [iZx, iZy, iZz] = ['zx', 'zy', 'zz'].map(col);
  if (iPx < 0 || iZx < 0) throw new Error('CSV に px/py/pz/zx/zy/zz の列がありません');

  const rows = lines.slice(1).map((l) => l.split(',').map(Number));
  const used = rows.slice(offset);
  const samples = used.map((r) => {
    const x = r[iPx] / 1000;
    const y = r[iPy] / 1000;
    const z = r[iPz] / 1000;
    // Max のカメラは局所 -Z を見ている。
    const fx = -r[iZx];
    const fy = -r[iZy];
    const fz = -r[iZz];
    // Max → PlayCanvas
    const px = x, py = z, pz = -y;
    const dx = fx, dz = -fy;
    const yaw = (Math.atan2(-dx, -dz) * 180) / Math.PI;
    return [+px.toFixed(4), +py.toFixed(4), +pz.toFixed(4), +(((yaw % 360) + 360) % 360).toFixed(2)];
  });
  return { totalRows: rows.length, samples };
}

let track = null;
if (TRACK_CSV) {
  if (!existsSync(TRACK_CSV)) throw new Error(`軌跡 CSV が見つかりません: ${TRACK_CSV}`);
  const parsed = parseTrackCsv(await readFile(TRACK_CSV, 'utf8'), TRACK_OFFSET);
  track = { source: path.basename(TRACK_CSV), fps: +fps.toFixed(6), unitScale: 1, samples: parsed.samples };
  console.log(`\n軌跡: ${path.basename(TRACK_CSV)}  ${parsed.totalRows} 行 − 先頭 ${TRACK_OFFSET} = ${parsed.samples.length} サンプル`);
  if (parsed.samples.length !== frames) {
    console.log(`  ⚠ 動画は ${frames} フレーム。サンプル数と合っていません`);
    console.log(`     --track-offset を ${parsed.totalRows - frames} にすると一致します`);
  } else {
    console.log('  ✅ 動画のフレーム数と一致');
  }
  const at = (t) => parsed.samples[Math.max(0, Math.min(parsed.samples.length - 1, Math.round(t * fps)))];
  for (const n of nodes) {
    const s2 = at(n.t);
    if (!s2) continue;
    n.position = [s2[0], s2[1], s2[2]];
    n.mapPosition = [s2[0], s2[2]];
    n.yaw = s2[3];
  }
  for (const d of doors) {
    const s2 = at((d.range[0] + d.range[1]) / 2);
    if (s2) d.cameraAt = [s2[0], s2[1], s2[2]];
  }
  console.log('\nポイントの位置 (m)');
  for (const n of nodes) {
    console.log(`  ${String(n.index).padStart(2)}  ${n.t.toFixed(2)}s  `
      + `x ${n.position[0].toFixed(2)}  y ${n.position[1].toFixed(2)}  z ${n.position[2].toFixed(2)}`);
  }
}

const plan = {
  source: path.basename(VIDEO),
  fps: +fps.toFixed(6),
  duration: +info.duration.toFixed(4),
  frames,
  mode,
  nodes,
  edges,
  doors,
  ...(track ? { track } : {}),
  /** 検出した静止区間そのもの。Debug のタイムラインに帯で出す。 */
  stills: segments.map((s) => ({ start: s.from, end: s.to, rest: s.rest })),
  /** 止まっても絵がブレない時刻。ポイントを動かすときの吸着先。 */
  calmTimes: segments.map((s) => s.rest),
};

await mkdir(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, 'video360-walk-plan.json');
await writeFile(outPath, JSON.stringify(plan, null, 2), 'utf8');
console.log(`\n書き出し: ${outPath}`);

// ── 7. R2 へ ───────────────────────────────────────────────────────────────
if (PUBLISH) {
  const creds = await readFile(new URL('../../src/shared/admin-credentials.ts', import.meta.url), 'utf8');
  const user = creds.match(/ADMIN_USERNAME\s*=\s*'([^']+)'/)?.[1];
  const pass = creds.match(/ADMIN_PASSWORD\s*=\s*'([^']+)'/)?.[1];
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const body = await readFile(outPath);
  const res = await fetch(`${HOST}/api/publish/${PUBLISH}/video360-walk-plan.json`, {
    method: 'PUT',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) throw new Error(`アップロード失敗: ${res.status} ${await res.text()}`);
  console.log(`アップロード: ${HOST}/api/publish/${PUBLISH}/video360-walk-plan.json  (${(await stat(outPath)).size} bytes)`);
}

console.log('\nビューアの Debug > 360°動画 > 「ウォークスルー案を取り込む」から読み込んでください。');
