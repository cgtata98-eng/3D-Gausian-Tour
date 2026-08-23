/**
 * カメラ軌跡の取り込み — 位置を推定せず、書き出したものを使う。
 *
 * 動画だけから位置を割り出すには SfM や光学フローが要るが、equirect・低テクスチャの
 * 室内・歩行ブレという条件では実用精度が出ない。CG なら軌跡は既知なので、
 * `scripts/render/export-walk-track.ms` が書き出したものをそのまま取り込む。
 *
 * 取り込み結果は **視点の `position` / `mapPosition` に書く**。専用の座標置き場を
 * 作らない ― 視点はすでに床ポイントの向き・図面のドット・ミニマップが読んでいる
 * 唯一の持ち主なので、そこへ入れれば下流は何も変えずに正しくなる。
 */
import type { Vec3, Video360Track, Video360Walk, Viewpoint } from './types';

/** 書き出しファイルの形。`export-walk-track.ms` の出力。 */
export interface WalkTrackFile {
  source?: string;
  fps?: number;
  unitScale?: number;
  startFrame?: number;
  samples?: [number, number, number, number][];
  doors?: { name: string; pos: [number, number, number] }[];
}

export interface ParsedTrack {
  track: Video360Track;
  doors: { name: string; pos: Vec3 }[];
}

/**
 * 書き出しファイルを取り込み用の形に直す。
 * 単位はここでメートルに揃える ― 変換を実行時に残すと、どこかで掛け忘れる。
 */
export function parseWalkTrack(json: unknown): ParsedTrack {
  const f = json as WalkTrackFile;
  if (!f || !Array.isArray(f.samples) || f.samples.length === 0) {
    throw new Error('samples が入っていません（walk-track.json を選んでください）');
  }
  const scale = typeof f.unitScale === 'number' && f.unitScale > 0 ? f.unitScale : 1;
  const samples = f.samples.map(([x, y, z, yaw]) => [
    +(x * scale).toFixed(4),
    +(y * scale).toFixed(4),
    +(z * scale).toFixed(4),
    +Number(yaw).toFixed(2),
  ] as [number, number, number, number]);

  return {
    track: {
      source: f.source,
      fps: f.fps && f.fps > 0 ? f.fps : 30,
      unitScale: 1,        // 取り込み済み。以降は掛けない。
      samples,
    },
    doors: (f.doors ?? []).map((d) => ({
      name: d.name,
      pos: [
        +(d.pos[0] * scale).toFixed(4),
        +(d.pos[1] * scale).toFixed(4),
        +(d.pos[2] * scale).toFixed(4),
      ] as Vec3,
    })),
  };
}

/** ある時刻のカメラ位置と向き。範囲外は端に丸める。 */
export function sampleAt(track: Video360Track, t: number): { pos: Vec3; yaw: number } | null {
  const n = track.samples.length;
  if (n === 0) return null;
  const i = Math.max(0, Math.min(n - 1, Math.round(t * track.fps)));
  const [x, y, z, yaw] = track.samples[i];
  return { pos: [x, y, z], yaw };
}

/**
 * ノードの視点に、その時刻の実座標と向きを書き込む。
 *
 * `target` も一緒に置く ― 到着時にどちらを向くかの唯一の持ち主なので、
 * ここが軌跡と食い違うと「着いたら変な方向を向く」に戻る。
 */
export function applyTrackToViewpoints(
  data: Video360Walk,
  viewpoints: Viewpoint[],
): { updated: Viewpoint[]; count: number } {
  const track = data.track;
  if (!track) return { updated: viewpoints, count: 0 };

  const byId = new Map(data.nodes.map((n) => [n.viewpointId, n]));
  let count = 0;
  const updated = viewpoints.map((vp) => {
    const node = byId.get(vp.id);
    if (!node) return vp;
    const s = sampleAt(track, node.t);
    if (!s) return vp;
    count++;
    const rad = (s.yaw * Math.PI) / 180;
    // yaw 0 = -Z 向き。1m 先を target に置く。
    const target: Vec3 = [
      +(s.pos[0] - Math.sin(rad)).toFixed(3),
      +s.pos[1].toFixed(3),
      +(s.pos[2] - Math.cos(rad)).toFixed(3),
    ];
    return {
      ...vp,
      position: [+s.pos[0].toFixed(3), +s.pos[1].toFixed(3), +s.pos[2].toFixed(3)] as Vec3,
      target,
      // 図面のドットも同じ場所へ。床ポイントの向きはここから出る。
      mapPosition: [+s.pos[0].toFixed(3), +s.pos[2].toFixed(3)] as [number, number],
    };
  });
  return { updated, count };
}

/**
 * 書き出したドアの位置を、一番近いノードのエッジとして起こす。
 *
 * ドアは「そこから開ける」ものなので、どのノードに属すかを決める必要がある。
 * 軌跡があるなら、そのドアに一番近づいた時刻が答え ― 撮影者がドアの前に立った
 * 瞬間そのもので、手で選ぶより確実。
 */
export function nearestNodeForDoor(
  data: Video360Walk,
  doorPos: Vec3,
): { viewpointId: string; t: number; distance: number } | null {
  const track = data.track;
  if (!track || data.nodes.length === 0) return null;
  let best: { viewpointId: string; t: number; distance: number } | null = null;
  for (const n of data.nodes) {
    const s = sampleAt(track, n.t);
    if (!s) continue;
    const d = Math.hypot(s.pos[0] - doorPos[0], s.pos[2] - doorPos[2]);
    if (!best || d < best.distance) best = { viewpointId: n.viewpointId, t: n.t, distance: +d.toFixed(2) };
  }
  return best;
}

/**
 * 軌跡から、エッジ区間で実際に歩いた距離を出す。
 *
 * 「再生秒数 × 歩行速度」の見立てより正確で、加減速があっても崩れない。
 * 床ポイントの間隔を決めるのに使う。
 */
export function distanceAlong(track: Video360Track, from: number, to: number): number {
  const a = Math.max(0, Math.round(Math.min(from, to) * track.fps));
  const b = Math.min(track.samples.length - 1, Math.round(Math.max(from, to) * track.fps));
  let d = 0;
  for (let i = a + 1; i <= b; i++) {
    const p = track.samples[i - 1];
    const q = track.samples[i];
    d += Math.hypot(q[0] - p[0], q[2] - p[2]);
  }
  return +d.toFixed(2);
}
