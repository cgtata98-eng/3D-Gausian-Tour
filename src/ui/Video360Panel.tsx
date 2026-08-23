/**
 * 360°動画ウォークスルーのオーサリング (Debug → プラン タブ).
 *
 * 作るのは 3 つだけ。
 *   1. 素材   … 順再生の動画と、逆走用の反転素材。IDB に置いて manifest には参照を持つ。
 *   2. ノード … 撮影者が足を止めた時刻を、既存の「視点」に紐付ける。
 *   3. エッジ … ノード間の歩きの時間区間。
 *
 * ノードの置き場所は手で探さない。`scripts/video360/analyze.mjs` が出した静止区間を
 * タイムラインに帯で出すので、その中から選ぶ。動きのある瞬間で止めると、ポーズした
 * フレームがブレた絵になって没入が切れる。
 *
 * `node.t`（停止中に見せる 1 フレーム）と `edge.range`（実際に再生する区間）を別に
 * 持つのが要点。同じにすると静止区間の「たまり」を毎回再生し直すことになる。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Plan, Video360Edge, Video360Node, Video360Variant, Video360Walk } from '../core/types';
import { useSceneStore } from '../store/scene-store';
import { isIdbRef, resolveBlobRef, saveBlob } from '../utils/idb';
import { resolveScenePath } from '../core/scene-manifest';
import { analyzeVideo360 } from '../utils/video360-analyze';
import { applyTrackToViewpoints, nearestNodeForDoor, parseWalkTrack } from '../core/video360-track';
import { useUIStore } from '../store/ui-store';
import type { SceneManager } from '../engine/scene-manager';
import { surfaceClass } from './components';

// Debug の他のセクションと同じボタン。見た目は design-system.css が持ち、
// ここは「どの種類か」だけを言う。独自のボタンを足すと、この一角だけ様子が変わる。
const BTN = `${surfaceClass('neutral')} ds-pill ds-pill--sm ds-fill-neutral`;
const BTN_PRIMARY = `${surfaceClass('plain')} ds-pill ds-pill--sm ds-fill-surface`;

/** レイアウトだけ。色や境界は design-system.css が持つ。 */
const S = {
  stack: { display: 'flex', flexDirection: 'column', gap: 10 } as React.CSSProperties,
  sec: { marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(0,0,0,0.08)' } as React.CSSProperties,
};

interface Props {
  plan: Plan;
  sceneId: string;
  /** ライブの 360 を直接スクラブするために要る。見えている絵と打つ対象を揃えるため。 */
  getManager?: () => SceneManager | null;
}

const DEFAULTS = { eyeHeight: 1.6, walkSpeed: 1.05, stepSpacing: 2.4 };

export function Video360Panel({ plan, sceneId, getManager }: Props) {
  const authoring = useUIStore((s) => s.video360Authoring);
  const setAuthoring = useUIStore((s) => s.setVideo360Authoring);
  const setPlanVideo360 = useSceneStore((s) => s.setPlanVideo360);
  const data = plan.video360;
  const [busy, setBusy] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [selNode, setSelNode] = useState<string | null>(null);
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // 一括生成の入力。等分割はウォークスルーで一番よく使う 10 を既定に。
  const [splitCount, setSplitCount] = useState('10');
  const [timeList, setTimeList] = useState('');
  // ローカルの ffmpeg が使えるか。使えるときだけ「反転素材を作る」を出す。
  // 本番 (Cloudflare) にこの経路は無いので、出しても押せないボタンになる。
  const [canRunFfmpeg, setCanRunFfmpeg] = useState(false);

  const patch = (p: Partial<Video360Walk>) => {
    if (!data) return;
    setPlanVideo360(plan.id, { ...data, ...p });
  };

  useEffect(() => {
    let alive = true;
    fetch('/api/dev/video360/ping')
      .then((r) => (r.ok ? r.json() : { ffmpeg: false }))
      .then((j) => { if (alive) setCanRunFfmpeg(!!j.ffmpeg); })
      .catch(() => { /* 本番にはこの経路が無い。出さないだけ。 */ });
    return () => { alive = false; };
  }, []);

  /**
   * 反転素材をその場で作る。
   *
   * ブラウザ内では作れない (動画を後ろから作り直す処理なので ffmpeg が要る) ので、
   * dev サーバに渡してローカルの ffmpeg を回す。元の動画と出来た反転素材は
   * `r2-uploads/video360/<シーン>/<プラン>/` に実ファイルとして残るので、
   * あとから R2 に上げるのも中身を確かめるのもそのままできる。
   */
  const buildReverse = async () => {
    if (!data?.src || !previewUrl) return;
    setBusy('反転素材を作成中…');
    try {
      const blob = await (await fetch(previewUrl)).blob();
      const q = new URLSearchParams({
        scene: sceneId,
        plan: plan.id,
        name: data.sourceName ?? 'tour.mp4',
      });
      const res = await fetch(`/api/dev/video360/reverse?${q}`, { method: 'POST', body: blob });
      if (!res.ok || !res.body) throw new Error(`サーバが ${res.status} を返しました`);

      // 進捗は NDJSON で流れてくる。8K だと数分かかるので、無反応にはしない。
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let result: { name: string; path: string; bytes: number } | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.error) throw new Error(msg.error);
          if (msg.stage === 'result') result = msg;
          else setBusy(`反転素材を作成中… ${msg.message ?? msg.stage}`);
        }
      }
      if (!result) throw new Error('反転素材を受け取れませんでした');

      // 中身は別口で取りに行く。作った素材を JSON に埋めて返すと、
      // 8K・数分では base64 にした時点でメモリが持たない。
      setBusy('反転素材を取り込み中…');
      const fq = new URLSearchParams({ scene: sceneId, plan: plan.id, name: result.name });
      const revBlob = await (await fetch(`/api/dev/video360/file?${fq}`)).blob();
      const key = `video360-${sceneId}-${plan.id}-srcReverse`;
      await saveBlob(key, revBlob);
      patch({ srcReverse: `idb:${key}` });
      setBusy(null);
      alert(`反転素材を作りました。\n${result.path}`);
    } catch (err) {
      console.error('[video360] 反転素材の作成に失敗', err);
      alert(`反転素材を作れませんでした: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  // ── 逆走用の反転素材 ────────────────────────────────────────────────────
  // 本体の動画は「各プラン」カードの ⇪ から入れる ― 動画はプランの中身であって、
  // ここだけの持ち物ではない。取り込み口を 2 箇所に分けると、どちらが正か分からなくなる。
  // 反転素材はそこから派生して作るものなので、こちらに置く。
  const attachReverse = async (file: File) => {
    setBusy('反転素材を取り込み中…');
    try {
      const key = `video360-${sceneId}-${plan.id}-srcReverse`;
      await saveBlob(key, file);
      patch({ srcReverse: `idb:${key}` });
    } finally {
      setBusy(null);
    }
  };

  /**
   * ワンクリック解析。外で ffmpeg を回して JSON を持ってくる往復を無くす。
   *
   * 倍速で舐めながら実際に出たフレームを拾うので、1 分の素材で 15 秒ほど。
   * 判定式は `scripts/video360/analyze.mjs` と揃えてあるので、どちらで作っても同じ性質。
   */
  const runAnalysis = async () => {
    if (!data?.src || !previewUrl) return;
    setBusy('解析中… 0%');
    try {
      const res = await analyzeVideo360(previewUrl, {
        onProgress: (r) => setBusy(`解析中… ${Math.round(r * 100)}%`),
      });
      patch({
        duration: res.duration || data.duration,
        stills: res.stills,
        calmTimes: res.calmTimes,
      });
      if (res.stills.length === 0) {
        alert('静止区間が見つかりませんでした。ずっと動き続けている素材かもしれません。');
      }
    } catch (err) {
      console.error('[video360] 解析に失敗', err);
      alert(`解析に失敗しました: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  /**
   * カメラ軌跡を取り込む。位置を推定するのではなく、レンダリング時に書き出した
   * ものを持ってくる。取り込むと各ノードの視点に実座標が入り、床ポイントの向きも
   * 図面のドットも既存の経路のまま正しくなる。
   *
   * 書き出したドアがあれば、一番近づいた時刻のノードに紐づけて自動で貼る ―
   * 撮影者がドアの前に立った瞬間そのものなので、手で選ぶより確実。
   */
  const loadTrack = async (file: File) => {
    setBusy('カメラ軌跡を読み込み中…');
    try {
      const parsed = parseWalkTrack(JSON.parse(await file.text()));
      const next: Video360Walk = { ...data!, track: parsed.track };

      // 書き出したドアをエッジとして起こす
      const doorEdges = parsed.doors.map((d, i) => {
        const near = nearestNodeForDoor(next, d.pos);
        return near ? {
          id: `door-track-${i}`,
          from: near.viewpointId,
          to: near.viewpointId,
          range: [near.t, Math.min(near.t + 2, next.duration)] as [number, number],
          label: d.name || 'ドアを開ける',
          kind: 'door' as const,
          doorPos: d.pos,
        } : null;
      }).filter(Boolean) as Video360Edge[];

      // 既に軌跡から起こしたドアは差し替える (二重に貼らない)
      const kept = next.edges.filter((e) => !e.id.startsWith('door-track-'));
      next.edges = [...kept, ...doorEdges];

      useSceneStore.getState().setPlanVideo360(plan.id, next);

      // 視点に実座標を書く。ここが下流すべての持ち主 ―
      // 床ポイントの向きも図面のドットもミニマップも、全部ここを見ている。
      // 1 件ずつ呼ぶと視点の数だけ再描画が走るので、まとめて 1 回で置き換える。
      const { updated, count } = applyTrackToViewpoints(next, plan.viewpoints);
      useSceneStore.setState((st) => {
        if (!st.manifest?.plans) return st;
        return {
          manifest: {
            ...st.manifest,
            plans: st.manifest.plans.map((pp) => (pp.id === plan.id ? { ...pp, viewpoints: updated } : pp)),
          },
        };
      });
      setBusy(null);
      alert(`カメラ軌跡を取り込みました。\n`
        + `サンプル ${parsed.track.samples.length} / 視点に座標を入れた ${count} 件`
        + (doorEdges.length ? ` / ドア ${doorEdges.length} 件` : ''));
    } catch (err) {
      console.error('[video360] カメラ軌跡の取り込みに失敗', err);
      alert(`カメラ軌跡を読めませんでした: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  // ── 描き分け素材 (家具あり / なし / 夜) ─────────────────────────────────

  /**
   * `scripts/video360/build-variants.mjs` が書き出した `video360-variants.json` を
   * 取り込む。R2 に上げてあればそこから、手元のファイルからでも読める。
   *
   * ノードもエッジも軌跡も **触らない**。3 本は同じカメラ軌跡の描き分けで、変換側が
   * 総フレーム数まで突き合わせているので、時間軸は 1 本のまま使い回せる。ここで
   * 3 組に増やすと、打ち直すたびにどれかが古くなる。
   *
   * 先頭カットがある場合だけ、時刻がその秒数ぶん前へずれる。既存のノードを
   * 打ち直させるのは無駄なので、まとめてずらすかを聞いてから当てる。
   */
  const loadVariants = async (file?: File) => {
    setBusy('バリアントを取り込み中…');
    try {
      const json = file
        ? JSON.parse(await file.text())
        : await (async () => {
          const url = resolveScenePath(sceneId, 'video360-variants.json');
          const res = await fetch(url, { cache: 'no-store' });
          if (!res.ok) throw new Error(`${url} を取得できませんでした (${res.status})`);
          return res.json();
        })();

      const list = Array.isArray(json?.variants) ? json.variants as Video360Variant[] : [];
      if (list.length === 0) throw new Error('variants が入っていません');
      for (const v of list) {
        if (!v.id || !v.src) throw new Error(`variants の項目に id / src がありません: ${JSON.stringify(v)}`);
      }

      const def = list.find((v) => v.id === json.defaultVariantId) ?? list[0];
      let next: Video360Walk = {
        ...data!,
        variants: list,
        defaultVariantId: def.id,
        // 本体の src も既定バリアントに寄せる。別々のものを指したままにすると、
        // バリアントを持たない古い経路 (書き出し・検証) が違う素材を見ることになる。
        src: def.src,
        srcReverse: def.srcReverse,
        duration: typeof json.duration === 'number' ? json.duration : data!.duration,
        fps: typeof json.fps === 'number' ? json.fps : data!.fps,
        sourceName: def.sourceName ?? def.src,
      };

      const trim = typeof json.trimSeconds === 'number' ? json.trimSeconds : 0;
      const trimFrames = typeof json.trimmedFrames === 'number' ? json.trimmedFrames : 0;
      let shifted = false;
      if (trim > 0 && (data!.nodes.length > 0 || data!.edges.length > 0 || data!.track)) {
        shifted = confirm(
          [
            `先頭 ${trimFrames} コマ (${trim.toFixed(3)} 秒) を落とした素材です。`,
            'いまのノード・エッジ・軌跡がカット前の素材で打たれているなら、'
              + `その ${trim.toFixed(3)} 秒ぶん前へずらす必要があります。`,
            '',
            'ずらしますか？（すでにカット後の素材で打ち直している場合は「キャンセル」）',
          ].join('\n'),
        );
      }
      if (shifted) {
        const dur = next.duration;
        const sh = (t: number) => Math.min(dur, Math.max(0, +(t - trim).toFixed(4)));
        next = {
          ...next,
          nodes: next.nodes.map((n) => ({ ...n, t: sh(n.t) })),
          edges: next.edges.map((e) => ({ ...e, range: [sh(e.range[0]), sh(e.range[1])] as [number, number] })),
          events: next.events?.map((ev) => ({
            ...ev, at: sh(ev.at), ...(ev.until != null ? { until: sh(ev.until) } : {}),
          })),
          stills: next.stills?.map((st) => ({ start: sh(st.start), end: sh(st.end), rest: sh(st.rest) })),
          calmTimes: next.calmTimes?.map(sh),
          // 軌跡はフレーム番号で引くので、秒ではなく **頭からコマを落とす**。
          // 秒でずらすと、フレーム 0 が動画のどのコマかという対応が崩れる。
          track: next.track && trimFrames > 0
            ? { ...next.track, samples: next.track.samples.slice(trimFrames) }
            : next.track,
        };
      }

      setPlanVideo360(plan.id, next);
      setBusy(null);
      alert([
        `バリアントを ${list.length} 件取り込みました。`,
        ...list.map((v) => `・${v.label ?? v.id} (${v.src})`),
        '',
        `既定: ${def.label ?? def.id}`,
        ...(shifted ? [`時刻を ${trim.toFixed(3)} 秒ぶん前へずらしました。`] : []),
      ].join('\n'));
    } catch (err) {
      console.error('[video360] バリアントの取り込みに失敗', err);
      alert(`バリアントを読めませんでした: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  // ── 解析結果の読み込み ──────────────────────────────────────────────────
  const loadAnalysis = async (file: File) => {
    setBusy('解析結果を読み込み中…');
    try {
      const json = JSON.parse(await file.text()) as {
        fps?: number; duration?: number;
        stills?: { start: number; end: number; rest: number }[];
        calmTimes?: number[];
      };
      patch({
        fps: json.fps ?? data?.fps ?? 30,
        duration: json.duration ?? data?.duration ?? 0,
        stills: json.stills ?? [],
        calmTimes: json.calmTimes ?? [],
      });
    } catch (err) {
      console.error('[video360] 解析 JSON が読めません', err);
      alert('解析 JSON が読めませんでした');
    } finally {
      setBusy(null);
    }
  };

  /**
   * 時刻の並びからノードとエッジを起こす。等分割・秒指定の共通の土台。
   *
   * 静止区間ベース (`generate`) はカメラが足を止める素材が前提で、CG の連続移動
   * には効かない ― 止まる瞬間が無いので静止区間が 0 個になる。そういう素材では
   * 「尺のどこで止めるか」を先に決めるほうが早い。
   *
   * 時刻はフレーム境界に丸める。丸めないと、シークが隣り合う 2 フレームの
   * どちらに着地するかが再生ごとに揺れて、停止中の絵がちらついて見える。
   */
  const buildFromTimes = (
    times: number[],
    how: string,
    extras?: {
      /** ノード番号は 1 始まり (書き出し JSON と同じ数え方)。 */
      doors?: { label?: string; range: [number, number]; yaw: number; pitch: number; node: number }[];
      stills?: { start: number; end: number; rest: number }[];
      calmTimes?: number[];
    },
  ) => {
    if (!data) return;
    const fps = data.fps > 0 ? data.fps : 30;
    const dur = data.duration;
    const snap = (t: number) => +(Math.round(Math.max(0, Math.min(t, dur - 1 / fps)) * fps) / fps).toFixed(4);
    // 同じフレームに 2 つ置いても意味が無い (同じ絵で止まる 2 地点になる)。
    const ts = [...new Set(times.map(snap))].sort((a, b) => a - b);
    if (ts.length === 0) { alert('時刻がひとつも取れませんでした。'); return; }

    const store = useSceneStore.getState();
    const existing = [...plan.viewpoints];
    const nodes: Video360Node[] = ts.map((t, i) => {
      let vp = existing[i];
      if (!vp) {
        const id = `v360-${i + 1}`;
        const label = `ポイント ${i + 1}`;
        // 位置は仮。カメラ軌跡があればこの下で実座標に差し替える。
        const pose = {
          id, label,
          position: [0, 1.6, -i * 2] as [number, number, number],
          target: [0, 1.6, -i * 2 - 1] as [number, number, number],
          fov: 75,
        };
        store.addViewpoint(pose);
        vp = pose;
        existing[i] = vp;
      }
      return { viewpointId: vp.id, t };
    });

    // 区間はノードとノードのあいだそのもの。連続移動の素材では「立ち止まっている
    // ぶん」が無いので、静止区間ベースのような境目の取り分けは要らない。
    const edges: Video360Edge[] = [];
    for (let i = 0; i + 1 < nodes.length; i++) {
      edges.push({
        id: `e${i + 1}`,
        from: nodes[i].viewpointId,
        to: nodes[i + 1].viewpointId,
        range: [nodes[i].t, nodes[i + 1].t],
        label: `${existing[i + 1]?.label ?? ''}へ`,
        kind: 'walk',
      });
    }

    // 扉は床のポイントにしない。壁の上にあるので、浮かぶマーカーとして別に貼る。
    // 「そこから開ける」ものなので、どのノードに属すかを決める必要がある。
    const doorEdges: Video360Edge[] = (extras?.doors ?? []).map((d, i) => {
      const owner = nodes[Math.max(0, Math.min(nodes.length - 1, d.node - 1))];
      return {
        id: `door-plan-${i + 1}`,
        from: owner.viewpointId,
        to: owner.viewpointId,
        range: [snap(d.range[0]), snap(d.range[1])] as [number, number],
        label: d.label ?? `ドア ${i + 1}`,
        kind: 'door' as const,
        // 実座標はカメラ軌跡が無いと出せない。向きで持つ ― 立つ場所が変われば
        // ずれるが、軌跡を読ませれば `loadTrack` が実座標に貼り替える。
        doorYaw: d.yaw,
        doorPitch: d.pitch,
      };
    });

    const next: Video360Walk = {
      ...data,
      nodes,
      edges: [...edges, ...doorEdges],
      ...(extras?.stills ? { stills: extras.stills } : {}),
      ...(extras?.calmTimes ? { calmTimes: extras.calmTimes } : {}),
    };
    // 軌跡が入っているなら、作った直後に実座標を入れる。あとで手で押させると
    // 「打ったのに図面のドットが原点に固まっている」状態を経由することになる。
    let placed = 0;
    if (next.track) {
      const r = applyTrackToViewpoints(next, existing);
      placed = r.count;
      useSceneStore.setState((st) => {
        if (!st.manifest?.plans) return st;
        return {
          manifest: {
            ...st.manifest,
            plans: st.manifest.plans.map((pp) => (pp.id === plan.id ? { ...pp, viewpoints: r.updated } : pp)),
          },
        };
      });
    }
    setPlanVideo360(plan.id, next);
    setSelNode(nodes[0]?.viewpointId ?? null);
    setSelEdge(edges[0]?.id ?? null);
    alert([
      `${how}でノード ${nodes.length} 個 / エッジ ${edges.length} 本`
        + (doorEdges.length ? ` / ドア ${doorEdges.length} 個` : '') + 'を起こしました。',
      `時刻: ${ts.map((t) => t.toFixed(2)).join(', ')}`,
      placed ? `カメラ軌跡から ${placed} 件の視点に実座標を入れました。` : 'カメラ軌跡が未設定なので、位置は仮のままです（図面で置くか、軌跡を読ませてください）。',
    ].join('\n'));
  };

  /**
   * `scripts/video360/plan-walk.mjs` が出した案を取り込む。
   *
   * 手で打つのと違うのは、**止まるコマも扉の位置も実測から来る**こと。等分点は
   * そのままだと歩行中のブレたコマに落ちるので、書き出し側が近くの静止コマへ
   * 寄せてある。扉は「カメラが止まっているのに絵が変わり続ける区間」― この手の
   * 物件動画で世界の中で動くものは扉しかない ― として拾い、動きが集中している
   * equirect の列から向きに直してある。
   */
  const loadWalkPlan = async (file?: File) => {
    setBusy('ウォークスルー案を読み込み中…');
    try {
      const json = file
        ? JSON.parse(await file.text())
        : await (async () => {
          const url = resolveScenePath(sceneId, 'video360-walk-plan.json');
          const res = await fetch(url, { cache: 'no-store' });
          if (!res.ok) throw new Error(`${url} を取得できませんでした (${res.status})`);
          return res.json();
        })();

      const ns = Array.isArray(json?.nodes) ? json.nodes : [];
      if (ns.length === 0) throw new Error('nodes が入っていません');
      const times = ns.map((n: { t: number }) => Number(n.t)).filter((t: number) => Number.isFinite(t));
      if (times.length === 0) throw new Error('nodes の t が数値として読めません');

      setBusy(null);
      buildFromTimes(times, `取り込み (${json.mode ?? '案'})`, {
        doors: Array.isArray(json.doors) ? json.doors : [],
        stills: Array.isArray(json.stills) ? json.stills : undefined,
        calmTimes: Array.isArray(json.calmTimes) ? json.calmTimes : undefined,
      });
    } catch (err) {
      console.error('[video360] ウォークスルー案の取り込みに失敗', err);
      alert(`案を読めませんでした: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  /** 尺を N 等分する。両端を含むので **N+1 個**。最後の部屋にも立てるため。 */
  const generateEvenly = (n: number) => {
    if (!data || !(n >= 1) || !Number.isFinite(n)) { alert('分割数は 1 以上の数で指定してください。'); return; }
    const dur = data.duration;
    buildFromTimes(
      Array.from({ length: n + 1 }, (_, i) => (dur * i) / n),
      `${n} 等分`,
    );
  };

  /** `0, 3.1, 5.1` のように秒を並べて打つ。`f` を付けるとフレーム番号として読む。 */
  const generateFromList = (text: string) => {
    if (!data) return;
    const fps = data.fps > 0 ? data.fps : 30;
    const times = text
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => (/^\d+(\.\d+)?f$/i.test(x) ? Number(x.slice(0, -1)) / fps : Number(x)))
      .filter((v) => Number.isFinite(v));
    if (times.length === 0) { alert('数値として読めませんでした。`0, 3.1, 5.1` のように入れてください。'); return; }
    buildFromTimes(times, '秒指定');
  };

  /**
   * 静止区間からノードとエッジを一気に起こす。
   *
   * 静止区間の数だけ視点が要る。足りない分は作る ― 視点はシーンバーにもサムネにも
   * 図面のドットにも使われるので、ここで作っておけば後は図面に置くだけで済む。
   */
  const generate = () => {
    if (!data?.stills?.length) return;
    const stills = data.stills;
    const store = useSceneStore.getState();
    const existing = [...plan.viewpoints];
    const nodes: Video360Node[] = [];

    stills.forEach((st, i) => {
      let vp = existing[i];
      if (!vp) {
        const id = `v360-${i + 1}`;
        store.addViewpoint({
          id,
          label: `ポイント ${i + 1}`,
          position: [0, 1.6, -i * 2],
          target: [0, 1.6, -i * 2 - 1],
          fov: 75,
        });
        vp = { id, label: `ポイント ${i + 1}`, position: [0, 1.6, -i * 2], target: [0, 1.6, -i * 2 - 1], fov: 75 };
        existing[i] = vp;
      }
      nodes.push({ viewpointId: vp.id, t: st.rest });
    });

    // エッジは「前の静止区間の終わり → 次の静止区間の始まり」。
    // ノードの t ではなく区間の境目を使う ― t を使うと、静止して立っている
    // ぶんの時間まで毎回再生し直すことになる。
    const edges: Video360Edge[] = [];
    for (let i = 0; i + 1 < stills.length; i++) {
      edges.push({
        id: `e${i + 1}`,
        from: nodes[i].viewpointId,
        to: nodes[i + 1].viewpointId,
        range: [stills[i].end, stills[i + 1].start],
        label: `${existing[i + 1]?.label ?? ''}へ`,
        kind: 'walk',
      });
    }
    patch({ nodes, edges });
    setSelNode(nodes[0]?.viewpointId ?? null);
    setSelEdge(edges[0]?.id ?? null);
  };

  /**
   * ノードの停止フレームから、下のシーンバーのサムネイルを作る。
   *
   * サムネが無いとシーンバーが「…」だけの並びになって、どれがどの部屋か分からない。
   * 停止フレーム = そのノードで実際に見える絵なので、そこから切り出すのが一番正しい。
   * equirect のままでは何も読み取れないので、正面 80° を透視に直してから切る
   * 描画済みのフレームをそのまま切るので、到着したとき実際に見える向きの絵になる。
   */
  const buildThumbs = async () => {
    const sm = getManager?.() ?? null;
    const walker = sm?.getVideo360();
    if (data && sm && walker) {
      // ライブの 360 をノードの時刻へ動かして、描画済みの絵をそのまま切る。
      // equirect から作り直すより正しい ― 到着したとき実際に見える向きの絵になる。
      setBusy('サムネイルを作成中…');
      try {
        const store = useSceneStore.getState();
        for (const n of data.nodes) {
          await walker.settle(n.viewpointId);
          await new Promise((r) => setTimeout(r, 260));
          const shot = await sm.captureThumbnail(320);
          if (shot) store.setViewpointManualThumbnail(plan.id, n.viewpointId, shot);
        }
      } finally {
        setBusy(null);
      }
      return;
    }
    // ライブが無いときは何もしない。描画済みの絵が唯一の作り元。
  };

  /**
   * エッジに専用クリップを入れる。
   *
   * 隣同士は本編の区間再生でいいが、「リビングから書斎」のような遠い移動まで
   * 区間をつないで再生すると実測 37 秒かかって待てない。そこだけ 3 秒程度の
   * 専用クリップに差し替える。
   */
  const attachClip = async (file: File, edgeId: string, slot: 'src' | 'reverse') => {
    setBusy(slot === 'src' ? 'クリップを取り込み中…' : '逆走クリップを取り込み中…');
    try {
      const key = `video360-clip-${sceneId}-${plan.id}-${edgeId}-${slot}`;
      await saveBlob(key, file);
      const duration = await new Promise<number>((res) => {
        const url = URL.createObjectURL(file);
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.onloadedmetadata = () => { const d = v.duration; URL.revokeObjectURL(url); res(Number.isFinite(d) ? +d.toFixed(3) : 0); };
        v.onerror = () => { URL.revokeObjectURL(url); res(0); };
        v.src = url;
      });
      patch({
        edges: data!.edges.map((e) => {
          if (e.id !== edgeId) return e;
          const cur = e.clip;
          return {
            ...e,
            clip: slot === 'src'
              ? { ...(cur ?? {}), src: `idb:${key}`, duration, sourceName: file.name }
              : { src: cur?.src ?? '', duration: cur?.duration ?? duration, sourceName: cur?.sourceName, reverse: `idb:${key}` },
          };
        }),
      });
    } finally {
      setBusy(null);
    }
  };

  const clearClip = (edgeId: string) => {
    patch({
      edges: data!.edges.map((e) => {
        if (e.id !== edgeId) return e;
        const next = { ...e };
        delete next.clip;
        return next;
      }),
    });
  };

  // ── プレビュー用の動画 ──────────────────────────────────────────────────
  useEffect(() => {
    let revoked: string | null = null;
    (async () => {
      if (!data?.src) { setPreviewUrl(null); return; }
      try {
        // SceneManager の resolveAssetUrl と同じ順序。IDB 参照 → そのまま使える URL → manifest パス。
        const raw = data.src;
        const url = isIdbRef(raw)
          ? await resolveBlobRef(raw)
          : raw.startsWith('data:') || raw.startsWith('blob:')
            ? raw
            : resolveScenePath(sceneId, raw);
        revoked = url.startsWith('blob:') && isIdbRef(raw) ? url : null;
        setPreviewUrl(url);
      } catch {
        setPreviewUrl(null);
      }
    })();
    return () => { if (revoked) URL.revokeObjectURL(revoked); };
  }, [data?.src, sceneId]);

  /**
   * タイムラインを引いたら、ライブの 360 をそこへ動かす。
   *
   * 隠しプレビューを別に持つと「パネルで見ている絵」と「3D に出ている絵」が食い違い、
   * どのフレームに打ったのか分からなくなる。8K を 2 本復号することにもなる。
   * 見えているものが打つ対象、で揃える。
   */
  const seek = (t: number) => {
    const clamped = Math.max(0, Math.min(t, (data?.duration ?? 0) - 0.001));
    setPlayhead(clamped);
    const walker = getManager?.()?.getVideo360();
    if (walker) void walker.scrub(clamped);
    // ライブが無い場面 (プレビュー未起動) では何もしない。打つ対象が無いので。
  };

  const duration = data?.duration ?? 0;

  // いま貼られているバリアント。live の walker が正 ― パネルが別に覚えると、
  // プレビューを開き直したときに表示と実物がずれる。
  const activeVariantId = getManager?.()?.getVideo360()?.variantId ?? data?.defaultVariantId ?? null;
  const activeVariant = data?.variants?.find((v) => v.id === activeVariantId) ?? null;

  /**
   * オーサリング側の切替。家具・照明ストアも一緒に動かす ―
   * ビューアはそちらを見るので、ここだけ変えると Debug とビューアで食い違う。
   */
  const switchVariant = (v: Video360Variant) => {
    const ui = useUIStore.getState();
    if (v.furniture) ui.setFurniture(v.furniture);
    if (v.lighting) ui.setLighting(v.lighting);
    const sm = getManager?.();
    if (!sm) return;
    setBusy('動画を読み込み中…');
    void sm.getVideo360()?.setVariant(v.id).finally(() => setBusy(null));
  };

  const vpLabel = useMemo(() => {
    const m = new Map(plan.viewpoints.map((v) => [v.id, v.label]));
    return (id: string) => m.get(id) ?? id;
  }, [plan.viewpoints]);

  if (!data?.src) {
    return (
      <div style={S.stack}>
        <p className="ds-hint">
          このプランにまだ動画が入っていません。<b>全体タブ →「各プラン」</b>の ⇪ から、
          このプラン（{plan.label}）に 360°動画を入れてください。
        </p>
        <p className="ds-hint">
          動画はプランごとに持てます。プランを増やせば、間取り違い・時間帯違いを別の動画で出せます。
        </p>
      </div>
    );
  }

  const node = data.nodes.find((n) => n.viewpointId === selNode);
  const edge = data.edges.find((e) => e.id === selEdge);

  return (
    <div style={S.stack}>
      {/* ── 素材 ── */}
      <div className="ds-row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className="ds-sub">素材</span>
        <span className="ds-mono ds-v360-meta">
          {/* 出すのは **いま貼っているファイル名**。`sourceName` は元のレンダー名
              (A.00000.mp4) のままなので、バリアントを入れても文字列が変わらず
              「1 本しか入っていない」ように見えてしまう。 */}
          {activeVariant?.src ?? data.sourceName ?? data.src} / {duration.toFixed(1)}s @ {data.fps.toFixed(2)}fps
          {data.variants?.length ? ` / ${data.variants.length} 本` : ''}
        </span>
      </div>
      <div className="ds-row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
        <button type="button" className={BTN_PRIMARY} onClick={runAnalysis} disabled={!!busy}>
          {data.stills?.length ? '解析しなおす' : '動画を解析する'}
        </button>
        {canRunFfmpeg && (
          <button type="button" className={BTN} onClick={buildReverse} disabled={!!busy}>
            {data.srcReverse ? '反転素材を作りなおす' : '反転素材を作る'}
          </button>
        )}
        <FilePick
          label={data.srcReverse ? '反転素材を差し替え' : '反転素材を入れる'}
          accept="video/*"
          onPick={attachReverse}
        />
        <FilePick label="解析 JSON を読む" accept="application/json,.json" onPick={loadAnalysis} />
        <FilePick label="カメラ軌跡を読む" accept="application/json,.json" onPick={loadTrack} />
        <button type="button" className={BTN} onClick={() => void loadVariants()} disabled={!!busy}>
          {data.variants?.length ? 'バリアントを取り込みなおす' : 'バリアントを取り込む'}
        </button>
        <FilePick label="バリアント JSON を読む" accept="application/json,.json" onPick={loadVariants} />
      </div>
      <p className="ds-hint">
        本体の動画の差し替えは <b>全体タブ →「各プラン」</b>の ⇪ から。
      </p>
      {data.variants?.length ? (
        <>
          {/* オーサリング中にも切り替えられるようにする。ノードの時刻は 3 本で共通
              なので、夜だけ絵が破綻していないか等をここで確かめられないと、
              打ち終わってからビューアで気付くことになる。 */}
          <div className="ds-row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            <span className="ds-sub">描き分け</span>
            {data.variants.map((v) => (
              <button
                key={v.id}
                type="button"
                className={v.id === activeVariantId ? BTN_PRIMARY : BTN}
                onClick={() => switchVariant(v)}
                disabled={!!busy}
                title={v.src}
              >{v.label || v.id}</button>
            ))}
          </div>
          <p className="ds-hint">
            ビューアでは<b>家具・情景トグル</b>（左レールの「カラー」）で切り替わります。
            素材の無い組み合わせ（{data.variants.length < 4 ? '夜 × 家具なし など' : 'なし'}）は押せません。
          </p>
        </>
      ) : (
        <p className="ds-hint">
          家具あり / 家具なし / 夜 を切り替えたいときは、同じカメラ軌跡で描き分けた動画を
          <code>node scripts/video360/build-variants.mjs</code> に通してから
          <b>「バリアントを取り込む」</b>を押してください。フレーム数が一致していることを
          変換側が確かめるので、切り替えても場所が飛びません。
        </p>
      )}
      {data.track ? (
        <p className="ds-hint">
          カメラ軌跡 <b>{data.track.samples.length} サンプル</b>
          {data.track.source ? `（${data.track.source}）` : ''} を取り込み済み。
          ポイントの向き・間隔・ドアの位置は実座標から出ています。
        </p>
      ) : (
        <p className="ds-hint">
          <b>位置は推定していません。</b>カメラ軌跡を入れるまで、床ポイントは
          「カメラの正面へ再生秒数 × 歩行速度」の見立てで置かれます。
          3ds Max で <code>scripts/render/export-walk-track.ms</code> を読み込み、
          <code>VR_exportWalkTrack()</code> で書き出した JSON を入れてください。
        </p>
      )}
      {!data.srcReverse && (
        <p className="ds-hint">
          反転素材なしでも動きます（「戻る」が逆歩きではなく瞬間移動になります）。
          {canRunFfmpeg
            ? <> 逆歩きも見せたいときは<b>「反転素材を作る」</b>を押してください。この端末の ffmpeg が動いて、
              元の動画と一緒に <code>r2-uploads/video360/</code> に保存します。</>
            : <> 逆歩きも見せたいときは <code>bash scripts/video360/make-reverse.sh &lt;動画&gt;</code> で作って入れてください
              （この端末では ffmpeg が見つからないため、ボタンからは作れません）。</>}
        </p>
      )}
      {!data.stills?.length && (
        <p className="ds-hint">
          <b>「動画を解析する」</b>を押すと、撮影者が足を止めている区間をこの場で探します
          （ffmpeg も JSON の受け渡しも要りません）。1 分の素材でおよそ 15 秒。
          外で <code>scripts/video360/analyze.mjs</code> を回した JSON を読ませることもできます。
        </p>
      )}

      {/* ── タイムライン ── */}
      <Timeline
        data={data}
        playhead={playhead}
        selNode={selNode}
        selEdge={selEdge}
        onScrub={seek}
      />
      <div className="ds-row" style={{ gap: 6, marginTop: 6, alignItems: 'center' }}>
        <button type="button" className={BTN} onClick={() => {
          const walker = getManager?.()?.getVideo360();
          if (!walker) return;
          if (walker.isPlaying) walker.previewPause(); else walker.previewPlay();
        }}>▶ / ⏸</button>
        <button type="button" className={BTN} onClick={() => seek(playhead - 1 / data.fps)}>−1f</button>
        <button type="button" className={BTN} onClick={() => seek(playhead + 1 / data.fps)}>+1f</button>
        <span className="ds-mono ds-v360-time">{playhead.toFixed(3)}s</span>
      </div>

      {/* ── 打ち込み ── */}
      <div style={S.sec}>
        <span className="ds-label">打ち込み</span>
        <div className="ds-row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          <button
            type="button"
            className={BTN}
            data-active={authoring === 'point'}
            onClick={() => setAuthoring(authoring === 'point' ? 'off' : 'point')}
          >📍 ポイントを打つ (N)</button>
          <button
            type="button"
            className={BTN}
            data-active={authoring === 'door'}
            onClick={() => setAuthoring(authoring === 'door' ? 'off' : 'door')}
          >🚪 ドアを貼る (D)</button>
        </div>
        <p className="ds-hint">
          タイムラインを引くと <b>プレビューの 360 がそのまま動きます</b>。見えている絵が打つ対象です。<br />
          ポイントは<b>床をクリック</b>した場所に立ちます（視点・図面のドット・エッジまで一緒に作ります）。<br />
          ドアは<b>壁やドアをクリック</b>した向きに貼ります。開くアニメーションの区間は、下のエッジで整えてください。
        </p>
      </div>

      {/* ── 一括生成 ── */}
      <div style={S.sec}>
        <span className="ds-label">一括で打つ</span>
        {!!data.stills?.length && (
          <div className="ds-row" style={{ marginTop: 6 }}>
            <button type="button" className={BTN_PRIMARY} onClick={generate}>
              静止区間 {data.stills.length} 個からノードとエッジを起こす
            </button>
          </div>
        )}
        <div className="ds-row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            type="number" min={1} max={200} step={1}
            value={splitCount}
            onChange={(e) => setSplitCount(e.target.value)}
            className="ds-input"
            style={{ width: 68 }}
            aria-label="分割数"
          />
          <button
            type="button"
            className={BTN_PRIMARY}
            onClick={() => generateEvenly(Number(splitCount))}
          >等分して打つ</button>
          <button
            type="button"
            className={BTN}
            onClick={() => void loadWalkPlan()}
            disabled={!!busy}
            title="scripts/video360/plan-walk.mjs が出した案を読む"
          >ウォークスルー案を取り込む</button>
          <FilePick label="案 JSON を読む" accept="application/json,.json" onPick={loadWalkPlan} />
          <span className="ds-sub">
            {(() => {
              const n = Number(splitCount);
              if (!(n >= 1) || !Number.isFinite(n)) return '';
              return `→ ${n + 1} ポイント / ${(duration / n).toFixed(2)}s ごと`;
            })()}
          </span>
        </div>
        <div className="ds-row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            type="text"
            value={timeList}
            onChange={(e) => setTimeList(e.target.value)}
            placeholder="0, 3.1, 5.1, 8.4"
            className="ds-input"
            style={{ flex: 1, minWidth: 180 }}
            aria-label="秒の並び"
          />
          <button type="button" className={BTN} onClick={() => generateFromList(timeList)}>秒を並べて打つ</button>
        </div>
        <p className="ds-hint">
          <b>どちらも既存のノード・エッジを置き換えます</b>（視点は足りない分だけ作ります）。
          時刻はフレーム境界に丸めます — 丸めないと、シークが隣のフレームに着地するかが
          再生ごとに揺れて、止まっている絵がちらつきます。<br />
          <b>「ウォークスルー案を取り込む」</b>は、動画の動き量を実測して作った案
          (<code>node scripts/video360/plan-walk.mjs</code>) を読みます。止まるコマも扉の位置も
          実測から来るので、等分点をそのまま使うより絵がブレません。<br />
          秒の並びは <code>93f</code> のように <code>f</code> を付けるとフレーム番号として読みます
          （この素材は {data.fps.toFixed(2)}fps / {Math.round(duration * data.fps)} フレーム）。
        </p>
      </div>

      {/* ── ノード ── */}
      <div style={S.sec}>
        <span className="ds-label">ノード（{data.nodes.length}）</span>
        <div className="ds-row" style={{ marginTop: 6 }}>
          <button type="button" className={BTN} disabled={!data.nodes.length} onClick={buildThumbs}>
            停止フレームから下のシーンバーのサムネを作る
          </button>
        </div>
        <div className="ds-row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
          {data.nodes.map((n) => (
            <button
              key={n.viewpointId}
              type="button"
              className={BTN}
              data-active={selNode === n.viewpointId}
              onClick={() => { setSelNode(n.viewpointId); seek(n.t); }}
            >
              {vpLabel(n.viewpointId)} <span style={{ opacity: .6 }}>{n.t.toFixed(2)}s</span>
            </button>
          ))}
        </div>
        {node && (
          <div className="ds-row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <button type="button" className={BTN} onClick={() => {
              patch({ nodes: data.nodes.map((n) => n.viewpointId === node.viewpointId ? { ...n, t: +playhead.toFixed(3) } : n) });
            }}>停止フレーム ← 再生位置</button>
            <button type="button" className={BTN} onClick={() => {
              patch({
                nodes: data.nodes.filter((n) => n.viewpointId !== node.viewpointId),
                edges: data.edges.filter((e) => e.from !== node.viewpointId && e.to !== node.viewpointId),
              });
              setSelNode(null);
            }}>このノードを外す</button>
          </div>
        )}
        <p className="ds-hint">
          停止フレームは静止区間（青帯）の中から選んでください。歩行中のフレームで止めると、
          ブレた絵が貼りっぱなしになります。到着時にどちらを向くかは視点の 📷 が持ちます。
        </p>
      </div>

      {/* ── エッジ ── */}
      <div style={S.sec}>
        <span className="ds-label">エッジ（{data.edges.length}）</span>
        <div className="ds-row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
          {data.edges.map((e) => (
            <button
              key={e.id}
              type="button"
              className={BTN}
              data-active={selEdge === e.id}
              onClick={() => { setSelEdge(e.id); seek(e.range[0]); }}
            >
              {e.kind === 'door' ? '🚪 ' : ''}{vpLabel(e.from)} → {vpLabel(e.to)}
            </button>
          ))}
        </div>
        {edge && (
          <>
            <div className="ds-row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              <button type="button" className={BTN} onClick={() => updEdge(edge.id, { range: [+playhead.toFixed(3), edge.range[1]] })}>開始 ← 再生位置</button>
              <button type="button" className={BTN} onClick={() => updEdge(edge.id, { range: [edge.range[0], +playhead.toFixed(3)] })}>終了 ← 再生位置</button>
              <button type="button" className={BTN} onClick={() => updEdge(edge.id, { kind: edge.kind === 'door' ? 'walk' : 'door' })}>
                {edge.kind === 'door' ? 'ドア扱いをやめる' : 'ドアとして扱う'}
              </button>
            </div>
            <div className="ds-mono ds-v360-meta" style={{ marginTop: 4 }}>
              {edge.range[0].toFixed(3)} → {edge.range[1].toFixed(3)}s（{(edge.range[1] - edge.range[0]).toFixed(2)}s）
            </div>
            {edge.kind === 'door' && (
              <p className="ds-hint">
                ドアは床のポイントにしません。壁の上にあって床の位置ではないので、浮かぶマーカーで出ます。
              </p>
            )}
            {edge.kind !== 'door' && (
              <>
                <div className="ds-row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  <FilePick
                    label={edge.clip ? '専用クリップを差し替え' : '専用クリップを入れる'}
                    accept="video/*"
                    onPick={(f) => attachClip(f, edge.id, 'src')}
                  />
                  {edge.clip && (
                    <>
                      <FilePick label="逆走クリップ" accept="video/*" onPick={(f) => attachClip(f, edge.id, 'reverse')} />
                      <button type="button" className={BTN} onClick={() => clearClip(edge.id)}>専用クリップを外す</button>
                    </>
                  )}
                </div>
                {edge.clip && (
                  <div className="ds-mono ds-v360-meta" style={{ marginTop: 4 }}>
                    クリップ {edge.clip.sourceName ?? edge.clip.src} / {edge.clip.duration.toFixed(1)}s
                    {edge.clip.reverse ? ' / 逆走あり' : ' / 逆走なし（戻りは瞬間移動）'}
                  </div>
                )}
                <p className="ds-hint">
                  専用クリップを入れると、本編の区間ではなくそのクリップを 1 本流します。
                  隣の部屋は区間再生のまま、遠い移動だけ短いクリップに差し替えるのが狙いです。
                </p>
              </>
            )}
          </>
        )}
      </div>

      {/* ── 時刻イベント ── */}
      <div style={S.sec}>
        <span className="ds-label">説明の吹き出し（{data.events?.length ?? 0}）</span>
        <div className="ds-row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          <button type="button" className={BTN} onClick={() => {
            const text = prompt('この秒数で出す説明', '');
            if (!text) return;
            const at = +playhead.toFixed(2);
            patch({
              events: [...(data.events ?? []), { id: `ev-${Date.now().toString(36)}`, at, until: +(at + 4).toFixed(2), text }]
                .sort((a, b) => a.at - b.at),
            });
          }}>+ 再生位置に追加</button>
        </div>
        {(data.events ?? []).map((ev) => (
          <div key={ev.id} className="ds-row" style={{ gap: 6, marginTop: 6, alignItems: 'center' }}>
            <button type="button" className={BTN} onClick={() => seek(ev.at)}>{ev.at.toFixed(1)}s</button>
            <span className="ds-v360-eventtext" style={{ flex: 1 }}>{ev.text}</span>
            <button type="button" className={BTN} onClick={() => patch({ events: (data.events ?? []).filter((x) => x.id !== ev.id) })}>外す</button>
          </div>
        ))}
        <p className="ds-hint">
          歩いている最中に出したい説明が多いので、ノードではなく<b>尺</b>に紐づけます
          （「玄関を通過したあたりで断熱の話」のような、場所ではなく時間で決まるもの）。
          既定は 4 秒間の表示です。
        </p>
      </div>

      {/* ── 細かい調整 ── */}
      <div style={S.sec}>
        <span className="ds-label">床ポイントの見え方</span>
        <Num label="目線の高さ (m)" value={data.eyeHeight ?? DEFAULTS.eyeHeight} step={0.05} min={0.8} max={2.4}
          onChange={(v) => patch({ eyeHeight: v })} hint="床ポイントの遠近の付き方が変わります" />
        <Num label="ポイント間隔 (m)" value={data.stepSpacing ?? DEFAULTS.stepSpacing} step={0.1} min={1} max={6}
          onChange={(v) => patch({ stepSpacing: v })} hint="広げるとポイントが減ります（最大 4 個）" />
        <Num label="歩行速度 (m/s)" value={data.walkSpeed ?? DEFAULTS.walkSpeed} step={0.05} min={0.3} max={3}
          onChange={(v) => patch({ walkSpeed: v })} hint="カメラ軌跡が未設定のときだけ、秒数から距離を見立てるのに使います" />
        <Num label="ドアを置く距離 (m)" value={data.doorDistance ?? 2} step={0.1} min={0.5} max={8}
          onChange={(v) => patch({ doorDistance: v })} hint="ドアはクリックした向きへこの距離だけ進んだ点に貼ります" />
        <p className="ds-hint">
          ポイントの向きと間隔は、ふだんは<b>視点同士の実座標</b>から出します。図面にドットを置けば
          それで決まるので、方位を打ち込む必要はありません。
        </p>
      </div>

      {busy && <div className="ds-hint">{busy}</div>}
    </div>
  );

  function updEdge(id: string, p: Partial<Video360Edge>) {
    patch({ edges: data!.edges.map((e) => (e.id === id ? { ...e, ...p } : e)) });
  }
}

/** 静止区間・ノード・エッジ・再生位置を 1 本の帯にまとめて出す。 */
function Timeline({ data, playhead, selNode, selEdge, onScrub }: {
  data: Video360Walk;
  playhead: number;
  selNode: string | null;
  selEdge: string | null;
  onScrub: (t: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dur = data.duration || 1;
  const pct = (t: number) => `${(t / dur) * 100}%`;

  const scrub = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    onScrub(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * dur);
  };

  return (
    <div
      ref={ref}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); scrub(e.clientX); }}
      onPointerMove={(e) => { if (e.buttons) scrub(e.clientX); }}
      className="ds-v360-timeline"
      style={{ marginTop: 8 }}
    >
      {/* 静止区間 = ノードを置いてよい場所 */}
      {data.stills?.map((s, i) => (
        <div key={`s${i}`} className="ds-v360-still"
          style={{ left: pct(s.start), width: pct(Math.max(s.end - s.start, 0.05)) }} />
      ))}
      {/* エッジの再生範囲 */}
      {data.edges.map((e) => (
        <div key={e.id} className="ds-v360-edge" data-active={e.id === selEdge}
          style={{ left: pct(e.range[0]), width: pct(Math.max(e.range[1] - e.range[0], 0.05)) }} />
      ))}
      {/* ノード */}
      {data.nodes.map((n) => (
        <div key={n.viewpointId} className="ds-v360-node" data-active={n.viewpointId === selNode}
          style={{ left: pct(n.t) }} />
      ))}
      {/* 再生位置 */}
      <div className="ds-v360-playhead" style={{ left: pct(playhead) }} />
    </div>
  );
}

function FilePick({ label, accept, onPick }: { label: string; accept: string; onPick: (f: File) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className={BTN} onClick={() => ref.current?.click()}>{label}</button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onPick(f);
        }}
      />
    </>
  );
}

function Num({ label, value, step, min, max, onChange, hint }: {
  label: string; value: number; step: number; min: number; max: number;
  onChange: (v: number) => void; hint?: string;
}) {
  return (
    <div style={{ margin: '8px 0' }}>
      <div className="ds-row" style={{ gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="ds-sub">{label}</span>
        <span className="ds-mono ds-v360-num">{value.toFixed(2)}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(+e.target.value)}
        style={{ width: '100%' }}
      />
      {hint && <div className="ds-hint" style={{ marginTop: 2 }}>{hint}</div>}
    </div>
  );
}
