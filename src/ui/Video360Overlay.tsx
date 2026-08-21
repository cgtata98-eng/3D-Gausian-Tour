/**
 * 360°動画ウォークスルーの床ポイント (V1).
 *
 * 不動産のウォークスルーでおなじみの、床に落ちたリング。押すとそこまで歩く。
 *
 * DOM のチップでは作れない ― リングは床の面に寝ていないと床に乗って見えず、
 * 見る向きによって楕円に潰れる必要がある。なので円周を 48 点に割り、
 * SceneManager の `worldToScreen` で 1 点ずつ投影して SVG のパスに落とす。
 * 遠近はエンジンのカメラがそのまま付けてくれるので、自前の行列を持たない。
 *
 * 当たり判定も同じ多角形で取る。床の座標で取ってはいけない ― 水平線に近いところを
 * 見ているとカーソル 1px が床の上では数メートルに化け、狙ったのと別のポイントを掴む。
 * 投影済みの多角形に対する内外判定なら、見えているとおりに拾える。
 *
 * ポイントの向きと間隔は **視点同士の実座標** から出す。図面にドットを置けば
 * それで決まるので、方位を別に打ち込む必要がない (打ち込めるようにすると
 * 図面とズレたときにどちらが正か分からなくなる)。
 */
import { useEffect, useRef, useState } from 'react';
import type { Plan, Viewpoint } from '../core/types';
import type { SceneManager } from '../engine/scene-manager';
import type { Video360Exit, Video360State } from '../engine/video360-walk';
import { useSceneStore } from '../store/scene-store';
import { useUIStore } from '../store/ui-store';

const SEGMENTS = 48;
const RING_INNER = 0.355;
const RING_OUTER = 0.415;
const DEFAULT_EYE = 1.6;
const DEFAULT_SPEED = 1.05;
const DEFAULT_SPACING = 2.4;
/** 一番近いポイントでもこれ以上は離す。足元だと押しづらい。 */
const MIN_REACH = 1.9;
const MAX_REACH = 9;

interface Marker {
  exit: Video360Exit;
  /** 床の上のワールド座標。 */
  world: [number, number, number];
  /** そこで止まる時刻 (順再生の時間軸)。 */
  stopAtFwd: number;
  /** 終点なら到着する viewpointId、途中なら null。 */
  arrive: string | null;
  label: string;
  /** カメラからの距離。奥から描くための並べ替えに使う。 */
  dist: number;
}


/**
 * 打ち込み (オーサリング).
 *
 * 「そこにポイントを打つ」を素直に作ると、床のどこを指したかを知る必要がある。
 * カメラは原点、床は y = カメラ高さ − 目線 の水平面と決めているので、
 * クリック方向と床面の交点を取ればワールド座標が出る。その座標をそのまま
 * 視点の position に入れれば、床ポイントの向きも図面のドットも同時に決まる。
 *
 * 打つ時刻は「いま 360 に出ているフレーム」。パネルのタイムラインは live scrub を
 * 通っているので、見えている絵と打つ対象が必ず一致する。
 */
function usePlacement(eye: number) {
  const authoring = useUIStore((s) => s.video360Authoring);
  const setAuthoring = useUIStore((s) => s.setVideo360Authoring);

  /** 画面座標 → ワールド方向。カメラの基底で組み立てる。 */
  const dirFromScreen = (sm: SceneManager, px: number, py: number): [number, number, number] | null => {
    const cv = sm.getCanvas();
    if (!cv) return null;
    const r = cv.getBoundingClientRect();
    const fov = sm.getCameraFov();
    const tanH = Math.tan((fov * Math.PI) / 360);
    const aspect = r.width / r.height;
    const ndcX = ((px - r.left) / r.width) * 2 - 1;
    const ndcY = 1 - ((py - r.top) / r.height) * 2;
    const fwd = sm.getCameraForward();
    const up: [number, number, number] = [0, 1, 0];
    // right = forward × up。真上/真下を向いていると縮退するので保険を入れる。
    let rx = fwd[2] * up[1] - fwd[1] * up[2];
    let ry = fwd[0] * up[2] - fwd[2] * up[0];
    let rz = fwd[1] * up[0] - fwd[0] * up[1];
    let rl = Math.hypot(rx, ry, rz);
    if (rl < 1e-4) { rx = 1; ry = 0; rz = 0; rl = 1; }
    rx /= rl; ry /= rl; rz /= rl;
    // up' = right × forward
    const ux = ry * fwd[2] - rz * fwd[1];
    const uy = rz * fwd[0] - rx * fwd[2];
    const uz = rx * fwd[1] - ry * fwd[0];

    const sx = ndcX * tanH * aspect;
    const sy = ndcY * tanH;
    const d: [number, number, number] = [
      fwd[0] + rx * sx + ux * sy,
      fwd[1] + ry * sx + uy * sy,
      fwd[2] + rz * sx + uz * sy,
    ];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    return [d[0] / l, d[1] / l, d[2] / l];
  };

  /** クリック方向が床に当たる点。水平線より上を指していたら null。 */
  const floorHit = (sm: SceneManager, px: number, py: number): [number, number, number] | null => {
    const dir = dirFromScreen(sm, px, py);
    if (!dir || dir[1] >= -0.02) return null;
    const cam = sm.getCameraWorldPosition();
    const t = eye / -dir[1];
    if (t > 40) return null;                 // 水平線ぎわは距離が暴れるので拾わない
    return [cam[0] + dir[0] * t, cam[1] - eye, cam[2] + dir[2] * t];
  };

  /** クリック方向を yaw / pitch (度) に直す。ドアのマークはここに貼る。 */
  const anglesAt = (sm: SceneManager, px: number, py: number): { yaw: number; pitch: number } | null => {
    const dir = dirFromScreen(sm, px, py);
    if (!dir) return null;
    return {
      yaw: +((Math.atan2(-dir[0], -dir[2]) * 180) / Math.PI).toFixed(1),
      pitch: +((Math.asin(Math.max(-1, Math.min(1, dir[1]))) * 180) / Math.PI).toFixed(1),
    };
  };

  return { authoring, setAuthoring, floorHit, anglesAt };
}

interface Props {
  getManager: () => SceneManager | null;
}

export function Video360Overlay({ getManager }: Props) {
  const manifest = useSceneStore((s) => s.manifest);
  const activePlanId = useSceneStore((s) => s.activePlanId);
  const [walkState, setWalkState] = useState<Video360State | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<Marker[]>([]);
  const polysRef = useRef<Array<{ x: number; y: number }[]>>([]);
  const hoverRef = useRef<number>(-1);
  const doorsRef = useRef<HTMLDivElement>(null);
  // 描画ループが読む値は ref に置く。props の関数も配列も毎レンダーで別物になるので、
  // 依存配列に入れると rAF を毎回張り直すことになる (実際そうなっていた)。
  const managerRef = useRef(getManager);
  const doorListRef = useRef<{ id: string; yaw: number; pitch: number; label: string }[]>([]);

  const plan: Plan | undefined = manifest?.plans?.find((p) => p.id === activePlanId);
  const walkData = plan?.video360;
  const eyeHeight = walkData?.eyeHeight ?? DEFAULT_EYE;
  // ドアのマーク。床の位置ではないので方向だけを持ち、浮かぶ印として出す。
  const doorList = (walkData?.edges ?? [])
    .filter((e) => e.kind === 'door')
    .map((e) => ({ id: e.id, yaw: e.doorYaw ?? 0, pitch: e.doorPitch ?? 0, label: e.label ?? 'ドア', edge: e }));
  const { authoring, setAuthoring, floorHit, anglesAt } = usePlacement(eyeHeight);

  // エンジンから状態を受け取る。React の再描画はモード/ノードが変わったときだけで、
  // 毎フレームの投影は下の rAF が DOM を直接書き換える。
  useEffect(() => {
    const sm = getManager();
    if (!sm) return;
    sm.setVideo360Listener((s) => setWalkState(s));
    return () => sm.setVideo360Listener(null);
  }, [getManager]);

  // ── ポイントの組み立て ──────────────────────────────────────────────────
  useEffect(() => {
    const sm = getManager();
    const walker = sm?.getVideo360();
    if (!sm || !walker || !plan || !walkData || !walkState) {
      markersRef.current = [];
      return;
    }
    const camPos = sm.getCameraWorldPosition?.() ?? null;
    if (!camPos) { markersRef.current = []; return; }

    const eye = walkData.eyeHeight ?? DEFAULT_EYE;
    const spacing = walkData.stepSpacing ?? DEFAULT_SPACING;
    const speed = walkData.walkSpeed ?? DEFAULT_SPEED;
    const vpById = new Map(plan.viewpoints.map((v: Viewpoint) => [v.id, v]));

    /** 図面に置いたドットを優先。無ければ実カメラ位置。 */
    const groundOf = (id: string): [number, number] | null => {
      const vp = vpById.get(id);
      if (!vp) return null;
      return vp.mapPosition ? [vp.mapPosition[0], vp.mapPosition[1]] : [vp.position[0], vp.position[2]];
    };

    /** 狙った時刻の近くで、止まっても絵がブレない時刻に寄せる。 */
    const snap = (t: number, lo: number, hi: number): number => {
      const calm = walkData.calmTimes;
      if (!calm || calm.length === 0) return t;
      let best = t;
      let bestD = 0.5;                        // ±0.5 秒より遠くへは飛ばさない
      for (const c of calm) {
        if (c < lo || c > hi) continue;
        const d = Math.abs(c - t);
        if (d < bestD) { bestD = d; best = c; }
      }
      return best;
    };

    const out: Marker[] = [];

    /** 出口に沿ってポイントを並べる。fromFrac = いま居る位置のエッジ内割合。 */
    const along = (ex: Video360Exit, fromFrac: number) => {
      if (ex.kind === 'door') return;         // ドアは床の位置ではない
      const fromId = ex.dir === 1 ? ex.edge.from : ex.edge.to;
      const a = groundOf(fromId);
      const b = groundOf(ex.to);
      const [r0, r1] = ex.edge.range;
      const seconds = Math.max(0.4, r1 - r0);

      let dirX: number;
      let dirZ: number;
      let full: number;
      if (a && b && Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.3) {
        // 図面 / 実座標が入っている ― 向きも距離もそこから出せる。
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        full = Math.hypot(dx, dz);
        dirX = dx / full;
        dirZ = dz / full;
      } else {
        // 視点がまだ置かれていない。せめて距離だけは尺から見立て、
        // 向きはカメラの正面に置く (下のポイント一覧からは行けるので詰みはしない)。
        const fwd = sm.getCameraForward?.();
        if (!fwd) return;
        const len = Math.hypot(fwd[0], fwd[2]) || 1;
        dirX = fwd[0] / len;
        dirZ = fwd[2] / len;
        full = seconds * speed;
      }

      const remain = Math.min(full * (1 - fromFrac), MAX_REACH);
      if (remain < 0.4) return;
      const count = Math.max(1, Math.min(4, Math.round(remain / spacing)));
      for (let i = 1; i <= count; i++) {
        const local = i / count;
        const d = Math.max(MIN_REACH, remain * local);
        const isEnd = i === count;
        const absFrac = fromFrac + (1 - fromFrac) * local;
        const rawStop = walker.fracToFwd(ex.edge, ex.dir, absFrac);
        out.push({
          exit: ex,
          world: [camPos[0] + dirX * d, camPos[1] - eye, camPos[2] + dirZ * d],
          // 終点はノードなので、その `t` に任せる。途中だけ寄せる。
          stopAtFwd: isEnd ? walker.fracToFwd(ex.edge, ex.dir, 1) : snap(rawStop, r0, r1),
          arrive: isEnd ? ex.to : null,
          label: isEnd ? ex.label : `${ex.label}（途中）`,
          dist: d,
        });
      }
    };

    if (walkState.mode === 'idle' && walkState.nodeId) {
      for (const ex of walker.exitsOf(walkState.nodeId)) along(ex, 0);
    } else if (walkState.mode === 'free' && walkState.edge) {
      // 道の途中に立っている。前に進む先と、来た道を戻る先の両方を出す。
      // ここを出さないと、途中で止まった瞬間に行き先が消えて動けなくなる。
      const dir = walker.dirWithin();
      const fwdEx = walker.exitFor(walkState.edge, dir);
      const backEx = walker.exitFor(walkState.edge, dir === 1 ? -1 : 1);
      const frac = walker.fracWithin(walkState.edge);
      if (fwdEx) along(fwdEx, frac);
      if (backEx) along(backEx, 1 - frac);
    }

    // 奥から描く。手前のリングが上に乗る。
    out.sort((p, q) => q.dist - p.dist);
    markersRef.current = out;
    hoverRef.current = -1;
  }, [getManager, plan, walkData, walkState]);


  /** いま 360 に出ているフレームの時刻。打つ対象はこれ。 */
  const shownTime = (): number => getManager()?.getVideo360()?.getState().time ?? 0;

  /** 床にポイントを打つ。視点を作り、その時刻のノードとして紐づける。 */
  const placePoint = (world: [number, number, number]) => {
    if (!plan) return;
    const store = useSceneStore.getState();
    const t = +shownTime().toFixed(3);
    const n = (plan.video360?.nodes.length ?? 0) + 1;
    const id = `v360-${Date.now().toString(36)}`;
    // 視点の target は「いま向いている方向」。到着したときこの向きになる。
    const sm = getManager();
    const fwd = sm?.getCameraForward() ?? [0, 0, -1];
    store.addViewpoint({
      id,
      label: `ポイント ${n}`,
      position: [+world[0].toFixed(3), +(world[1] + eyeHeight).toFixed(3), +world[2].toFixed(3)],
      target: [
        +(world[0] + fwd[0]).toFixed(3),
        +(world[1] + eyeHeight + fwd[1]).toFixed(3),
        +(world[2] + fwd[2]).toFixed(3),
      ],
      fov: sm?.getCameraFov() ?? 75,
      // 図面のドットも同じ場所に置いておく。床ポイントの向きはここから出る。
      mapPosition: [+world[0].toFixed(3), +world[2].toFixed(3)],
    });
    const cur = plan.video360;
    const nodes = [...(cur?.nodes ?? []), { viewpointId: id, t }];
    // 直前のノードから自動でエッジを引く。時刻の前後で並べ直してから繋ぐので、
    // 打つ順番が前後してもルートは時系列どおりになる。
    const sorted = [...nodes].sort((a, b) => a.t - b.t);
    const edges = [];
    for (let i = 0; i + 1 < sorted.length; i++) {
      const from = sorted[i];
      const to = sorted[i + 1];
      const prevEdge = cur?.edges.find((e) => e.from === from.viewpointId && e.to === to.viewpointId);
      edges.push(prevEdge ?? {
        id: `e-${from.viewpointId}-${to.viewpointId}`,
        from: from.viewpointId,
        to: to.viewpointId,
        range: [from.t, to.t] as [number, number],
        kind: 'walk' as const,
      });
    }
    store.setPlanVideo360(plan.id, {
      ...(cur ?? { src: '', duration: 0, fps: 30 }),
      src: cur?.src ?? '',
      duration: cur?.duration ?? 0,
      fps: cur?.fps ?? 30,
      nodes: sorted,
      edges,
    });
  };

  /** ドアのマークを貼る。押すと開くアニメーションの区間を後で割り当てる。 */
  const placeDoor = (yaw: number, pitch: number) => {
    if (!plan?.video360) return;
    const cur = plan.video360;
    const t = shownTime();
    // いま居るノード (無ければ直近) を起点にする。ドアは「そこから開ける」もの。
    const near = [...cur.nodes].sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
    if (!near) return;
    useSceneStore.getState().setPlanVideo360(plan.id, {
      ...cur,
      edges: [...cur.edges, {
        id: `door-${Date.now().toString(36)}`,
        from: near.viewpointId,
        to: near.viewpointId,
        range: [t, Math.min(t + 2, cur.duration)] as [number, number],
        label: 'ドアを開ける',
        kind: 'door' as const,
        doorYaw: yaw,
        doorPitch: pitch,
      }],
    });
  };

  // キーでも打てるようにする。画面中央 = いま見ている先に打つ。
  // マウスを構えずに「ここ」と決められるほうが、動画を送りながらの作業では速い。
  useEffect(() => {
    if (authoring === 'off') return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
      const sm = getManager();
      const cv = sm?.getCanvas();
      if (!sm || !cv) return;
      const r = cv.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (e.code === 'KeyN') {
        e.preventDefault();
        const hit = floorHit(sm, cx, cy);
        if (hit) placePoint(hit);
      } else if (e.code === 'KeyD') {
        e.preventDefault();
        const a = anglesAt(sm, cx, cy);
        if (a) placeDoor(a.yaw, a.pitch);
      } else if (e.code === 'Escape') {
        setAuthoring('off');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ref の書き換えはレンダー中にやらない。描画後に効けば十分で、
  // レンダー中に触ると React が更新を取りこぼす原因になる。
  useEffect(() => {
    managerRef.current = getManager;
    doorListRef.current = doorList;
  });

  // ── 毎フレームの投影 ────────────────────────────────────────────────────
  // React の再描画は通さない。カメラをドラッグしている間ずっと再レンダリングすると
  // 見回しがそのまま重くなる (ScenePinsOverlay と同じ理由・同じ作り)。
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const sm = managerRef.current();
      const svg = svgRef.current;
      if (!sm || !svg) return;

      // オーバーレイはキャンバスにぴったり重ねる。`worldToScreen` の戻り値は
      // キャンバス基準なので、全画面前提で置くと Debug (プレビューが右半分) でズレるし、
      // 左パネルの上にリングがはみ出す。
      const cv = sm.getCanvas();
      if (!cv) return;
      const r = cv.getBoundingClientRect();
      svg.style.left = `${r.left}px`;
      svg.style.top = `${r.top}px`;
      svg.style.width = `${r.width}px`;
      svg.style.height = `${r.height}px`;

      const markers = markersRef.current;
      const polys: Array<{ x: number; y: number }[]> = [];
      const paths = svg.querySelectorAll<SVGPathElement>('path[data-ring]');

      for (let i = 0; i < paths.length; i++) {
        const el = paths[i];
        const m = markers[i];
        if (!m) { el.setAttribute('d', ''); polys.push([]); continue; }
        const outer: { x: number; y: number }[] = [];
        const inner: { x: number; y: number }[] = [];
        let visible = true;
        for (let k = 0; k < SEGMENTS; k++) {
          const a = (k / SEGMENTS) * Math.PI * 2;
          const c = Math.cos(a);
          const s = Math.sin(a);
          const po = sm.worldToScreen([m.world[0] + c * RING_OUTER, m.world[1], m.world[2] + s * RING_OUTER]);
          const pi = sm.worldToScreen([m.world[0] + c * RING_INNER, m.world[1], m.world[2] + s * RING_INNER]);
          if (!po || !pi) { visible = false; break; }
          outer.push(po);
          inner.push(pi);
        }
        if (!visible) { el.setAttribute('d', ''); polys.push([]); continue; }
        // 外周を時計回り、内周を反時計回りに繋いで evenodd で穴を開ける。
        const d = `${ringPath(outer)} ${ringPath(inner.slice().reverse())}`;
        el.setAttribute('d', d);
        const hovered = hoverRef.current === i;
        el.setAttribute('opacity', String(hovered ? 0.95 : m.exit.kind === 'back' ? 0.34 : 0.5));
        polys.push(outer);
      }
      polysRef.current = polys;

      // ホバー中のポイントに二重リングを重ねる (スクショの手前のリングと同じ扱い)。
      const halo = svg.querySelector<SVGPathElement>('path[data-halo]');
      const hi = hoverRef.current;
      if (halo) {
        const m = markers[hi];
        if (!m) halo.setAttribute('d', '');
        else {
          const a1: { x: number; y: number }[] = [];
          const a2: { x: number; y: number }[] = [];
          let ok = true;
          for (let k = 0; k < SEGMENTS; k++) {
            const a = (k / SEGMENTS) * Math.PI * 2;
            const c = Math.cos(a);
            const s = Math.sin(a);
            const p1 = sm.worldToScreen([m.world[0] + c * (RING_OUTER + 0.098), m.world[1], m.world[2] + s * (RING_OUTER + 0.098)]);
            const p2 = sm.worldToScreen([m.world[0] + c * (RING_OUTER + 0.075), m.world[1], m.world[2] + s * (RING_OUTER + 0.075)]);
            if (!p1 || !p2) { ok = false; break; }
            a1.push(p1);
            a2.push(p2);
          }
          halo.setAttribute('d', ok ? `${ringPath(a1)} ${ringPath(a2.slice().reverse())}` : '');
        }
      }

      // ドアの印。床ではなく壁の上にあるので、方向だけを投影して浮かべる。
      const doorRoot = doorsRef.current;
      if (doorRoot) {
        const doors = doorRoot.children;
        for (let i = 0; i < (doors?.length ?? 0); i++) {
          const el = doors![i] as HTMLElement;
          const d = doorListRef.current[i];
          if (!d) { el.style.display = 'none'; continue; }
          const p = projectDirection(sm, d.yaw, d.pitch);
          if (!p) { el.style.display = 'none'; continue; }
          el.style.display = 'block';
          el.style.left = `${r.left + p.x}px`;
          el.style.top = `${r.top + p.y}px`;
        }
      }

      // 行き先名。リングは 3D なので、文字は DOM で重ねたほうが読みやすい。
      const label = labelRef.current;
      if (label) {
        const m = markers[hi];
        const poly = polys[hi];
        if (!m || !poly || poly.length === 0) {
          label.style.display = 'none';
        } else {
          let cx = 0;
          let top = Infinity;
          for (const p of poly) { cx += p.x; if (p.y < top) top = p.y; }
          label.style.display = 'block';
          label.textContent = m.label;
          label.style.left = `${r.left + cx / poly.length}px`;
          label.style.top = `${r.top + top - 10}px`;
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 打ち込み中は状態が無くても描く。ノードが 1 つも無いところから打ち始めるので、
  // 「歩ける状態になるまで照準が出ない」では 1 つ目が打てない。
  if (!walkData || (!walkState && authoring === 'off')) return null;

  const pick = (ev: React.PointerEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return -1;
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    // 手前 (= 配列の後ろ) から見る。奥から描いているので、重なったら手前が勝つ。
    for (let i = polysRef.current.length - 1; i >= 0; i--) {
      if (pointInPolygon(x, y, polysRef.current[i])) return i;
    }
    return -1;
  };

  return (
    <>
      <svg
        ref={svgRef}
        className="ds-v360-rings"
        data-authoring={authoring}
        onPointerMove={(e) => { hoverRef.current = pick(e); }}
        onPointerLeave={() => { hoverRef.current = -1; }}
        onPointerDown={(e) => {
          const sm = getManager();
          if (authoring !== 'off' && sm) {
            // 打ち込み中はリングを踏んでも移動しない。打ちたいのに移動するのが一番いらつく。
            e.stopPropagation();
            if (authoring === 'point') {
              const hit = floorHit(sm, e.clientX, e.clientY);
              if (hit) placePoint(hit);
            } else {
              const a = anglesAt(sm, e.clientX, e.clientY);
              if (a) placeDoor(a.yaw, a.pitch);
            }
            return;
          }
          const i = pick(e);
          if (i < 0) return;
          e.stopPropagation();
          const m = markersRef.current[i];
          const walker = sm?.getVideo360();
          if (m && walker) void walker.travelTo(m.exit, m.stopAtFwd, m.arrive);
        }}
      >
        {/* リングの本体。多角形は毎フレーム rAF が書き換える。 */}
        {Array.from({ length: 16 }, (_, i) => (
          <path key={i} data-ring={i} d="" fill="#fff" fillRule="evenodd" opacity="0.5" />
        ))}
        <path data-halo="1" d="" fill="#fff" fillRule="evenodd" opacity="0.85" />
      </svg>
      <div ref={labelRef} className="ds-v360-label" style={{ display: 'none' }} />
      <div ref={doorsRef} className="ds-v360-doors">
        {doorList.map((d) => (
          <button
            key={d.id}
            type="button"
            className="ds-v360-door"
            title={d.label}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (authoring !== 'off') return;
              const walker = getManager()?.getVideo360();
              const ex = walker?.exitFor(d.edge, 1);
              if (walker && ex) void walker.travel(ex);
            }}
          >🚪</button>
        ))}
      </div>
      {authoring !== 'off' && (
        <div className="ds-v360-aim">
          <div className="ds-v360-aim__cross" />
          <div className="ds-v360-aim__hint">
            {authoring === 'point'
              ? '床をクリック / N キーで中央に ポイントを打つ'
              : '壁やドアをクリック / D キーで中央に ドアを貼る'}
            <span className="ds-v360-aim__esc">Esc で終了</span>
          </div>
        </div>
      )}
    </>
  );
}

/** yaw/pitch (度) の方向を画面座標へ。ドアの印を置くのに使う。背後なら null。 */
function projectDirection(sm: SceneManager, yawDeg: number, pitchDeg: number): { x: number; y: number } | null {
  const cam = sm.getCameraWorldPosition();
  const y = (yawDeg * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  const cp = Math.cos(p);
  // 十分遠くに置いた 1 点として投影する。方向だけ合っていればよい。
  const R = 8;
  return sm.worldToScreen([
    cam[0] - Math.sin(y) * cp * R,
    cam[1] + Math.sin(p) * R,
    cam[2] - Math.cos(y) * cp * R,
  ]);
}

/** 投影済みの点列を閉じたパスにする。 */
function ringPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return '';
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) d += `L${pts[i].x.toFixed(1)},${pts[i].y.toFixed(1)}`;
  return `${d}Z`;
}

/** 多角形の内外判定 (ray casting)。 */
function pointInPolygon(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  if (!poly || poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
