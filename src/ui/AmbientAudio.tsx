import { useEffect, useRef, useState } from 'react';
import { useSceneStore } from '../store/scene-store';
import { useUIStore } from '../store/ui-store';
import { resolveScenePath } from '../core/scene-manifest';
import { resolveBlobRef } from '../utils/idb';

/**
 * Background / ambient audio for the active manifest's `audio` reference, played via
 * Web Audio API for *gapless* looping.
 *
 * The previous implementation used `<audio loop>`, but MP3s carry encoder padding
 * (LAME info tag silence at start/end) that browsers play through verbatim — producing
 * an audible gap at every loop boundary. Decoding the file into an `AudioBuffer` and
 * playing it through `AudioBufferSourceNode.loop = true` lets the browser jump back
 * to sample 0 on the audio thread with no decoder gap.
 *
 * Audio (BGM + footsteps) is a 3DGS-mode-only feature. In 360° panorama mode the
 * component renders nothing.
 */
export function AmbientAudio() {
  const manifest = useSceneStore((s) => s.manifest);
  const muted = useUIStore((s) => s.audioMuted);
  const volume = useUIStore((s) => s.audioVolume);
  const viewMode = useUIStore((s) => s.viewMode);
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  // Resolve the manifest's audio reference into a playable URL.
  useEffect(() => {
    let cancelled = false;
    const raw = manifest?.audio;
    if (!raw) {
      setResolvedUrl(null);
      return;
    }
    (async () => {
      try {
        let url: string;
        if (raw.startsWith('data:') || raw.startsWith('blob:')) {
          url = raw;
        } else if (raw.startsWith('idb:')) {
          url = await resolveBlobRef(raw);
          objectUrlRef.current = url;
        } else if (raw.startsWith('/')) {
          url = raw;
        } else if (manifest) {
          url = resolveScenePath(manifest.id, raw);
        } else {
          return;
        }
        if (!cancelled) setResolvedUrl(url);
      } catch (err) {
        console.warn('ambient audio resolve failed:', err);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [manifest?.audio, manifest]);

  // Web Audio graph: ctx → BufferSource(loop=true) → GainNode → destination.
  const ctxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const loadedUrlRef = useRef<string | null>(null);

  // Decode the audio file into an AudioBuffer when the URL changes.
  useEffect(() => {
    // URL changing means "load a different track" — stop whatever is playing now so
    // we don't hear the previous track for the brief decode window.
    stop();
    bufferRef.current = null;
    if (!resolvedUrl) {
      loadedUrlRef.current = null;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        if (!ctxRef.current) {
          ctxRef.current = new AudioContext();
          gainRef.current = ctxRef.current.createGain();
          gainRef.current.connect(ctxRef.current.destination);
        }
        const res = await fetch(resolvedUrl);
        const arr = await res.arrayBuffer();
        const buf = await ctxRef.current.decodeAudioData(arr);
        if (cancelled) return;
        bufferRef.current = buf;
        loadedUrlRef.current = resolvedUrl;
        // If we should be playing, (re)start with the new buffer.
        if (!muted && viewMode !== '360') restart();
      } catch (err) {
        console.warn('ambient audio decode failed:', err);
      }
    })();
    return () => { cancelled = true; };
    // restart/stop are stable closures; deps below cover their inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedUrl]);

  const stop = () => {
    const src = sourceRef.current;
    if (!src) return;
    try { src.stop(); } catch { /* already stopped */ }
    try { src.disconnect(); } catch { /* ignore */ }
    sourceRef.current = null;
  };

  const restart = () => {
    const ctx = ctxRef.current;
    const gain = gainRef.current;
    const buf = bufferRef.current;
    if (!ctx || !gain || !buf) return;
    stop();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(gain);
    src.start(0);
    sourceRef.current = src;
  };

  // Play / pause + volume application. AudioContext starts suspended on browsers
  // that gate it — the speaker toggle (a click) resumes it.
  useEffect(() => {
    const ctx = ctxRef.current;
    const gain = gainRef.current;
    if (!ctx || !gain) return;
    gain.gain.value = volume;
    const shouldPlay = !muted && viewMode !== '360' && !!bufferRef.current;
    if (shouldPlay) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => { /* ignore */ });
      if (!sourceRef.current) restart();
    } else {
      stop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muted, volume, viewMode, resolvedUrl]);

  // Tear down the AudioContext on unmount.
  useEffect(() => {
    return () => {
      stop();
      const ctx = ctxRef.current;
      if (ctx) ctx.close().catch(() => { /* ignore */ });
      ctxRef.current = null;
      gainRef.current = null;
      bufferRef.current = null;
    };
  }, []);

  // モバイル/iOS Safari は AudioContext を生成直後 `suspended` で保持し、user gesture
  // 内で resume() しないと音が出ない。React effect 経由の resume はミュート切替の
  // クリックハンドラより遅れて走るため、user activation が切れて失敗するケースがある。
  // 対策: 初回 pointerdown / touchstart / keydown を document でつかみ、その同期内で
  // resume() を呼ぶ。リスナは初回発火で自動解除 (`once: true`)。
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const prime = () => {
      const ctx = ctxRef.current;
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => { /* ignore */ });
      // 足音 <audio> の autoplay ロックを解くために、一瞬だけ play→pause しておく
      // (mobile Safari/Chrome は user gesture 内の play() を 1 度通すと以降の
      //  プログラマティック play() を許可する)。
      const a = document.querySelector('audio[data-footstep="1"]') as HTMLAudioElement | null;
      if (a) {
        a.muted = true;
        a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; });
      }
    };
    const opts: AddEventListenerOptions = { once: true, capture: true, passive: true };
    document.addEventListener('pointerdown', prime, opts);
    document.addEventListener('touchstart', prime, opts);
    document.addEventListener('keydown', prime, opts);
    return () => {
      document.removeEventListener('pointerdown', prime, true);
      document.removeEventListener('touchstart', prime, true);
      document.removeEventListener('keydown', prime, true);
    };
  }, []);

  return null;
}
