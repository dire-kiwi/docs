import { expect, test } from "vite-plus/test";
import { fitView, MAX_ZOOM, MIN_ZOOM, revealView, zoomAt } from "./geometry.ts";

test("zooming keeps the point under the pointer", () => {
  const view = { x: 40, y: -20, z: 0.5 };
  const at = (v: typeof view, cx: number, cy: number) => [(cx - v.x) / v.z, (cy - v.y) / v.z];
  const zoomed = zoomAt(view, 300, 200, 2);
  expect(zoomed.z).toBe(2);
  expect(at(zoomed, 300, 200)).toEqual(at(view, 300, 200));
  expect(zoomAt(view, 0, 0, 100).z).toBe(MAX_ZOOM);
  expect(zoomAt(view, 0, 0, 0).z).toBe(MIN_ZOOM);
});

test("fitting shows a box as wide as fits, never bigger than full size", () => {
  // Wider than the canvas: scaled down and centred.
  expect(fitView({ x: 0, y: 0, w: 2000, h: 500 }, 1100, 800, 50)).toEqual({
    z: 0.5,
    x: 50,
    y: 275,
  });
  // Small: full size, centred.
  expect(fitView({ x: 100, y: 0, w: 400, h: 300 }, 1000, 700, 50)).toEqual({
    z: 1,
    x: 200,
    y: 200,
  });
  // Taller than the canvas: from its top.
  expect(fitView({ x: 0, y: 40, w: 1000, h: 5000 }, 1100, 800, 50)).toEqual({ z: 1, x: 50, y: 10 });
});

test("revealing moves the view only as far as it must", () => {
  const view = { x: 0, y: 0, z: 1 };
  expect(revealView(view, { x: 100, y: 100, w: 50, h: 50 }, 800, 600, 20)).toEqual(view);
  expect(revealView(view, { x: 900, y: 100, w: 50, h: 50 }, 800, 600, 20)).toEqual({
    x: -170,
    y: 0,
    z: 1,
  });
  expect(revealView(view, { x: 100, y: -300, w: 50, h: 50 }, 800, 600, 20)).toEqual({
    x: 0,
    y: 320,
    z: 1,
  });
  // Bigger than the canvas: its top left corner.
  expect(revealView(view, { x: 100, y: 700, w: 2000, h: 2000 }, 800, 600, 20)).toEqual({
    x: -80,
    y: -680,
    z: 1,
  });
});
