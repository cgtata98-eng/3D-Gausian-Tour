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
import type { Plan, Video360Edge, Video360Node, Video360Walk } from '../core/types';
import { useSceneStore } from '../store/scene-store';
import { isIdbRef, resolveBlobRef, saveBlob } from '../utils/idb';
import { resolveScenePath } from '../core/scene-manifest';
import { analyzeVideo360 } from '../utils/video360-analyze';
import { useUIStore } from '../store/ui-store';
import type { SceneManager } from '../engine/scene-manager';
import { Block } from './components';

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

  const patch = (p: Partial<Video360Walk>) => {
    if (!data) return;
    setPlanVideo360(plan.id, { ...data, ...p });
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
  const vpLabel = useMemo(() => {
    const m = new Map(plan.viewpoints.map((v) => [v.id, v.label]));
    return (id: string) => m.get(id) ?? id;
  }, [plan.viewpoints]);

  if (!data?.src) {
    return (
      <Block title="ウォークスルーの組み立て">
        <p className="ds-hint">
          このプランにまだ動画が入っていません。<b>全体タブ →「各プラン」</b>の ⇪ から、
          このプラン（{plan.label}）に 360°動画を入れてください。
        </p>
        <p className="ds-hint">
          動画はプランごとに持てます。プランを増やせば、間取り違い・時間帯違いを別の動画で出せます。
        </p>
      </Block>
    );
  }

  const node = data.nodes.find((n) => n.viewpointId === selNode);
  const edge = data.edges.find((e) => e.id === selEdge);

  return (
    <Block title="ウォークスルーの組み立て">
      {/* ── 素材 ── */}
      <div className="ds-row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className="ds-label">素材</span>
        <span className="ds-mono ds-v360-meta">
          {data.sourceName ?? data.src} / {duration.toFixed(1)}s @ {data.fps}fps
        </span>
      </div>
      <div className="ds-row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
        <button type="button" className="ds-pill ds-pill--primary" onClick={runAnalysis} disabled={!!busy}>
          {data.stills?.length ? '解析しなおす' : '動画を解析する'}
        </button>
        <FilePick
          label={data.srcReverse ? '反転素材を差し替え' : '反転素材を入れる'}
          accept="video/*"
          onPick={attachReverse}
        />
        <FilePick label="解析 JSON を読む" accept="application/json,.json" onPick={loadAnalysis} />
      </div>
      <p className="ds-hint">
        本体の動画の差し替えは <b>全体タブ →「各プラン」</b>の ⇪ から。
      </p>
      {!data.srcReverse && (
        <p className="ds-hint">
          反転素材なしでも動きます（「戻る」が逆歩きではなく瞬間移動になります）。
          逆歩きも見せたいときは <code>bash scripts/video360/make-reverse.sh &lt;動画&gt;</code> で作って入れてください。
          ブラウザ内では作れません — 動画を後ろから作り直す処理なので ffmpeg が要ります。
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
        <button type="button" className="ds-pill" onClick={() => {
          const walker = getManager?.()?.getVideo360();
          if (!walker) return;
          if (walker.isPlaying) walker.previewPause(); else walker.previewPlay();
        }}>▶ / ⏸</button>
        <button type="button" className="ds-pill" onClick={() => seek(playhead - 1 / data.fps)}>−1f</button>
        <button type="button" className="ds-pill" onClick={() => seek(playhead + 1 / data.fps)}>+1f</button>
        <span className="ds-mono ds-v360-time">{playhead.toFixed(3)}s</span>
      </div>

      {/* ── 打ち込み ── */}
      <div className="ds-sec">
        <span className="ds-label">打ち込み</span>
        <div className="ds-row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="ds-pill"
            data-active={authoring === 'point'}
            onClick={() => setAuthoring(authoring === 'point' ? 'off' : 'point')}
          >📍 ポイントを打つ (N)</button>
          <button
            type="button"
            className="ds-pill"
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
      {!!data.stills?.length && (
        <div className="ds-row" style={{ marginTop: 10 }}>
          <button type="button" className="ds-pill ds-pill--primary" onClick={generate}>
            静止区間 {data.stills.length} 個からノードとエッジを起こす
          </button>
        </div>
      )}

      {/* ── ノード ── */}
      <div className="ds-sec">
        <span className="ds-label">ノード（{data.nodes.length}）</span>
        <div className="ds-row" style={{ marginTop: 6 }}>
          <button type="button" className="ds-pill" disabled={!data.nodes.length} onClick={buildThumbs}>
            停止フレームから下のシーンバーのサムネを作る
          </button>
        </div>
        <div className="ds-row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
          {data.nodes.map((n) => (
            <button
              key={n.viewpointId}
              type="button"
              className="ds-pill"
              data-active={selNode === n.viewpointId}
              onClick={() => { setSelNode(n.viewpointId); seek(n.t); }}
            >
              {vpLabel(n.viewpointId)} <span style={{ opacity: .6 }}>{n.t.toFixed(2)}s</span>
            </button>
          ))}
        </div>
        {node && (
          <div className="ds-row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <button type="button" className="ds-pill" onClick={() => {
              patch({ nodes: data.nodes.map((n) => n.viewpointId === node.viewpointId ? { ...n, t: +playhead.toFixed(3) } : n) });
            }}>停止フレーム ← 再生位置</button>
            <button type="button" className="ds-pill" onClick={() => {
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
      <div className="ds-sec">
        <span className="ds-label">エッジ（{data.edges.length}）</span>
        <div className="ds-row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
          {data.edges.map((e) => (
            <button
              key={e.id}
              type="button"
              className="ds-pill"
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
              <button type="button" className="ds-pill" onClick={() => updEdge(edge.id, { range: [+playhead.toFixed(3), edge.range[1]] })}>開始 ← 再生位置</button>
              <button type="button" className="ds-pill" onClick={() => updEdge(edge.id, { range: [edge.range[0], +playhead.toFixed(3)] })}>終了 ← 再生位置</button>
              <button type="button" className="ds-pill" onClick={() => updEdge(edge.id, { kind: edge.kind === 'door' ? 'walk' : 'door' })}>
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
          </>
        )}
      </div>

      {/* ── 細かい調整 ── */}
      <div className="ds-sec">
        <span className="ds-label">床ポイントの見え方</span>
        <Num label="目線の高さ (m)" value={data.eyeHeight ?? DEFAULTS.eyeHeight} step={0.05} min={0.8} max={2.4}
          onChange={(v) => patch({ eyeHeight: v })} hint="床ポイントの遠近の付き方が変わります" />
        <Num label="ポイント間隔 (m)" value={data.stepSpacing ?? DEFAULTS.stepSpacing} step={0.1} min={1} max={6}
          onChange={(v) => patch({ stepSpacing: v })} hint="広げるとポイントが減ります（最大 4 個）" />
        <Num label="歩行速度 (m/s)" value={data.walkSpeed ?? DEFAULTS.walkSpeed} step={0.05} min={0.3} max={3}
          onChange={(v) => patch({ walkSpeed: v })} hint="視点の座標が未設定のときだけ、秒数から距離を見立てるのに使います" />
        <p className="ds-hint">
          ポイントの向きと間隔は、ふだんは<b>視点同士の実座標</b>から出します。図面にドットを置けば
          それで決まるので、方位を打ち込む必要はありません。
        </p>
      </div>

      {busy && <div className="ds-hint">{busy}</div>}
    </Block>
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
      <button type="button" className="ds-pill" onClick={() => ref.current?.click()}>{label}</button>
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
    <div style={{ marginTop: 8 }}>
      <div className="ds-row" style={{ gap: 8, alignItems: 'center' }}>
        <span className="ds-v360-numlabel">{label}</span>
        <input
          type="range" min={min} max={max} step={step} value={value}
          onChange={(e) => onChange(+e.target.value)}
          style={{ flex: 1 }}
        />
        <span className="ds-mono ds-v360-num">{value.toFixed(2)}</span>
      </div>
      {hint && <div className="ds-hint" style={{ marginTop: 2 }}>{hint}</div>}
    </div>
  );
}
