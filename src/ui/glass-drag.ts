/**
 * Press-and-hold to pick a glass surface up and carry it.
 *
 * Hold the left button on a pill or card and after a short delay the surface
 * lifts off the canvas and follows the pointer with damping, springing back
 * when released. It moves nothing in the data model — it is a tactile
 * response, the same idea as iOS's liquid glass: the material acknowledges
 * that you are holding it.
 *
 * Installed once, globally, for the same reason the range fill is: the
 * behaviour belongs to "being a glass surface", not to any one screen, and
 * wiring it per call site is exactly the opt-in pattern that left the app
 * half-migrated before.
 *
 * Deliberate limits:
 *   - Only after HOLD_MS, so an ordinary click is never swallowed.
 *   - Damped and capped, so the surface reads as heavy and tethered rather
 *     than stuck to the cursor.
 *   - A drag that actually moved suppresses the click that would follow;
 *     picking something up is not the same as pressing it.
 *   - Skipped for form controls and anything already handling its own drag
 *     (sliders, the floor-plan editors), which would otherwise fight it.
 */

/** How long the button must be held before the surface lifts. */
const HOLD_MS = 160;
/** Fraction of the pointer's travel the surface actually follows. */
const DAMP = 0.32;
/** Furthest it will go, however far the pointer travels. */
const MAX = 26;
/** Past this, the gesture counts as a carry and the click is suppressed. */
const CLICK_CANCEL_PX = 4;

const SKIP = 'input, textarea, select, [contenteditable], [data-no-glass-drag]';

type Session = {
  el: HTMLElement;
  startX: number;
  startY: number;
  pointerId: number;
  timer: number | null;
  lifted: boolean;
  moved: number;
  prevTransition: string;
};

let session: Session | null = null;

function clamp(v: number): number {
  return Math.max(-MAX, Math.min(MAX, v));
}

function lift(s: Session): void {
  s.lifted = true;
  // Capture only once the carry has actually begun. Taking it on pointerdown
  // retargets the following pointerup to the captured element, so a plain
  // click on a CHILD of the surface never reaches that child — holding a
  // segmented control inside a dialog silently stopped switching, because the
  // dialog (a `.ds-card`) had swallowed the pointer.
  try { s.el.setPointerCapture(s.pointerId); } catch { /* not capturable */ }
  s.prevTransition = s.el.style.transition;
  // Track the pointer 1:1 while held — a transition here would make the
  // surface lag behind the hand and feel broken rather than heavy.
  s.el.style.transition = 'none';
  s.el.setAttribute('data-ds-carrying', '');
}

function release(s: Session): void {
  if (s.timer !== null) clearTimeout(s.timer);
  if (s.lifted) {
    // Hand the spring-back to CSS.
    s.el.style.transition = s.prevTransition;
    s.el.style.transform = '';
    s.el.removeAttribute('data-ds-carrying');
  }
  try { s.el.releasePointerCapture(s.pointerId); } catch { /* already gone */ }
}

export function installGlassDrag(): void {
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    if (e.target.closest(SKIP)) return;
    // Touch and pen come through the same events, but on a phone a press that
    // turns into a drag is almost always a scroll. Carrying would fight the
    // scroller for the gesture and make lists feel sticky, so it stays a
    // mouse interaction.
    if (e.pointerType !== 'mouse') return;
    const el = e.target.closest<HTMLElement>('.ds-pill, .ds-card, .ds-tag, .ds-badge');
    if (!el) return;
    // An interactive descendant owns the gesture. Without this, pressing a
    // button inside a card starts carrying the card, and the thing under the
    // pointer is not the thing that moves.
    const interactive = e.target.closest('button, a, [role="button"], [role="tab"]');
    if (interactive && interactive !== el && el.contains(interactive)) return;

    const s: Session = {
      el,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      timer: null,
      lifted: false,
      moved: 0,
      prevTransition: '',
    };
    s.timer = window.setTimeout(() => lift(s), HOLD_MS);
    session = s;
  }, true);

  document.addEventListener('pointermove', (e) => {
    const s = session;
    if (!s || e.pointerId !== s.pointerId) return;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    s.moved = Math.max(s.moved, Math.hypot(dx, dy));
    if (!s.lifted) {
      // Moving away before the hold completes means this is a scroll or a
      // slide, not a carry — stand down.
      if (s.moved > CLICK_CANCEL_PX && s.timer !== null) {
        clearTimeout(s.timer);
        s.timer = null;
      }
      return;
    }
    s.el.style.transform = `translate(${clamp(dx * DAMP)}px, ${clamp(dy * DAMP)}px)`;
  }, true);

  const end = (e: PointerEvent) => {
    const s = session;
    if (!s || e.pointerId !== s.pointerId) return;
    const carried = s.lifted && s.moved > CLICK_CANCEL_PX;
    release(s);
    session = null;
    if (carried) {
      // Swallow exactly the one click this gesture would otherwise produce.
      const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
      document.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', swallow, true), 0);
    }
  };
  document.addEventListener('pointerup', end, true);
  document.addEventListener('pointercancel', end, true);
}
