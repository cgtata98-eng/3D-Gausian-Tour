// Chaos Vantage local control API.
//
// Vantage listens on localhost:20702 while the app is running. The endpoints and
// the command names below are the ones the bundled 3ds Max Live Link scripts use
// (see `C:\Program Files\Chaos\Vantage\dcc_scripts\3dsMax\Vantage-UtilityFunctions.ms`).
// They are NOT a documented public API — treat the response shapes as unknown and
// never gate progress on a field we merely hope exists. `run.mjs` decides that a
// sequence finished by counting files on disk, which is true regardless of what
// getStatus happens to return on this build (verified against Vantage 3.3.1).
const BASE = process.env.VANTAGE_URL ?? 'http://localhost:20702';

async function post(body, timeoutMs = 15000) {
  const res = await fetch(`${BASE}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`vantage ${body.command} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text }; // some commands answer with a bare string
  }
}

/** True when Vantage is running and answering. */
export async function ping(timeoutMs = 3000) {
  try {
    const res = await fetch(`${BASE}/ping`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export const getStatus = () => post({ command: 'getStatus' });

/** Load a .vrscene / .vantage file. Returns immediately — loading continues in the
 *  background, so callers must settle before starting a sequence. */
export const openFile = (path) => post({ command: 'openFile', path }, 60000);

export const cancelSequence = () => post({ command: 'cancelLiveLinkSequence' });
export const continueSequence = () => post({ command: 'continueLiveLinkSequence' });

/**
 * Kick off an offline render of frames [startFrame, endFrame].
 *
 * `path` is a template output path; Vantage appends its own frame numbering, and
 * the exact numbering format differs between builds. Point it at an EMPTY
 * directory and let the caller sort whatever files appear — that sidesteps
 * having to guess `out.0001.png` vs `out0001.png`.
 */
export function startSequence({ path, width, height, startFrame, endFrame, ...opts }) {
  return post({
    command: 'startLiveLinkSequence',
    path, width, height, startFrame, endFrame,
    samples: 500, fps: 30, lightCache: 1, denoiser: 1, denoiserForIntermediate: 0,
    temporal: 0, motionBlur: 0, autoExposure: 0, pngAlpha: 0,
    ...opts,
  }, 60000);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
