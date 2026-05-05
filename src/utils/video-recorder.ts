/**
 * Canvas → MediaRecorder の薄いラッパ。Debug 画面の動画タブから使う。
 *
 * 出力フォーマットは MP4 (H.264) を最優先で試し、ブラウザが対応していなければ
 * WebM (VP9) にフォールバックする。Chrome / Edge 130+ ではネイティブ MP4 が出る。
 */

const PREFERRED_MIME = 'video/mp4;codecs=avc1.42E01F'; // H.264 baseline 3.1
const FALLBACK_MIME = 'video/webm;codecs=vp9';

export interface SupportedMime {
  mime: string;
  ext: 'mp4' | 'webm';
}

export function pickSupportedMime(): SupportedMime | null {
  if (typeof MediaRecorder === 'undefined') return null;
  if (MediaRecorder.isTypeSupported(PREFERRED_MIME)) return { mime: PREFERRED_MIME, ext: 'mp4' };
  if (MediaRecorder.isTypeSupported(FALLBACK_MIME)) return { mime: FALLBACK_MIME, ext: 'webm' };
  // 最後の保険: codec 指定なしの mp4 / webm
  if (MediaRecorder.isTypeSupported('video/mp4')) return { mime: 'video/mp4', ext: 'mp4' };
  if (MediaRecorder.isTypeSupported('video/webm')) return { mime: 'video/webm', ext: 'webm' };
  return null;
}

export class CanvasRecorder {
  private recorder: MediaRecorder;
  private chunks: Blob[] = [];
  private mime: string;

  constructor(canvas: HTMLCanvasElement, mime: string, fps = 60, bitrate = 8_000_000) {
    const stream = canvas.captureStream(fps);
    this.recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
    this.mime = mime;
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
  }

  start() {
    this.chunks = [];
    this.recorder.start(100); // 100ms ごとに ondataavailable を発火させて取りこぼし防止
  }

  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      if (this.recorder.state === 'inactive') {
        resolve(new Blob(this.chunks, { type: this.mime }));
        return;
      }
      this.recorder.onstop = () => resolve(new Blob(this.chunks, { type: this.mime }));
      this.recorder.stop();
    });
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Copy `src` (typically the renderer's canvas) into a smaller 2D canvas and
 * return a JPEG data URL. The caller must invoke this _immediately after_ the
 * source canvas has rendered a frame, otherwise a WebGL canvas may already have
 * cleared its drawing buffer.
 */
export function downscaleCanvasToJpeg(src: HTMLCanvasElement, maxSize: number, quality = 0.78): string {
  const w = Math.max(1, src.width);
  const h = Math.max(1, src.height);
  const scale = Math.min(1, maxSize / Math.max(w, h));
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  const tmp = document.createElement('canvas');
  tmp.width = dw;
  tmp.height = dh;
  const ctx = tmp.getContext('2d');
  if (!ctx) return '';
  ctx.drawImage(src, 0, 0, dw, dh);
  return tmp.toDataURL('image/jpeg', quality);
}
