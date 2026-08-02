/**
 * The fan a viewpoint casts on a plan map, in the direction it faces.
 *
 * Shared because there are three top-down views of the same plan (the debug
 * editor's map, the viewer sidebar's FLOOR MAP, the walkthrough grid) and this
 * marker had been written out longhand in each of them. Near-duplicates like
 * that drift the moment one is edited — which is exactly what happened to the
 * greys and the whites elsewhere in this UI.
 *
 * It was a four-point polygon (centre, left, tip, right): a kite, whose outer
 * edge is two straight lines meeting at a point. A field of view does not come
 * to a point at a fixed distance — it is an arc — and the kite read as an
 * arrow, i.e. "this is where it moves", rather than "this is what it sees".
 */

/**
 * `angle` and `spread` are radians in the y-UP convention the map code uses
 * (screen angle = yaw + 90°); the flip to SVG's y-down happens here, once.
 *
 * The arc sweep flag is 1 because the path runs from `angle + spread` down to
 * `angle - spread`, and with y pointing down that is the positive-angle
 * direction.
 */
export function fanPath(cx: number, cy: number, r: number, angle: number, spread: number): string {
  const ax = (a: number) => cx + Math.cos(a) * r;
  const ay = (a: number) => cy - Math.sin(a) * r;
  const a1 = angle + spread, a2 = angle - spread;
  const largeArc = spread * 2 > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${ax(a1)} ${ay(a1)} A ${r} ${r} 0 ${largeArc} 1 ${ax(a2)} ${ay(a2)} Z`;
}
