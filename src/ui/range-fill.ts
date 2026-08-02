/**
 * Paints the filled portion of every `<input type="range">`.
 *
 * A native range input has no "filled" region — `::-webkit-slider-runnable-track`
 * is one uniform strip, so a styled slider shows the thumb's position but gives
 * no read on the value at a glance. The usual fix (`accent-color`) only applies
 * while the control keeps its native appearance, which we give up in order to
 * style the track and thumb as shell surfaces.
 *
 * So the fill is a gradient sized by a custom property, and this module keeps
 * that property in step with the value.
 *
 * Repainting is driven by three things because none alone is sufficient:
 *   - `input` events, for the user dragging;
 *   - a MutationObserver, because these inputs are controlled by React and a
 *     re-render rewrites the `style` attribute, wiping the property;
 *   - a one-shot pass on load for whatever is already mounted.
 *
 * All work is coalesced into a single animation frame.
 */

function paint(el: HTMLInputElement): void {
  const min = Number(el.min === '' ? 0 : el.min);
  const max = Number(el.max === '' ? 100 : el.max);
  const val = Number(el.value);
  const span = max - min;
  const pct = span > 0 && Number.isFinite(val)
    ? Math.min(100, Math.max(0, ((val - min) / span) * 100))
    : 0;
  const next = `${pct.toFixed(2)}%`;
  // Skip the write when nothing moved — this runs off a MutationObserver, and
  // an unconditional style write would retrigger it forever.
  if (el.style.getPropertyValue('--range-p') !== next) {
    el.style.setProperty('--range-p', next);
  }
}

let queued = false;
function paintAll(): void {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    document.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(paint);
  });
}

export function installRangeFill(): void {
  document.addEventListener(
    'input',
    (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement && t.type === 'range') paint(t);
    },
    true,
  );

  new MutationObserver(paintAll).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['value', 'min', 'max', 'style'],
  });

  paintAll();
}
