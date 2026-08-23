// Render-plan generation for the Vantage panorama pipeline.
//
// Three files, one generator:
//   cameras.json       ← written by 3ds Max (scripts/render/vantage-export.ms)
//   states.config.json ← hand-written; which state combinations to produce
//        ↓ this script merges them
//   render-plan.json   ← canonical plan, read by run.mjs
//   render-plan.ms     ← the SAME plan as a MAXScript array literal
//
// The .ms twin exists because writing a JSON parser in MAXScript is miserable and
// a hand-kept second copy would drift. Both files are emitted from one call, so
// the frame index that Max keys the camera at and the frame index the renamer
// maps back to a node id can never disagree — which is the one error that would
// silently produce 360 correct-looking images of the wrong rooms.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Expand axis definitions into concrete states.
 *  `combinations: "full"` → cartesian product. An array → those combos verbatim
 *  (each entry an object of axisKey → value), for when only m01 gets the full
 *  night / no-furniture treatment. */
export function expandStates(axes, combinations = 'full', vrscenePattern = DEFAULT_VRSCENE) {
  if (Array.isArray(combinations)) {
    return combinations.map((values) => makeState(axes, values, vrscenePattern));
  }
  if (combinations !== 'full') {
    throw new Error(`combinations must be "full" or an array, got ${JSON.stringify(combinations)}`);
  }
  let rows = [{}];
  for (const axis of axes) {
    rows = rows.flatMap((row) => axis.values.map((v) => ({ ...row, [axis.key]: v })));
  }
  return rows.map((values) => makeState(axes, values, vrscenePattern));
}

/** Where each state's vrscene lives, relative to the render root. `{state}` is the
 *  state id. Use `{state}/{state}.vrscene` to match export-set.ms, which writes one
 *  self-named folder per set so the folder, the vrscene, and the CSV all share a name. */
export const DEFAULT_VRSCENE = 'vrscene/{state}.vrscene';

function makeState(axes, values, vrscenePattern = DEFAULT_VRSCENE) {
  for (const axis of axes) {
    if (!(axis.key in values)) throw new Error(`state is missing axis "${axis.key}": ${JSON.stringify(values)}`);
    if (!axis.values.includes(values[axis.key])) {
      throw new Error(`axis "${axis.key}" has no value "${values[axis.key]}"`);
    }
  }
  // Id order follows the axis order so ids are stable and sortable.
  const id = axes.map((a) => values[a.key]).join('_');
  return { id, values, vrscene: vrscenePattern.replaceAll('{state}', id), status: 'pending' };
}

/** Substitute `{node}` and `{axisKey}` in a naming/path template. */
export function fillTemplate(template, node, state) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (key === 'node') return node.id;
    if (key in state.values) return state.values[key];
    throw new Error(`template "${template}" references unknown key "{${key}}"`);
  });
}

/** Final on-disk path (relative to the render root) for one node × state image. */
export function outputPath(plan, state, node) {
  return join(fillTemplate(plan.outDir, node, state), fillTemplate(plan.naming, node, state));
}

export function buildPlan({ cameras, config }) {
  const axes = config.axes;
  const states = expandStates(axes, config.combinations, config.vrscenePattern ?? DEFAULT_VRSCENE);
  const plan = {
    version: 1,
    output: { width: 4096, height: 2048, format: 'png', ...config.output },
    // Vantage sequence parameters. `temporal: 0` is mandatory for the teleporting
    // camera — with temporal reuse on, each panorama inherits samples from the
    // previous (unrelated) room and every frame comes out subtly contaminated.
    vantage: {
      samples: 500, denoiser: 1, denoiserForIntermediate: 0, lightCache: 1,
      temporal: 0, motionBlur: 0, autoExposure: 0, pngAlpha: 0, fps: 30,
      ...config.vantage,
    },
    outDir: config.outDir ?? 'render/{node}',
    naming: config.naming ?? '{node}_' + axes.map((a) => `{${a.key}}`).join('_') + '.png',
    unitScale: cameras.unitScale ?? 1,
    nodes: cameras.nodes,
    states,
  };
  validatePlan(plan);
  return plan;
}

/** Throws on anything that would waste a render run. Cheap to call, run it often. */
export function validatePlan(plan) {
  const { nodes, states } = plan;
  if (!nodes?.length) throw new Error('plan has no camera nodes');

  const ids = new Set();
  nodes.forEach((n, i) => {
    if (n.index !== i) throw new Error(`node[${i}] has index ${n.index} — indices must be 0..n-1 in array order (they ARE the Vantage frame numbers)`);
    if (ids.has(n.id)) throw new Error(`duplicate node id "${n.id}"`);
    ids.add(n.id);
    if (!Array.isArray(n.pos) || n.pos.length !== 3) throw new Error(`node "${n.id}" has no 3-component pos`);
  });

  if (!states?.length) throw new Error('plan has no states');
  const stateIds = new Set();
  for (const s of states) {
    if (stateIds.has(s.id)) throw new Error(`duplicate state id "${s.id}"`);
    stateIds.add(s.id);
    // Force the templates through once so a typo fails here, not after 6 hours.
    outputPath(plan, s, nodes[0]);
  }

  const { width, height } = plan.output;
  if (Math.abs(width / height - 2) > 1e-6) {
    throw new Error(`equirect output must be 2:1 — got ${width}x${height}`);
  }
  if (plan.vantage.temporal !== 0) {
    throw new Error('vantage.temporal must be 0 for the teleporting-camera sequence (see comment in plan.mjs)');
  }
  return plan;
}

/** MAXScript twin of the plan — a plain array literal, included by vantage-export.ms. */
export function planToMaxScript(plan) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const nodeRows = plan.nodes.map((n) =>
    `\t#("${esc(n.id)}", "${esc(n.maxCamera ?? n.id)}")`).join(',\n');
  const stateRows = plan.states.map((s) => {
    const pairs = Object.entries(s.values).map(([k, v]) => `#("${esc(k)}", "${esc(v)}")`).join(', ');
    return `\t#("${esc(s.id)}", "${esc(s.vrscene)}", #(${pairs}))`;
  }).join(',\n');
  return [
    '-- GENERATED by scripts/render/plan.mjs — DO NOT EDIT BY HAND.',
    '-- Regenerate with: npm run render:plan',
    '',
    '-- #(nodeId, maxCameraName) — array position IS the Vantage frame number.',
    `global VR_PLAN_NODES = #(\n${nodeRows}\n)`,
    '',
    '-- #(stateId, vrscenePath, #(#(axisKey, value), ...))',
    `global VR_PLAN_STATES = #(\n${stateRows}\n)`,
    '',
    `global VR_PLAN_FRAME_COUNT = ${plan.nodes.length}`,
    '',
  ].join('\n');
}

export async function loadPlan(planPath) {
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  validatePlan(plan);
  return plan;
}

export async function savePlan(plan, planPath) {
  await mkdir(dirname(planPath), { recursive: true });
  await writeFile(planPath, JSON.stringify(plan, null, 2) + '\n');
}

/**
 * Locate the camera export. `VR_exportCameras()` writes `<root>/cameras.json`,
 * while `VR_exportSet "name"` writes `<root>/name/name_cameras.json` — pointing
 * this at either a render root or a single set folder should just work, so the
 * folder name stays the only thing anyone has to keep straight.
 */
async function findCamerasFile(dir) {
  const direct = join(dir, 'cameras.json');
  if (await exists(direct)) return direct;
  const hits = (await readdir(dir)).filter((n) => n.endsWith('_cameras.json'));
  if (hits.length === 1) return join(dir, hits[0]);
  if (hits.length > 1) {
    throw new Error(`${dir} has ${hits.length} *_cameras.json files (${hits.join(', ')}) — point at one set folder, or keep a single cameras.json`);
  }
  throw new Error(`no cameras.json (or *_cameras.json) in ${dir} — run VR_exportCameras() or VR_exportSet in 3ds Max first`);
}

/** states.config.json may live in the set folder or one level up at the render root. */
async function findConfigFile(dir) {
  for (const candidate of [join(dir, 'states.config.json'), join(dir, '..', 'states.config.json')]) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error(`no states.config.json in ${dir} (or its parent) — copy scripts/render/states.config.example.json`);
}

const exists = (p) => readFile(p).then(() => true, () => false);

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(process.argv[2] ?? 'render');
  const cameras = JSON.parse(await readFile(await findCamerasFile(root), 'utf8'));
  const config = JSON.parse(await readFile(await findConfigFile(root), 'utf8'));

  const plan = buildPlan({ cameras, config });
  await savePlan(plan, join(root, 'render-plan.json'));
  await writeFile(join(root, 'render-plan.ms'), planToMaxScript(plan));

  const total = plan.nodes.length * plan.states.length;
  console.log(`plan written: ${plan.states.length} states x ${plan.nodes.length} cameras = ${total} images`);
  console.log(`  ${join(root, 'render-plan.json')}`);
  console.log(`  ${join(root, 'render-plan.ms')}   → include this from 3ds Max`);
  for (const s of plan.states) console.log(`  - ${s.id.padEnd(20)} ${s.vrscene}`);
}
