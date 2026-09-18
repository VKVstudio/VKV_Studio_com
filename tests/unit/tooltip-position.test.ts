import { describe, expect, it } from 'vitest';
import {
  placeTooltip,
  pointerXY,
  TOOLTIP_EST_H,
  TOOLTIP_MAX_W,
} from '../../src/lib/tokenizer/tooltip-position';

/**
 * The defect these guard against is invisible on a desktop monitor: the token
 * tooltip was placed at `pointer + 12px` with no clamp, so on a phone every
 * token in the right-hand column produced a tooltip that ran off the screen,
 * and tokens on the first line lost their top rows above the viewport. Nothing
 * threw and nothing looked broken in a wide window — which is exactly why it
 * survived until someone opened the tool on a phone.
 */

const EDGE = 12;
const PHONE = { w: 390, h: 844 }; // iPhone 14 CSS pixels
const DESKTOP = { w: 1920, h: 1080 };

function fits(p: { x: number; y: number }, vp: { w: number; h: number }): boolean {
  return (
    p.x >= 0 && p.y >= 0 && p.x + TOOLTIP_MAX_W <= vp.w && p.y + TOOLTIP_EST_H <= vp.h
  );
}

describe('placeTooltip', () => {
  it('keeps the default placement when there is room for it', () => {
    const p = placeTooltip(400, 500, DESKTOP.w, DESKTOP.h);
    expect(p.x).toBe(400 + EDGE); // right of the pointer
    expect(p.y).toBe(500 - 48); // above it
  });

  it('flips to the left of the pointer instead of overflowing the right edge', () => {
    const p = placeTooltip(PHONE.w - 20, 400, PHONE.w, PHONE.h);
    expect(p.x).toBeLessThan(PHONE.w - 20);
    expect(fits(p, PHONE)).toBe(true);
  });

  it('drops below the pointer instead of clipping above the top edge', () => {
    const p = placeTooltip(100, 10, PHONE.w, PHONE.h);
    expect(p.y).toBeGreaterThanOrEqual(EDGE);
    expect(fits(p, PHONE)).toBe(true);
  });

  it('stays on screen for every corner of a phone viewport', () => {
    const corners: Array<[number, number]> = [
      [0, 0],
      [PHONE.w, 0],
      [0, PHONE.h],
      [PHONE.w, PHONE.h],
    ];
    for (const [x, y] of corners) {
      expect(fits(placeTooltip(x, y, PHONE.w, PHONE.h), PHONE)).toBe(true);
    }
  });

  it('sweeps the whole phone viewport without ever leaving it', () => {
    for (let x = 0; x <= PHONE.w; x += 10) {
      for (let y = 0; y <= PHONE.h; y += 20) {
        const p = placeTooltip(x, y, PHONE.w, PHONE.h);
        expect(fits(p, PHONE)).toBe(true);
      }
    }
  });

  it('degrades to the left edge when the viewport is narrower than the tooltip', () => {
    // 260px is narrower than TOOLTIP_MAX_W: neither side fits, so pinning to the
    // edge at least shows the box from its start rather than from its middle.
    const p = placeTooltip(200, 400, 260, 600);
    expect(p.x).toBe(EDGE);
  });
});

describe('pointerXY', () => {
  it('reads a mouse event', () => {
    expect(pointerXY({ clientX: 5, clientY: 7 } as MouseEvent)).toEqual({ x: 5, y: 7 });
  });

  it('reads the first touch of a touch event', () => {
    const touch = { touches: [{ clientX: 11, clientY: 13 }] } as unknown as TouchEvent;
    expect(pointerXY(touch)).toEqual({ x: 11, y: 13 });
  });

  it('does not throw on a touch event with an empty touch list', () => {
    // touchend fires with touches: [] — the old inline code read touches[0].clientX
    // straight out and would have thrown here.
    const empty = { touches: [] } as unknown as TouchEvent;
    expect(pointerXY(empty)).toEqual({ x: 0, y: 0 });
  });
});
