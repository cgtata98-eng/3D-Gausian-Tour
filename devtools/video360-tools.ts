/**
 * ローカルの ffmpeg を呼ぶ開発用ツール (dev サーバ専用).
 *
 * 逆走用の反転素材はブラウザ内では作れない ― 動画を後ろから作り直す処理なので、
 * どうしても ffmpeg が要る。かといって「端末を開いてコマンドを打って、出来た
 * ファイルを選び直す」を毎回やらせるのは作業の流れを断ち切る。
 * dev サーバの中で ffmpeg を起動し、出来たものをそのまま返して繋ぐ。
 *
 * 本番 (Cloudflare Worker) にこの経路は存在しない。ffmpeg が動く場所ではないので、
 * UI 側も dev のときだけボタンを出す (`/api/dev/video360/ping` の返事で判定)。
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';

/** 素材を置く作業フォルダ。既存の R2 ステージングと同じ並びに置く。 */
export function workDirFor(sceneId: string, planId: string): string {
  const safe = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, '_');
  return resolve('r2-uploads', 'video360', safe(sceneId), safe(planId));
}

export interface ToolProgress {
  stage: string;
  ratio?: number;
  message?: string;
}

/**
 * 逆走用の反転素材を作る。
 *
 * `-vf reverse` を長い動画に直接かけると落ちる。デコード済みフレームを全部メモリに
 * 積むためで、1920x1080 yuv420p なら 3.1MB/frame ― 1 分で 5GB を超える。
 * 5 秒のかたまりに割って各かたまりを反転し、逆順に連結する。
 *
 * 出力は入力と同じフォルダ。あとから R2 に上げるにも、中身を確かめるにも、
 * 実体のファイルが並んでいるほうが扱いやすい。
 */
export async function makeReverse(
  inputPath: string,
  outPath: string,
  onProgress: (p: ToolProgress) => void,
): Promise<void> {
  const tmp = join(workDirFor('_tmp', '_tmp'), `chunks-${Date.now().toString(36)}`);
  await mkdir(tmp, { recursive: true });
  try {
    onProgress({ stage: 'split', message: '5 秒ずつに分割中…' });
    // キーフレーム境界で無劣化分割。中身を触らないので速い。
    await run([
      '-y', '-v', 'error', '-i', inputPath, '-an', '-c', 'copy',
      '-f', 'segment', '-segment_time', '5', '-reset_timestamps', '1',
      join(tmp, 'seg%04d.mp4'),
    ]);

    const segs = (await readdir(tmp)).filter((n) => /^seg\d+\.mp4$/.test(n)).sort();
    if (segs.length === 0) throw new Error('分割できませんでした（動画を読めていない可能性があります）');

    for (let i = 0; i < segs.length; i++) {
      onProgress({ stage: 'reverse', ratio: i / segs.length, message: `反転 ${i + 1}/${segs.length}` });
      await run([
        '-y', '-v', 'error', '-i', join(tmp, segs[i]), '-vf', 'reverse', '-an',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
        // 0.5 秒ごとにキーフレーム。どこへ飛んでも復号は最大 15 フレームで済む。
        '-g', '15', '-keyint_min', '15', '-x264-params', 'scenecut=0:open-gop=0',
        '-pix_fmt', 'yuv420p',
        join(tmp, `${segs[i].replace('.mp4', '')}.rev.mp4`),
      ]);
    }

    onProgress({ stage: 'concat', ratio: 0.95, message: '連結中…' });
    // concat デマクサはリストと同じ階層を基準にパスを解く。ファイル名だけを書く。
    const list = segs.map((n) => `file '${n.replace('.mp4', '')}.rev.mp4'`).reverse().join('\n');
    await writeFile(join(tmp, 'list.txt'), `${list}\n`, 'utf8');
    await mkdir(resolve(outPath, '..'), { recursive: true });
    await run([
      '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', join(tmp, 'list.txt'),
      '-c', 'copy', '-movflags', '+faststart', outPath,
    ]);
    onProgress({ stage: 'done', ratio: 1, message: '完了' });
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => { /* 消せなくても実害は無い */ });
  }
}

/** ffmpeg がこの端末にあるか。UI がボタンを出すかどうかの判定に使う。 */
export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await run(['-version']);
    return true;
  } catch {
    return false;
  }
}

export async function saveUpload(dir: string, name: string, data: Buffer): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
}

/** ファイルの大きさ。無ければ null。中身は読まない ― GB 級を丸ごと抱えないため。 */
export async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

/** 出来た素材をそのまま流す。読み切ってから返すとメモリに乗り切らない。 */
export function streamFile(path: string) {
  return createReadStream(path);
}

function run(args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(FFMPEG, args, { windowsHide: true });
    let err = '';
    // ffmpeg は進捗を stderr に書く。失敗時に読める量だけ残す。
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', () => rej(new Error('ffmpeg を起動できません。PATH を通すか FFMPEG_PATH を設定してください')));
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(err || `ffmpeg exited ${code}`))));
  });
}
