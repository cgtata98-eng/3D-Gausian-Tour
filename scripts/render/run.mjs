// Drive Chaos Vantage through every state in render-plan.json, unattended.
//
//   node scripts/render/run.mjs [renderRoot] [--only=m01_day_on] [--force] [--dry]
//
// One state = one .vrscene = one openFile + one frame sequence covering all
// cameras. Progress is durable in two independent ways so an overnight run that
// dies at 3am resumes instead of restarting:
//   1. `states[].status` is written back to render-plan.json after each state.
//   2. A state whose output images already all exist is skipped regardless of
//      what the plan claims.
//
// Completion is detected by counting files in a per-state scratch directory, not
// by interpreting getStatus — see the note at the top of vantage.mjs.
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadPlan, savePlan, outputPath } from './plan.mjs';
import { ping, openFile, startSequence, getStatus, cancelSequence, sleep } from './vantage.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const root = resolve(argv.find((a) => !a.startsWith('--')) ?? 'render');
const only = flag('only');
const settleSec = Number(flag('settle', 20));       // grace period after openFile
const stallSec = Number(flag('stall', 900));        // abort a state after this long with no new frame
const force = has('force');
const dry = has('dry');

const planPath = join(root, 'render-plan.json');
const plan = await loadPlan(planPath);
const rawRoot = join(root, '_raw');

const targets = plan.states.filter((s) => !only || s.id === only);
if (!targets.length) throw new Error(`no state matches --only=${only}`);

console.log(`render root : ${root}`);
console.log(`states      : ${targets.length} / ${plan.states.length}`);
console.log(`cameras     : ${plan.nodes.length} per state`);
console.log(`output      : ${plan.output.width}x${plan.output.height} ${plan.output.format}`);
console.log(`samples     : ${plan.vantage.samples}, denoiser=${plan.vantage.denoiser}, temporal=${plan.vantage.temporal}`);

if (!dry && !(await ping())) {
  throw new Error('Vantage is not responding on localhost:20702 — start Chaos Vantage first (the app must be open; vantage_console.exe does not serve this API).');
}

let rendered = 0;
let skipped = 0;
const t0 = Date.now();

for (const state of targets) {
  const finals = plan.nodes.map((n) => join(root, outputPath(plan, state, n)));

  if (!force && finals.every((f) => existsSync(f))) {
    if (state.status !== 'done' && !dry) { state.status = 'done'; await savePlan(plan, planPath); }
    console.log(`skip  ${state.id} — all ${finals.length} images present`);
    skipped++;
    continue;
  }

  const vrscene = resolveVrscene(state);
  const haveVrscene = existsSync(vrscene);

  // A dry run reports and never writes: its whole purpose is to check the plan
  // before committing a night to it, so it must not be able to corrupt it.
  if (dry) {
    console.log(`${haveVrscene ? 'render' : 'MISSING'}  ${state.id.padEnd(20)} ${finals.length} images  ${state.vrscene}`);
    continue;
  }

  if (!haveVrscene) {
    console.warn(`SKIP  ${state.id} — vrscene not found: ${vrscene}`);
    state.status = 'missing-vrscene';
    await savePlan(plan, planPath);
    continue;
  }

  console.log(`\n=== ${state.id} ===`);

  const rawDir = join(rawRoot, state.id);
  await rm(rawDir, { recursive: true, force: true }); // must start empty — counting is the progress signal
  await mkdir(rawDir, { recursive: true });

  state.status = 'rendering';
  await savePlan(plan, planPath);

  const stateStart = Date.now();
  await openFile(vrscene);
  console.log(`  loading scene, settling ${settleSec}s...`);
  await sleep(settleSec * 1000);
  // Logged raw once per state: the shape of this payload is undocumented, and
  // seeing it in the run log is how we learn whether it can replace the settle wait.
  console.log(`  status: ${JSON.stringify(await getStatus().catch((e) => ({ error: e.message })))}`);

  await startSequence({
    ...plan.vantage,
    path: join(rawDir, `${state.id}.${plan.output.format}`),
    width: plan.output.width,
    height: plan.output.height,
    startFrame: 0,
    endFrame: plan.nodes.length - 1,
  });

  const produced = await waitForFrames(rawDir, plan.nodes.length, stateStart);

  if (produced.length !== plan.nodes.length) {
    await cancelSequence().catch(() => {});
    state.status = 'failed';
    await savePlan(plan, planPath);
    throw new Error(`${state.id}: expected ${plan.nodes.length} frames, got ${produced.length}. Raw output left in ${rawDir} for inspection.`);
  }

  // Sorted raw order == frame order == node order. This is the whole reason the
  // plan forbids non-contiguous node indices.
  for (let i = 0; i < produced.length; i++) {
    const dest = join(root, outputPath(plan, state, plan.nodes[i]));
    await mkdir(dirname(dest), { recursive: true });
    await rename(produced[i], dest);
  }
  await rm(rawDir, { recursive: true, force: true });

  state.status = 'done';
  await savePlan(plan, planPath);
  rendered++;
  const mins = ((Date.now() - stateStart) / 60000).toFixed(1);
  console.log(`  done — ${produced.length} images in ${mins} min`);
}

const totalMin = ((Date.now() - t0) / 60000).toFixed(1);
console.log(`\nrendered ${rendered} state(s), skipped ${skipped}, ${totalMin} min total`);

/**
 * A plan generated at the render root spells the vrscene as `m01_day_on/m01_day_on.vrscene`;
 * the same plan generated inside that set folder means just `m01_day_on.vrscene`.
 * Accept either rather than make the folder depth something the user has to get
 * right — the two can never both exist and mean different files, because the set
 * name is baked into the filename either way.
 */
function resolveVrscene(state) {
  const nested = resolve(root, state.vrscene);
  if (existsSync(nested)) return nested;
  const flat = resolve(root, state.vrscene.split(/[\\/]/).pop());
  return existsSync(flat) ? flat : nested; // report the nested path when neither exists
}

/**
 * Poll until `expected` images exist and have stopped growing. Vantage writes each
 * frame as it finishes, so file count is a direct progress bar; a file that just
 * appeared may still be partially written, hence the size-stability check.
 */
async function waitForFrames(dir, expected, startedAt) {
  let lastCount = -1;
  let lastChange = Date.now();
  for (;;) {
    const files = (await readdir(dir)).filter((n) => n.endsWith(`.${plan.output.format}`)).sort();
    if (files.length !== lastCount) {
      lastCount = files.length;
      lastChange = Date.now();
      const elapsed = (Date.now() - startedAt) / 1000;
      const eta = files.length > 0 ? ((elapsed / files.length) * (expected - files.length) / 60).toFixed(1) : '?';
      process.stdout.write(`\r  frames ${files.length}/${expected}  (${(elapsed / 60).toFixed(1)} min elapsed, ~${eta} min left)   `);
    }
    if (files.length >= expected) {
      process.stdout.write('\n');
      const abs = files.map((f) => join(dir, f));
      if (await sizesStable(abs)) return abs;
    }
    if (Date.now() - lastChange > stallSec * 1000) {
      process.stdout.write('\n');
      return files.map((f) => join(dir, f));
    }
    await sleep(3000);
  }
}

async function sizesStable(paths) {
  const a = await Promise.all(paths.map((p) => stat(p).then((s) => s.size)));
  await sleep(2000);
  const b = await Promise.all(paths.map((p) => stat(p).then((s) => s.size)));
  return a.every((size, i) => size === b[i] && size > 0);
}
