/**
 * 360°動画ウォークスルーのバリアント素材を作る。
 *
 * 同じカメラ軌跡を家具あり / 家具なし / 夜で描き分けた動画を受け取り、web で配れる
 * webm に揃えて、取り込み用の `video360-variants.json` を書き出す。R2 への
 * アップロードまでここで済ませられる。
 *
 * ## なぜフレーム一致が絶対条件なのか
 *
 * 切替は「再生位置を保ったまま <video> の中身を差し替える」だけで成立させている。
 * ノード時刻・エッジ区間・カメラ軌跡を 3 本ぶん持たずに 1 組で使い回せるのはこの
 * ためで、1 フレームでもズレると切り替えた瞬間に別の場所へ飛ぶ。ズレたまま気付か
 * ないのが一番まずいので、変換後に総フレーム数を突き合わせて違えば異常終了する。
 *
 * ## なぜ AV1 なのか
 *
 * 6000x3000 の実測 (23.4 秒換算): AV1 crf32 で約 81MB / 変換 2.5 分、VP9 crf32 で
 * 約 139MB / 3 分。同画質で 6 割の容量。GOP は 15 と 60 で容量が変わらなかったので
 * (どちらも 81MB)、シークの速い 15 を無条件で採る — このモードは「ノードの時刻へ飛ぶ」
 * のが体験そのものなので、キーフレーム間隔がそのまま操作感になる。
 *
 * ## 使い方
 *
 *   node scripts/video360/build-variants.mjs \
 *     --in  "C:/Users/takyu/Desktop/3dsmax/2026/mansyon_A/video" \
 *     --map "on_day=A.00000.mp4,off_day=B.00000.mp4,on_night=C.00000.mp4" \
 *     --trim-frames 3 \
 *     --out web
 *
 * 主なオプション:
 *   --trim-frames N   先頭 N コマを捨てる (既定 0)。全バリアントに同じだけ効く。
 *   --crf N           既定 32。上げるほど軽く、荒くなる。
 *   --preset N        SVT-AV1 のプリセット。既定 6。小さいほど遅くて高画質。
 *   --codec av1|vp9   既定 av1。
 *   --reverse         逆歩き用の反転素材も作る (時間もサイズも倍になる)。
 *   --publish <id>    出来たものを R2 の <id>/ 配下へアップロードする。
 *   --only <keys>     カンマ区切り。指定したキーだけ作り直す。
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// ── 引数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const IN_DIR = arg('in');
const MAP = arg('map');
const OUT_REL = arg('out', 'web');
const TRIM_FRAMES = Number(arg('trim-frames', '0'));
const CRF = Number(arg('crf', '32'));
const PRESET = Number(arg('preset', '6'));
const CODEC = arg('codec', 'av1');
const GOP = Number(arg('gop', '15'));
const WANT_REVERSE = flag('reverse');
const PUBLISH_SCENE = arg('publish');
const ONLY = arg('only');

if (!IN_DIR || !MAP) {
  console.error('必須: --in <素材フォルダ> --map "<key>=<file>,..."');
  console.error('例:   --map "on_day=A.00000.mp4,off_day=B.00000.mp4,on_night=C.00000.mp4"');
  process.exit(1);
}
if (!Number.isInteger(TRIM_FRAMES) || TRIM_FRAMES < 0) {
  console.error(`--trim-frames は 0 以上の整数で指定してください (受け取った値: ${arg('trim-frames')})`);
  process.exit(1);
}

/**
 * バリアントキーの意味。既存の `${furniture}_${lighting}` (splatVariants / ui-store の
 * FurnitureMode x LightingMode) と同じ綴りに揃える。ビューアの家具・照明トグルが
 * そのままこのキーを引ければ、対応表を別に持たなくて済む。
 */
const KNOWN = {
  on_day: { label: '通常', furniture: 'on', lighting: 'day' },
  off_day: { label: '家具なし', furniture: 'off', lighting: 'day' },
  on_night: { label: '夜', furniture: 'on', lighting: 'night' },
  off_night: { label: '家具なし・夜', furniture: 'off', lighting: 'night' },
};

const entries = MAP.split(',').map((pair) => {
  const [key, file] = pair.split('=');
  if (!key || !file) throw new Error(`--map の書式が不正です: "${pair}" (key=file.mp4 の形)`);
  if (!KNOWN[key]) {
    throw new Error(`未知のキー "${key}"。使えるのは: ${Object.keys(KNOWN).join(' / ')}`);
  }
  return { key, file: file.trim(), ...KNOWN[key] };
});

const onlyKeys = ONLY ? new Set(ONLY.split(',').map((s) => s.trim())) : null;

const OUT_DIR = path.isAbsolute(OUT_REL) ? OUT_REL : path.join(IN_DIR, OUT_REL);
await mkdir(OUT_DIR, { recursive: true });

// ── ffmpeg / ffprobe ────────────────────────────────────────────────────────
const run = (cmd, args, { quiet = true } = {}) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let out = '';
    let err = '';
    p.stdout?.on('data', (d) => { out += d; });
    p.stderr?.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0
      ? resolve(out)
      : reject(new Error(`${cmd} が失敗しました (exit ${code})\n${err.slice(-2000)}`))));
  });

/** 動画の素性。フレーム数は変換後の突き合わせに使うので、必ず実測する。 */
async function probe(file) {
  const raw = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-count_frames',
    '-show_entries', 'stream=width,height,r_frame_rate,nb_read_frames',
    '-show_entries', 'format=duration',
    '-of', 'json', file,
  ]);
  const j = JSON.parse(raw);
  const s = j.streams[0];
  const [num, den] = s.r_frame_rate.split('/').map(Number);
  return {
    width: s.width,
    height: s.height,
    fps: num / den,
    frames: Number(s.nb_read_frames),
    duration: Number(j.format.duration),
  };
}

const fmtMB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;
const fmtMin = (ms) => `${Math.floor(ms / 60000)}分${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}秒`;

function encodeArgs(dst) {
  if (CODEC === 'vp9') {
    return ['-c:v', 'libvpx-vp9', '-crf', String(CRF), '-b:v', '0',
      '-row-mt', '1', '-threads', '16', '-cpu-used', '3',
      '-g', String(GOP), '-pix_fmt', 'yuv420p', dst];
  }
  return ['-c:v', 'libsvtav1', '-crf', String(CRF), '-preset', String(PRESET),
    '-g', String(GOP), '-pix_fmt', 'yuv420p', dst];
}

/**
 * 1 本変換する。先頭カットは `-vf select` ではなくフレーム単位の trim で行う。
 *
 * `-ss` の秒指定はキーフレームに丸められることがあり、「3 コマ」を狙って落とすのに
 * 使うと本数ごとに落ちるコマ数が変わりうる。フレーム番号で切れば 3 本とも必ず
 * 同じ量だけ削れる — ここがズレると切替そのものが壊れる。
 */
async function encodeOne(src, dst, { reverse = false } = {}) {
  const filters = [];
  if (TRIM_FRAMES > 0) filters.push(`select='gte(n\\,${TRIM_FRAMES})'`, 'setpts=PTS-STARTPTS');
  if (reverse) filters.push('reverse');
  const vf = filters.length ? ['-vf', filters.join(',')] : [];
  await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-an', ...vf, ...encodeArgs(dst)]);
}

// ── 変換 ────────────────────────────────────────────────────────────────────
console.log(`素材: ${IN_DIR}`);
console.log(`出力: ${OUT_DIR}`);
console.log(`設定: ${CODEC} crf=${CRF}${CODEC === 'av1' ? ` preset=${PRESET}` : ''} gop=${GOP} 先頭カット=${TRIM_FRAMES}コマ 反転=${WANT_REVERSE ? 'あり' : 'なし'}\n`);

const sources = [];
for (const e of entries) {
  const src = path.join(IN_DIR, e.file);
  if (!existsSync(src)) throw new Error(`素材が見つかりません: ${src}`);
  const info = await probe(src);
  sources.push({ ...e, src, info });
  console.log(`  ${e.key.padEnd(9)} ${e.file}  ${info.width}x${info.height} ${info.frames}f ${info.duration.toFixed(3)}s`);
}

// 入力の時点で揃っていなければ、変換しても揃わない。ここで止める。
const base = sources[0];
for (const s of sources.slice(1)) {
  if (s.info.frames !== base.info.frames) {
    throw new Error(
      `素材のフレーム数が違います: ${base.file}=${base.info.frames}f / ${s.file}=${s.info.frames}f\n` +
      '同じカメラ軌跡を描き分けたものだけを渡してください (切替は再生位置を保って差し替える仕掛けです)。',
    );
  }
  if (s.info.width !== base.info.width || s.info.height !== base.info.height) {
    throw new Error(`素材の解像度が違います: ${base.file}=${base.info.width}x${base.info.height} / ${s.file}=${s.info.width}x${s.info.height}`);
  }
}
if (TRIM_FRAMES >= base.info.frames) {
  throw new Error(`--trim-frames ${TRIM_FRAMES} が素材の長さ (${base.info.frames}f) 以上です`);
}

const outputs = [];
for (const s of sources) {
  const targets = [{ name: `video360-${s.key}.webm`, reverse: false }];
  if (WANT_REVERSE) targets.push({ name: `video360-${s.key}-rev.webm`, reverse: true });

  for (const t of targets) {
    const dst = path.join(OUT_DIR, t.name);
    if (onlyKeys && !onlyKeys.has(s.key)) {
      if (existsSync(dst)) { console.log(`\n  skip (--only): ${t.name}`); outputs.push({ key: s.key, ...t, dst }); continue; }
    }
    console.log(`\n変換中: ${s.file} → ${t.name}${t.reverse ? ' (反転)' : ''}`);
    const t0 = Date.now();
    await encodeOne(s.src, dst, { reverse: t.reverse });
    const size = (await stat(dst)).size;
    console.log(`  完了 ${fmtMin(Date.now() - t0)}  ${fmtMB(size)}`);
    outputs.push({ key: s.key, ...t, dst });
  }
}

// ── 検証 ────────────────────────────────────────────────────────────────────
// 変換後にもう一度突き合わせる。エンコーダが末尾を落とす・重複させるといった事故は
// 実際にあり、そうなると切替の瞬間だけ絵が飛ぶという再現しにくい壊れ方をする。
console.log('\n検証: 変換後のフレーム数を突き合わせ');
let outInfo = null;
for (const o of outputs) {
  const info = await probe(o.dst);
  console.log(`  ${o.name.padEnd(30)} ${info.frames}f ${info.duration.toFixed(3)}s`);
  if (!outInfo) outInfo = info;
  else if (info.frames !== outInfo.frames) {
    throw new Error(`変換結果のフレーム数が揃っていません: ${o.name}=${info.frames}f (期待 ${outInfo.frames}f)`);
  }
}
const expected = base.info.frames - TRIM_FRAMES;
if (outInfo.frames !== expected) {
  throw new Error(`変換結果が想定と違います: ${outInfo.frames}f (期待 ${expected}f = ${base.info.frames} - ${TRIM_FRAMES})`);
}
console.log(`  ✅ 全 ${outputs.length} 本が ${outInfo.frames}f で一致`);

// ── 取り込み用 JSON ─────────────────────────────────────────────────────────
const trimSeconds = TRIM_FRAMES / base.info.fps;
const manifest = {
  /** どの素材から作ったか。あとで作り直すときに設定を思い出せるように残す。 */
  builtFrom: sources.map((s) => ({ key: s.key, file: s.file, frames: s.info.frames })),
  codec: CODEC,
  crf: CRF,
  gop: GOP,
  /** 落とした先頭コマ数。既存の manifest が未カットの素材で打たれている場合、
   *  ノード時刻はこの秒数だけ後ろにずれている。取り込み側で補正できるよう渡す。 */
  trimmedFrames: TRIM_FRAMES,
  trimSeconds: +trimSeconds.toFixed(4),
  fps: +base.info.fps.toFixed(6),
  duration: +outInfo.duration.toFixed(4),
  frames: outInfo.frames,
  width: base.info.width,
  height: base.info.height,
  defaultVariantId: sources[0].key,
  variants: sources.map((s) => ({
    id: s.key,
    label: s.label,
    furniture: s.furniture,
    lighting: s.lighting,
    src: `video360-${s.key}.webm`,
    ...(WANT_REVERSE ? { srcReverse: `video360-${s.key}-rev.webm` } : {}),
    sourceName: s.file,
  })),
};
const manifestPath = path.join(OUT_DIR, 'video360-variants.json');
await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
console.log(`\n書き出し: ${manifestPath}`);

// ── R2 へアップロード ───────────────────────────────────────────────────────
if (PUBLISH_SCENE) {
  const creds = await readFile(new URL('../../src/shared/admin-credentials.ts', import.meta.url), 'utf8');
  const user = creds.match(/ADMIN_USERNAME\s*=\s*'([^']+)'/)?.[1];
  const pass = creds.match(/ADMIN_PASSWORD\s*=\s*'([^']+)'/)?.[1];
  if (!user || !pass) throw new Error('admin-credentials.ts から認証情報を読めませんでした');
  const host = arg('host', 'https://cg-rooms.com');
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  const files = [...outputs.map((o) => ({ name: o.name, file: o.dst, type: 'video/webm' })),
    { name: 'video360-variants.json', file: manifestPath, type: 'application/json' }];

  // Cloudflare Worker の受け口は 1 リクエスト 100MB まで。8K の夜バリアントは実測
  // 137MB あって単発 PUT では 413 が返る。しきい値を超えたら R2 のマルチパートに
  // 切り替える — 経路も分割サイズも `src/utils/publish.ts` と同じにしてある。
  const SINGLE_PUT_MAX = 90 * 1024 * 1024;
  const CHUNK_SIZE = 50 * 1024 * 1024;

  const putSingle = async (name, type, body) => {
    const res = await fetch(`${host}/api/publish/${PUBLISH_SCENE}/${encodeURIComponent(name)}`, {
      method: 'PUT', headers: { Authorization: auth, 'Content-Type': type }, body,
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  };

  const putMultipart = async (name, type, body) => {
    const base = `${host}/api/publish/${PUBLISH_SCENE}/${encodeURIComponent(name)}`;
    const created = await fetch(`${base}?action=create&contentType=${encodeURIComponent(type)}`, {
      method: 'POST', headers: { Authorization: auth },
    });
    if (!created.ok) throw new Error(`create ${created.status}`);
    const { uploadId } = await created.json();
    const parts = [];
    try {
      for (let off = 0, n = 1; off < body.length; off += CHUNK_SIZE, n++) {
        const chunk = body.subarray(off, Math.min(off + CHUNK_SIZE, body.length));
        const res = await fetch(`${base}?action=part&uploadId=${encodeURIComponent(uploadId)}&part=${n}`, {
          method: 'PUT', headers: { Authorization: auth, 'Content-Type': type }, body: chunk,
        });
        if (!res.ok) throw new Error(`part ${n}: ${res.status}`);
        parts.push({ partNumber: n, etag: (await res.json()).etag });
        process.stdout.write(`\r  ${name} … ${parts.length} パート`);
      }
    } catch (e) {
      // 途中で落ちたら中断させる。放っておくと未完のマルチパートが R2 に残って課金される。
      await fetch(`${base}?action=abort&uploadId=${encodeURIComponent(uploadId)}`, {
        method: 'POST', headers: { Authorization: auth },
      }).catch(() => {});
      throw e;
    }
    const done = await fetch(`${base}?action=complete&uploadId=${encodeURIComponent(uploadId)}`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts }),
    });
    if (!done.ok) throw new Error(`complete ${done.status}`);
    process.stdout.write('\r');
  };

  console.log(`\nアップロード先: ${host}/api/publish/${PUBLISH_SCENE}/`);
  for (const f of files) {
    const body = await readFile(f.file);
    const t0 = Date.now();
    const how = body.length > SINGLE_PUT_MAX ? putMultipart : putSingle;
    try {
      await how(f.name, f.type, body);
    } catch (e) {
      throw new Error(`アップロード失敗 ${f.name}: ${e.message}`);
    }
    console.log(`  ✅ ${f.name.padEnd(30)} ${fmtMB(body.length)}  ${fmtMin(Date.now() - t0)}`
      + (how === putMultipart ? '  (マルチパート)' : ''));
  }
}

console.log('\n完了。ビューアの Debug > 360°動画 > 「バリアントを取り込む」から読み込んでください。');
