/**
 * 360°動画の静止区間をブラウザ内で割り出す。
 *
 * `scripts/video360/analyze.mjs` と同じことを ffmpeg 無しでやる。外のツールを
 * 走らせて JSON を持ってくる往復が要らなくなるので、動画を入れたその場でノードを
 * 起こせる。判定式はスクリプト側と揃えてあるので、どちらで作っても結果は同じ性質になる。
 *
 * フレームを 1 枚ずつシークして集めると 1 分の素材で 1000 回以上のシークになって
 * 実用にならない。再生しながら `requestVideoFrameCallback` で「実際に出たフレーム」を
 * 拾い、時間差で正規化する。取りこぼしても密度が落ちるだけで、静止区間の判定は保つ。
 */

const W = 160;
const H = 90;

export interface Video360Analysis {
  duration: number;
  stills: { start: number; end: number; rest: number }[];
  calmTimes: number[];
}

export interface AnalyzeOptions {
  /** 0..1。UI に進み具合を出すため。 */
  onProgress?: (ratio: number) => void;
  /** 何倍速で舐めるか。速くすると復号が追いつかず密度が落ちるが、判定は保つ。 */
  rate?: number;
  signal?: AbortSignal;
}

export async function analyzeVideo360(url: string, opts: AnalyzeOptions = {}): Promise<Video360Analysis> {
  const rate = opts.rate ?? 4;

  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';

  await new Promise<void>((res, rej) => {
    video.addEventListener('loadeddata', () => res(), { once: true });
    video.addEventListener('error', () => rej(new Error('動画を読み込めませんでした')), { once: true });
    setTimeout(() => rej(new Error('動画の読み込みがタイムアウトしました')), 60000);
  });

  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (duration <= 0) throw new Error('動画の尺が取得できませんでした');

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas が使えませんでした');

  // 緯度重み: equirect は上下端 (天頂・天底) が面積の割にピクセルが極端に多く、
  // わずかな回転でも差分が跳ねる。行の中心緯度の cos で潰す = 面積補正そのもの。
  const rowWeight = new Float32Array(H);
  let weightSum = 0;
  for (let y = 0; y < H; y++) {
    rowWeight[y] = Math.cos((((y + 0.5) / H) - 0.5) * Math.PI);
    weightSum += rowWeight[y];
  }
  weightSum *= W;

  const times: number[] = [];
  const motion: number[] = [];
  let prev: Uint8ClampedArray | null = null;
  let prevT = 0;

  const rvfc = (video as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  }).requestVideoFrameCallback;

  const sample = (mediaTime: number) => {
    ctx.drawImage(video, 0, 0, W, H);
    const cur = ctx.getImageData(0, 0, W, H).data;
    if (prev) {
      let acc = 0;
      for (let y = 0; y < H; y++) {
        const w = rowWeight[y];
        let row = 0;
        const base = y * W * 4;
        for (let x = 0; x < W; x++) {
          const i = base + x * 4;
          // 輝度だけ見る。色差まで見ても静止判定は変わらず、3 倍重くなる。
          const a = (prev[i] * 299 + prev[i + 1] * 587 + prev[i + 2] * 114) / 1000;
          const b = (cur[i] * 299 + cur[i + 1] * 587 + cur[i + 2] * 114) / 1000;
          row += Math.abs(b - a);
        }
        acc += row * w;
      }
      const dt = Math.max(1 / 120, mediaTime - prevT);
      // 取りこぼしたぶんは時間差で割って正規化する。倍速で舐めても値が揃う。
      motion.push((acc / weightSum) / (dt * 30));
      times.push(mediaTime);
    }
    prev = cur;
    prevT = mediaTime;
    opts.onProgress?.(Math.min(1, mediaTime / duration));
  };

  video.playbackRate = rate;
  video.currentTime = 0;
  await video.play().catch(() => { /* muted なので基本通る */ });

  await new Promise<void>((res, rej) => {
    let stopped = false;
    const stop = () => { if (!stopped) { stopped = true; res(); } };
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
        stopped = true;
        rej(new Error('中止しました'));
      }, { once: true });
    }
    video.addEventListener('ended', stop, { once: true });

    if (rvfc) {
      const pump = (_now: number, meta: { mediaTime: number }) => {
        if (stopped) return;
        sample(meta.mediaTime);
        rvfc.call(video, pump);
      };
      rvfc.call(video, pump);
    } else {
      // rVFC が無いブラウザ。描画ループで拾う ― 密度は落ちるが判定は成り立つ。
      const tick = () => {
        if (stopped) return;
        if (video.readyState >= 2) sample(video.currentTime);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
    // 保険。ended が来ない環境でも必ず抜ける。
    setTimeout(stop, (duration / rate) * 1000 + 15000);
  });

  video.pause();
  video.removeAttribute('src');
  video.load();

  if (motion.length < 8) throw new Error('フレームを十分に拾えませんでした');

  return buildAnalysis(times, motion, duration);
}

/** 動き量の系列から静止区間と「止まってよい時刻」を出す。判定はスクリプト側と同じ。 */
function buildAnalysis(times: number[], motion: number[], duration: number): Video360Analysis {
  // 5 サンプル移動平均。1 枚だけ跳ねるノイズで区間が切れないように。
  const smooth = motion.map((_, i) => {
    const lo = Math.max(0, i - 2);
    const hi = Math.min(motion.length - 1, i + 2);
    let s = 0;
    for (let j = lo; j <= hi; j++) s += motion[j];
    return s / (hi - lo + 1);
  });

  // しきい値は絶対値で決め打ちできない (素材ごとに露出も動きも違う)。
  // 下位 20% 分位を基準に、そこから 18% 上までを「静止」とみなす。
  const sorted = [...smooth].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.floor((sorted.length - 1) * p)];
  const threshold = pct(0.20) + (pct(0.80) - pct(0.20)) * 0.18;

  const MIN_STILL_SEC = 0.6;
  const stills: { start: number; end: number; rest: number }[] = [];
  let run = -1;
  for (let i = 0; i < smooth.length; i++) {
    const quiet = smooth[i] <= threshold;
    if (quiet && run < 0) run = i;
    if ((!quiet || i === smooth.length - 1) && run >= 0) {
      const end = quiet ? i : i - 1;
      if (times[end] - times[run] >= MIN_STILL_SEC) {
        // 一番動きの小さいフレームを代表点に。ポーズしたとき一番シャキッとした絵。
        let best = run;
        for (let j = run; j <= end; j++) if (smooth[j] < smooth[best]) best = j;
        stills.push({
          start: +times[run].toFixed(3),
          end: +times[end].toFixed(3),
          rest: +times[best].toFixed(3),
        });
      }
      run = -1;
    }
  }

  // 途中で足を止めてよい時刻。局所的な極小値だけを抜く。
  // 全サンプルを持つと 8K・数分で数千要素になるので持たない。
  const calmTimes: number[] = [];
  for (let i = 2; i < smooth.length - 2; i++) {
    if (smooth[i] <= smooth[i - 1] && smooth[i] <= smooth[i + 1]
      && smooth[i] < smooth[i - 2] && smooth[i] < smooth[i + 2]) {
      const t = +times[i].toFixed(3);
      if (calmTimes.length === 0 || t - calmTimes[calmTimes.length - 1] > 0.2) calmTimes.push(t);
    }
  }

  // fps はここでは出せない。倍速で舐めているうえ取りこぼしもあるので、
  // サンプル密度は素材の fps と一致しない (4 倍速で 8 と出たりする)。
  // 呼び出し側が持っている値をそのまま使う。
  return { duration: +duration.toFixed(3), stills, calmTimes };
}
