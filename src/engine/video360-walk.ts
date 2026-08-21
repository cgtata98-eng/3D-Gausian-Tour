/**
 * 360°動画ウォークスルーの再生制御 (V1) — 描画には触らない純粋な状態機械。
 *
 * 仕掛け:
 *   ノード = 撮影者が足を止めている時刻。動画を一時停止し、そのフレームを
 *            パノラマとして貼り続ける。見回せるが世界は止まる。
 *   エッジ = ノード間の「歩き」の時間区間。行き先を押すとその区間だけ再生して止める。
 *   逆走   = 反転素材の対応時刻を再生する。動画は前にしか進まないので、
 *            戻る演出には反転素材が別に要る。無ければ瞬間移動に落ちる。
 *
 * `node.t` (停止中に見せる 1 フレーム) と `edge.range` (実際に再生する区間) を
 * 別に持つのが要点。同じにすると静止区間の「たまり」を毎回再生し直すことになる。
 *
 * このクラスはスカイボックスも UI も知らない。動画要素と「いまどうなっているか」を
 * 持つだけで、絵を出すのは SceneManager、ポイントを描くのは React 側。
 */
import type { Video360Edge, Video360Walk } from '../core/types';

export type Video360Mode = 'idle' | 'travel' | 'free' | 'scrub';

export interface Video360State {
  mode: Video360Mode;
  /** 立っているノードの viewpointId。道の途中 (`free`) では null。 */
  nodeId: string | null;
  /** 進行中 / 直前のエッジ。`free` からの再開に使う。 */
  edge: Video360Edge | null;
  /** 順再生の時間軸での現在位置 (秒)。 */
  time: number;
  /** 直近のシーク所要 (ms)。8K の体感を測るのに使う。 */
  seekMs: number;
}

/** ノードから行ける先。前進エッジと、来た道を戻る逆走エッジの両方。 */
export interface Video360Exit {
  edge: Video360Edge;
  /** 1 = 順再生、-1 = 逆走。 */
  dir: 1 | -1;
  /** 行き先の viewpointId。 */
  to: string;
  kind: 'walk' | 'door' | 'back';
  label: string;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export interface Video360WalkerOptions {
  data: Video360Walk;
  /** `src` / `srcReverse` を実際に fetch できる URL に直す。 */
  resolveUrl: (src: string) => Promise<string>;
  /** ノードに到着したとき。カメラを動かすのは呼び出し側 (既存の applyViewpointPose)。 */
  onArrive: (viewpointId: string) => void;
  /** 状態が変わるたび。React はこれを見て描き直す。 */
  onState: (s: Video360State) => void;
  /** 動画が新しいフレームを出した / シークが着地した。テクスチャを上げ直す合図。 */
  onFrame: () => void;
  /** viewpointId のラベル。行き先ボタンの文言に使う。 */
  labelOf: (viewpointId: string) => string;
}

export class Video360Walker {
  private readonly data: Video360Walk;
  private readonly opts: Video360WalkerOptions;

  /** 順再生と反転素材。同じ絵なので、対応する時刻に両方を置いておけば
   *  どちらをテクスチャ元にしても継ぎ目が出ない。 */
  private fwd!: HTMLVideoElement;
  private rev: HTMLVideoElement | null = null;
  private activeVideo!: HTMLVideoElement;

  /** 移動の世代番号。新しい移動が始まると増え、古い移動は自分の番号が
   *  変わったことに気付いて静かに降りる。「歩いている途中で別の場所を押す」に要る。 */
  private navToken = 0;
  private destroyed = false;
  private feedVideo: HTMLVideoElement | null = null;

  private state: Video360State = {
    mode: 'idle', nodeId: null, edge: null, time: 0, seekMs: 0,
  };

  constructor(opts: Video360WalkerOptions) {
    this.opts = opts;
    this.data = opts.data;
  }

  // ── 読み込み ────────────────────────────────────────────────────────────

  async load(): Promise<void> {
    const mk = async (src: string) => {
      const v = document.createElement('video');
      v.src = await this.opts.resolveUrl(src);
      v.preload = 'auto';
      v.muted = true;
      v.playsInline = true;
      v.crossOrigin = 'anonymous';
      v.loop = false;
      return v;
    };
    this.fwd = await mk(this.data.src);
    this.rev = this.data.srcReverse ? await mk(this.data.srcReverse) : null;
    this.activeVideo = this.fwd;

    await Promise.all([this.fwd, this.rev].filter(Boolean).map((v) => new Promise<void>((res) => {
      const el = v as HTMLVideoElement;
      if (el.readyState >= 2) { res(); return; }
      el.addEventListener('loadeddata', () => res(), { once: true });
      el.addEventListener('error', () => res(), { once: true });
      setTimeout(res, 20000);
    })));

    // 自動再生の許可を先に取っておく。ユーザー操作の文脈で呼ばれる前提。
    for (const v of [this.fwd, this.rev]) {
      if (!v) continue;
      try { await v.play(); v.pause(); } catch { /* muted なので基本通る */ }
    }
  }

  /** スカイボックスに貼る動画要素。SceneManager が使う。 */
  get videoElement(): HTMLVideoElement { return this.activeVideo; }
  get nodes() { return this.data.nodes; }
  get edges() { return this.data.edges; }
  getState(): Video360State { return this.state; }

  destroy(): void {
    this.destroyed = true;
    this.navToken++;
    this.feedVideo = null;
    for (const v of [this.fwd, this.rev]) {
      if (!v) continue;
      v.pause();
      v.removeAttribute('src');
      v.load();
    }
  }

  // ── 動画の面倒 ──────────────────────────────────────────────────────────

  private revTime(t: number): number {
    return clamp(this.data.duration - t, 0, this.data.duration);
  }

  /**
   * シークして、そのフレームをテクスチャに上げられる状態まで待つ。
   *
   * 提示まで待とうと `requestVideoFrameCallback` を使ってはいけない。一時停止中の
   * 動画では発火しないことがあり、丸ごとタイムアウト待ちに落ちる。`seeked` が出た
   * 時点でテクスチャはシーク先のフレームを返すので、それで足りる。
   */
  private seek(video: HTMLVideoElement, t: number): Promise<number> {
    return new Promise((res) => {
      const want = clamp(t, 0, (video.duration || this.data.duration) - 0.001);
      if (Math.abs(video.currentTime - want) < 0.004 && video.readyState >= 2) {
        this.opts.onFrame();
        res(0);
        return;
      }
      const t0 = performance.now();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        this.opts.onFrame();
        res(performance.now() - t0);
      };
      const guard = setTimeout(finish, 1500);   // 保険。ここで固まると操作不能になる
      video.addEventListener('seeked', finish, { once: true });
      video.currentTime = want;
    });
  }

  /**
   * 再生中のフレーム供給。
   *
   * 描画ループ任せで毎フレーム転送してはいけない。表示は 60Hz、動画は 30fps なので
   * 転送量が倍になる。8000x4000 だと 1 枚 96MB あるので素直に効く。
   */
  private startFrameFeed(video: HTMLVideoElement): void {
    const rvfc = (video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    }).requestVideoFrameCallback;
    if (!rvfc || this.feedVideo === video) return;
    this.feedVideo = video;
    const pump = () => {
      if (this.feedVideo !== video || this.destroyed) return;
      this.opts.onFrame();
      rvfc.call(video, pump);
    };
    rvfc.call(video, pump);
  }

  private stopFrameFeed(): void { this.feedVideo = null; }

  private emit(patch: Partial<Video360State>): void {
    this.state = { ...this.state, ...patch };
    this.opts.onState(this.state);
  }

  private get currentFwdTime(): number {
    const v = this.activeVideo;
    return this.activeVideo === this.rev ? this.revTime(v.currentTime) : v.currentTime;
  }

  // ── グラフ ──────────────────────────────────────────────────────────────

  nodeAt(viewpointId: string) {
    return this.data.nodes.find((n) => n.viewpointId === viewpointId);
  }

  hasNode(viewpointId: string): boolean { return !!this.nodeAt(viewpointId); }

  /** そのノードから行ける先。逆走は反転素材があるときだけ出す。 */
  exitsOf(viewpointId: string): Video360Exit[] {
    const out: Video360Exit[] = [];
    for (const e of this.data.edges) {
      if (e.from !== viewpointId) continue;
      out.push({
        edge: e, dir: 1, to: e.to,
        kind: e.kind === 'door' ? 'door' : 'walk',
        label: e.label ?? this.opts.labelOf(e.to),
      });
    }
    if (this.rev) {
      for (const e of this.data.edges) {
        if (e.to !== viewpointId) continue;
        out.push({
          edge: e, dir: -1, to: e.from,
          kind: e.kind === 'door' ? 'door' : 'back',
          label: e.kind === 'door' ? 'ドアを閉める' : `${this.opts.labelOf(e.from)}へ戻る`,
        });
      }
    }
    return out;
  }

  /** 隣とは限らない行き先までの経路。撮った道をつないで歩く。無ければ null。 */
  findPath(from: string, to: string): Video360Exit[] | null {
    if (from === to) return [];
    const prev = new Map<string, { from: string; ex: Video360Exit } | null>([[from, null]]);
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const ex of this.exitsOf(cur)) {
        if (prev.has(ex.to)) continue;
        prev.set(ex.to, { from: cur, ex });
        if (ex.to === to) {
          const path: Video360Exit[] = [];
          for (let n = to; prev.get(n); n = prev.get(n)!.from) path.unshift(prev.get(n)!.ex);
          return path;
        }
        queue.push(ex.to);
      }
    }
    return null;
  }

  // ── 移動 ────────────────────────────────────────────────────────────────

  /** ノードに立たせる。カメラを動かすのは onArrive を受けた側。 */
  async settle(viewpointId: string): Promise<void> {
    const node = this.nodeAt(viewpointId);
    if (!node) return;
    this.stopFrameFeed();
    this.fwd.pause();
    this.rev?.pause();
    this.activeVideo = this.fwd;
    // シークが終わるまで idle にしない。先に idle にすると、まだ前の場所の絵が
    // 出ているのに行き先が押せてしまう。
    const ms = await this.seek(this.fwd, node.t);
    if (this.destroyed) return;
    // 逆走に切り替えた瞬間に絵が飛ばないよう、待機側も対応時刻に寄せておく。
    // 待たない ― 逆走を選ぶまでに終わっていればいい。
    if (this.rev) void this.seek(this.rev, this.revTime(node.t));
    this.emit({ mode: 'idle', nodeId: viewpointId, edge: null, time: node.t, seekMs: ms });
    this.opts.onArrive(viewpointId);
  }

  private stale(token: number): boolean { return token !== this.navToken; }

  /**
   * エッジ 1 本を再生する。中断されたら false。
   * `fromFwd` / `stopAtFwd` はどちらも順再生の時間軸で受け、逆走中は読み替える。
   */
  private async runEdge(
    ex: Video360Exit,
    token: number,
    opts: { fromFwd?: number | null; stopAtFwd?: number | null } = {},
  ): Promise<boolean> {
    const [a, b] = ex.edge.range;
    const video = ex.dir === 1 ? this.fwd : this.rev;
    if (!video) return false;

    const startFwd = opts.fromFwd ?? (ex.dir === 1 ? a : b);
    const endFwd = opts.stopAtFwd ?? (ex.dir === 1 ? b : a);
    const from = ex.dir === 1 ? startFwd : this.revTime(startFwd);
    const to = ex.dir === 1 ? endFwd : this.revTime(endFwd);

    this.emit({ mode: 'travel', edge: ex.edge, nodeId: null });

    // すでにその位置で同じ動画が流れているなら止めずに繋ぐ。
    // 道をつないで歩くとき、エッジの境目で一瞬止まるのを防ぐ。
    const continuous = this.activeVideo === video && !video.paused
      && Math.abs(video.currentTime - from) < 0.25;
    if (!continuous) {
      if (video !== this.activeVideo) this.activeVideo.pause();
      const ms = await this.seek(video, from);
      if (this.stale(token) || this.destroyed) return false;
      this.activeVideo = video;
      this.emit({ seekMs: ms });
      this.startFrameFeed(video);
      try { await video.play(); } catch { /* 弾かれても下の監視で止まる */ }
    }

    // 終端の見張り。`timeupdate` は 250ms 間隔で粗すぎるので毎フレーム見る。
    const reached = await new Promise<boolean>((res) => {
      const tick = () => {
        if (this.stale(token) || this.destroyed) { res(false); return; }
        this.emit({ time: this.currentFwdTime });
        if (video.currentTime >= to - 0.001 || video.ended) { res(true); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    if (!reached) return false;
    // 次のエッジが地続きなら止めない。止めると繋ぎ目で 1 拍空く。
    this.pendingStop = () => video.pause();
    return true;
  }

  private pendingStop: (() => void) | null = null;

  private flushStop(): void {
    this.pendingStop?.();
    this.pendingStop = null;
  }

  /** 隣へ 1 手。ドアのマーカーや行き先ボタンから。 */
  async travel(ex: Video360Exit): Promise<void> {
    const token = ++this.navToken;
    if (!await this.runEdge(ex, token)) return;
    if (this.stale(token)) return;
    this.flushStop();
    await this.settle(ex.to);
  }

  /**
   * 目的地まで運ぶ。移動中に呼んでもいい ― 走っている移動は打ち切って乗り換える。
   * 経路が無ければ瞬間移動に落ちる。
   */
  async navigate(viewpointId: string, opts: { instant?: boolean } = {}): Promise<void> {
    const token = ++this.navToken;
    if (!this.hasNode(viewpointId)) return;
    if (viewpointId === this.state.nodeId && this.state.mode === 'idle') return;

    if (!opts.instant && this.state.nodeId) {
      const path = this.findPath(this.state.nodeId, viewpointId);
      if (path && path.length) {
        for (const step of path) {
          if (this.stale(token)) return;
          if (!await this.runEdge(step, token)) return;
        }
        if (this.stale(token)) return;
        this.flushStop();
        await this.settle(viewpointId);
        return;
      }
    }
    this.fwd.pause();
    this.rev?.pause();
    await this.settle(viewpointId);
  }

  /** 途中のポイントを押したとき。そこまで歩いて足を止める。 */
  async travelTo(ex: Video360Exit, stopAtFwd: number, arrive: string | null): Promise<void> {
    const token = ++this.navToken;
    const fromFwd = this.state.mode === 'free' ? this.currentFwdTime : null;
    if (!await this.runEdge(ex, token, { fromFwd, stopAtFwd })) return;
    if (this.stale(token)) return;
    if (arrive) {
      this.flushStop();
      await this.settle(arrive);
    } else {
      this.enterFree(ex.edge);
    }
  }

  /**
   * オーサリング用。タイムラインを引いた位置の絵をそのまま 360 に出す。
   *
   * 別に隠し video を持ってプレビューするやり方も採れるが、それだと「パネルで見ている絵」と
   * 「3D に出ている絵」が食い違い、どのフレームに打ったのか分からなくなる。8K を 2 本
   * 復号することにもなる。見えているものが打つ対象、で揃える。
   */
  async scrub(t: number): Promise<void> {
    this.navToken++;                  // 走っている移動を降ろす
    this.fwd.pause();
    this.rev?.pause();
    this.stopFrameFeed();
    this.activeVideo = this.fwd;
    const ms = await this.seek(this.fwd, t);
    this.emit({ mode: 'scrub', nodeId: null, edge: null, time: t, seekMs: ms });
  }

  /** オーサリング用の素の再生。どこで足を止めているかを目で探すのに使う。 */
  previewPlay(): void {
    this.navToken++;
    this.rev?.pause();
    this.activeVideo = this.fwd;
    this.startFrameFeed(this.fwd);
    void this.fwd.play().catch(() => { /* muted なので基本通る */ });
    this.emit({ mode: 'scrub', nodeId: null, edge: null });
    const tick = () => {
      if (this.destroyed || this.fwd.paused) return;
      this.emit({ time: this.currentFwdTime });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  previewPause(): void {
    this.fwd.pause();
    this.stopFrameFeed();
    this.emit({ time: this.currentFwdTime });
  }

  get isPlaying(): boolean { return !this.fwd.paused; }

  /** 歩いている途中で足を止める。ノードでなくても止まれる。 */
  stopHere(): void {
    if (this.state.mode !== 'travel') return;
    this.navToken++;                       // 走っている移動を降ろす
    this.enterFree(this.state.edge);
  }

  /** 道の途中に立っている状態にする。 */
  private enterFree(edge: Video360Edge | null): void {
    this.fwd.pause();
    this.rev?.pause();
    this.stopFrameFeed();
    this.pendingStop = null;
    this.opts.onFrame();
    this.emit({ mode: 'free', nodeId: null, edge, time: this.currentFwdTime });
  }

  /** 止まった位置から、そのエッジの続きを歩く。 */
  async resume(): Promise<void> {
    const edge = this.state.edge;
    if (this.state.mode !== 'free' || !edge) return;
    // 止まったときに走っていた向きを復元する。
    const ex = this.exitFor(edge, this.dirWithin());
    if (!ex) return;
    const token = ++this.navToken;
    if (!await this.runEdge(ex, token, { fromFwd: this.currentFwdTime })) return;
    if (this.stale(token)) return;
    this.flushStop();
    await this.settle(ex.to);
  }

  /** いま `free` で立っている位置が、どちら向きに進んでいたか。
   *  どちらの素材を流していたかがそのまま向きなので、エッジを見る必要はない。 */
  dirWithin(): 1 | -1 {
    return this.activeVideo === this.rev ? -1 : 1;
  }

  exitFor(edge: Video360Edge, dir: 1 | -1): Video360Exit | null {
    const to = dir === 1 ? edge.to : edge.from;
    return {
      edge, dir, to,
      kind: edge.kind === 'door' ? 'door' : dir === 1 ? 'walk' : 'back',
      label: edge.label ?? this.opts.labelOf(to),
    };
  }

  /** エッジ内の進み具合 (0-1)。`free` のときのポイント配置に使う。 */
  fracWithin(edge: Video360Edge): number {
    const [a, b] = edge.range;
    if (b - a < 1e-6) return 0;
    const cur = this.currentFwdTime;
    return clamp(this.dirWithin() === 1 ? (cur - a) / (b - a) : (b - cur) / (b - a), 0, 1);
  }

  /** エッジ内の進み具合を、順再生の時間軸の時刻に直す。 */
  fracToFwd(edge: Video360Edge, dir: 1 | -1, frac: number): number {
    const [a, b] = edge.range;
    return dir === 1 ? a + (b - a) * frac : b - (b - a) * frac;
  }
}
