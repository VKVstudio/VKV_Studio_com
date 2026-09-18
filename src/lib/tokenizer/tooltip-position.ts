/**
 * Viewport-clamped placement for the Tokenizer tool's token tooltips.
 *
 * Both `TokenizerApp` and `TokenHeatmap` render a `position: fixed` tooltip at
 * the pointer via `left: x; top: y`. Unclamped — which is how both started —
 * that runs straight off the screen for any token near an edge. On a phone the
 * tooltip is wider than the gap to the right of the finger, so effectively the
 * whole right-hand column of tokens produced a tooltip the user could not read,
 * and tokens on the first line lost their top rows above the viewport.
 *
 * The tooltip is `pointer-events: none`, so flipping it to the other side of
 * the pointer costs nothing: it can never end up under the finger in a way that
 * blocks a tap.
 *
 * `TOOLTIP_MAX_W` / `TOOLTIP_EST_H` mirror the CSS in
 * `styles/lab/tokenizer.css`. They are constants rather than measurements
 * because the element has not rendered when the position is computed, and
 * measuring after the fact would paint the tooltip once and then visibly jump
 * it. Keep them in sync with the `max-width` there.
 */

/** Must match the `max-width` on `.token__tooltip` / `.heatmap__tooltip`. */
export const TOOLTIP_MAX_W = 280;
/** Generous estimate — only used to keep the box off the bottom edge. */
export const TOOLTIP_EST_H = 104;
/** Breathing room kept between the tooltip and every viewport edge. */
const EDGE = 12;

export interface TooltipPoint {
  x: number;
  y: number;
}

/**
 * Given the pointer position, return a `left`/`top` that keeps the whole
 * tooltip inside the viewport.
 *
 * @param viewportW defaults to `window.innerWidth`  (injectable for tests)
 * @param viewportH defaults to `window.innerHeight`
 */
export function placeTooltip(
  clientX: number,
  clientY: number,
  viewportW: number = typeof window === 'undefined' ? 0 : window.innerWidth,
  viewportH: number = typeof window === 'undefined' ? 0 : window.innerHeight
): TooltipPoint {
  // Prefer the right of the pointer; flip to its left when that would overflow.
  let x = clientX + EDGE;
  if (x + TOOLTIP_MAX_W + EDGE > viewportW) {
    x = clientX - TOOLTIP_MAX_W - EDGE;
  }
  // Final clamp catches the flip landing off the LEFT edge too — on a viewport
  // narrower than the tooltip neither side fits, and pinning to EDGE at least
  // shows the box from its start rather than from its middle.
  x = Math.max(EDGE, Math.min(x, viewportW - TOOLTIP_MAX_W - EDGE));

  // Prefer above the pointer (that is where it has always sat, and it keeps the
  // finger off the text); drop below when that would clip the top edge.
  let y = clientY - 48;
  if (y < EDGE) {
    y = clientY + 24;
  }
  y = Math.max(EDGE, Math.min(y, viewportH - TOOLTIP_EST_H - EDGE));

  return { x, y };
}

/**
 * Pulls client coordinates out of whichever event shape arrived.
 *
 * Keyboard events are the third shape and they used to crash here. Every token
 * is `role="button"` with `tabindex="0"` and an `onkeydown` handler — the tool
 * advertises keyboard operation — and pressing Enter on one threw
 * `Cannot read properties of undefined (reading '0')`, because a KeyboardEvent
 * has neither `clientX` nor `touches` and the touch branch indexed an undefined
 * list. So the one interaction path a keyboard user has was the one that failed,
 * loudly, in the console of the flagship Lab page.
 *
 * A keyboard event has no pointer, but it does have a target, and the element's
 * own box is exactly where the tooltip should appear. That also happens to be
 * the better answer for a mouse user whose event somehow lacks coordinates.
 */
export function pointerXY(e: MouseEvent | TouchEvent | KeyboardEvent): TooltipPoint {
  if ('clientX' in e && typeof e.clientX === 'number') {
    return { x: e.clientX, y: e.clientY };
  }
  const touch = 'touches' in e ? e.touches[0] : undefined;
  if (touch) return { x: touch.clientX, y: touch.clientY };

  // Duck-typed rather than `instanceof Element`: this module is imported by the
  // unit tests under the node environment, where `Element` is not a global at
  // all, so the instanceof would throw ReferenceError instead of returning a
  // fallback. Asking whether the thing can measure itself is the question we
  // actually have, and it holds in the browser, in node and during SSR alike.
  const target = (e.currentTarget ?? e.target) as { getBoundingClientRect?: () => DOMRect } | null;
  if (target && typeof target.getBoundingClientRect === 'function') {
    const r = target.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top };
  }
  return { x: 0, y: 0 };
}
