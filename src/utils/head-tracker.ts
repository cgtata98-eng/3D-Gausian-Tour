import * as THREE from 'three';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { useTrackingStore } from '../store/tracking-store';

/**
 * Browser-side head tracker — replaces the Xrealtracking `tracker.py` WebSocket.
 * Uses MediaPipe FaceLandmarker (WebGL) to estimate head yaw / pitch / roll from the
 * webcam at ~30 Hz. No external Python process required.
 *
 * Pipeline:
 *   getUserMedia (webcam) → FaceLandmarker.detectForVideo → facialTransformationMatrix
 *   → THREE.Euler(YXZ) → low-pass smoothing → calibration offset → tracking-store
 *
 * `tracker.py` (Xrealtracking) shipped a One-Euro filter; here we use a simpler EMA
 * because the input rate is steadier (~30 Hz fixed) and the user is at a desk so
 * jitter is small. If the latency / jitter trade-off becomes a problem we can drop
 * in a One-Euro impl later.
 */

// Model is fetched once from Google's CDN — small (~5MB float16). Could be self-hosted
// later if offline operation is needed.
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
// WASM is served from /public so the version matches the installed npm package
// (`scripts/copy-mediapipe-wasm.mjs` syncs it). Mismatched WASM ↔ JS versions silently
// throw an Event-shaped error during init, which is hard to diagnose.
const WASM_BASE = '/mediapipe/wasm';

let landmarker: FaceLandmarker | null = null;
let video: HTMLVideoElement | null = null;
let stream: MediaStream | null = null;
let rafId: number | null = null;
let stopped = false;

// EMA smoothing — α=0.25 matches the SMOOTH constant in the Xrealtracking gs.html
// PoC, gives perceptibly responsive yet steady motion at 30 Hz input.
const SMOOTH = 0.25;
const smoothed = { yaw: 0, pitch: 0, roll: 0 };

// Zero-point calibration — subtracted from raw to make "looking straight ahead" = 0°.
// Auto-calibrated on the first frame after the face is found (`calibrated` flag), and
// re-triggerable via `calibrateHeadTracker()`.
const calibration = { yaw: 0, pitch: 0, roll: 0 };
let calibrated = false;

async function ensureLandmarker(): Promise<FaceLandmarker> {
  if (landmarker) return landmarker;
  const filesetResolver = await FilesetResolver.forVisionTasks(WASM_BASE);
  landmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    outputFacialTransformationMatrixes: true,
    runningMode: 'VIDEO',
    numFaces: 1,
  });
  return landmarker;
}

async function ensureVideo(): Promise<HTMLVideoElement> {
  if (video && stream) return video;
  stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: 'user' },
    audio: false,
  });
  const v = document.createElement('video');
  v.style.display = 'none';
  v.playsInline = true;
  v.muted = true;
  v.srcObject = stream;
  document.body.appendChild(v);
  await v.play();
  video = v;
  return v;
}

const _matrix = new THREE.Matrix4();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

function loop() {
  if (stopped) return;
  const v = video;
  const lm = landmarker;
  if (v && lm && v.readyState >= 2) {
    const result = lm.detectForVideo(v, performance.now());
    const matrices = result.facialTransformationMatrixes;
    if (matrices && matrices.length > 0) {
      _matrix.fromArray(matrices[0].data as unknown as number[]);
      _euler.setFromRotationMatrix(_matrix, 'YXZ');
      // Three.js Euler in radians. Convert to degrees and apply our sign convention:
      //   yaw: head turning right → positive (so it matches camera Y rotation)
      //   pitch: head looking up   → positive
      const RAD2DEG = 180 / Math.PI;
      const rawYaw = _euler.y * RAD2DEG;
      const rawPitch = _euler.x * RAD2DEG;
      const rawRoll = _euler.z * RAD2DEG;
      if (!calibrated) {
        calibration.yaw = rawYaw;
        calibration.pitch = rawPitch;
        calibration.roll = rawRoll;
        calibrated = true;
        useTrackingStore.getState().setConnected(true);
      }
      const yaw = rawYaw - calibration.yaw;
      const pitch = rawPitch - calibration.pitch;
      const roll = rawRoll - calibration.roll;
      smoothed.yaw += (yaw - smoothed.yaw) * SMOOTH;
      smoothed.pitch += (pitch - smoothed.pitch) * SMOOTH;
      smoothed.roll += (roll - smoothed.roll) * SMOOTH;
      useTrackingStore.getState().setPose(smoothed.yaw, smoothed.pitch, smoothed.roll, 'face');
    }
  }
  rafId = requestAnimationFrame(loop);
}

/** Begin head tracking. Asks the user for webcam permission on the first call. */
export async function startHeadTracker(): Promise<void> {
  stopped = false;
  try {
    await ensureLandmarker();
    await ensureVideo();
    if (rafId === null) rafId = requestAnimationFrame(loop);
  } catch (err) {
    // MediaPipe / video errors often arrive as DOM Event objects which serialize to
    // a useless `{isTrusted: true}`. Pull whatever fields exist so the developer
    // console points at the real cause (network 404 / permission denied / etc.).
    const detail = err instanceof Error
      ? `${err.name}: ${err.message}`
      : err && typeof err === 'object'
        ? (() => {
            const e = err as { type?: string; message?: string; name?: string };
            return `${e.name ?? e.type ?? 'Event'}: ${e.message ?? '(no message; probably MediaPipe WASM/model load failure or webcam permission denied)'}`;
          })()
        : String(err);
    console.warn('[head-tracker] start failed:', detail, err);
    useTrackingStore.getState().setConnected(false);
    useTrackingStore.getState().setPose(0, 0, 0, 'none');
    throw err;
  }
}

/** Stop tracking, release the webcam, and reset the tracking-store. */
export function stopHeadTracker(): void {
  stopped = true;
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  if (video) {
    try { video.remove(); } catch { /* ignore */ }
    video = null;
  }
  // Keep `landmarker` cached — recreating it is slow (WASM + model fetch).
  calibrated = false;
  smoothed.yaw = smoothed.pitch = smoothed.roll = 0;
  const t = useTrackingStore.getState();
  t.setConnected(false);
  t.setPose(0, 0, 0, 'none');
}

/** Re-zero the calibration to the user's current head pose. */
export function calibrateHeadTracker(): void {
  calibrated = false;
}
