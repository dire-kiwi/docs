/** The canvas's view: where the world's origin is on screen, and how far it is zoomed. */
export interface View {
  x: number;
  y: number;
  z: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;

export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** `view` zoomed to `z`, keeping the world point under the screen point (`cx`, `cy`) where it is. */
export function zoomAt(view: View, cx: number, cy: number, z: number): View {
  const to = clamp(z, MIN_ZOOM, MAX_ZOOM);
  const k = to / view.z;
  return { x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k, z: to };
}

/**
 * The view that shows `box` in a canvas `cw` by `ch`: as wide as fits with `pad` around it, at
 * most full size, centred; a box taller than the canvas starts at its top.
 */
export function fitView(box: Box, cw: number, ch: number, pad: number): View {
  const z = clamp((cw - pad * 2) / Math.max(1, box.w), MIN_ZOOM, 1);
  const tall = box.h * z > ch - pad * 2;
  return {
    z,
    x: (cw - box.w * z) / 2 - box.x * z,
    y: tall ? pad - box.y * z : (ch - box.h * z) / 2 - box.y * z,
  };
}

/** The view moved as little as it takes for `box` (in the world) to be inside the canvas, `pad` from its edges. */
export function revealView(view: View, box: Box, cw: number, ch: number, pad: number): View {
  const left = box.x * view.z + view.x;
  const top = box.y * view.z + view.y;
  const right = left + box.w * view.z;
  const bottom = top + box.h * view.z;
  let { x, y } = view;
  if (left < pad || right - left > cw - pad * 2) x += pad - left;
  else if (right > cw - pad) x -= right - (cw - pad);
  if (top < pad || bottom - top > ch - pad * 2) y += pad - top;
  else if (bottom > ch - pad) y -= bottom - (ch - pad);
  return { x, y, z: view.z };
}
