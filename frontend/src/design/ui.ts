/** Small pieces the design editor's panels are built from. */

type El<K extends keyof HTMLElementTagNameMap> = HTMLElementTagNameMap[K];
type Attr = string | boolean | number | ((e: Event) => void) | undefined | null;

/** An element with attributes (`on…` functions become listeners) and children. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, Attr> = {},
  ...children: (Node | string | null | false | undefined)[]
): El<K> {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "className") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== false && c !== undefined) el.append(c);
  return el;
}

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

let probe: CanvasRenderingContext2D | null | undefined;

/**
 * A CSS colour as `#rrggbb` and its opacity, whatever it is written as (a name, `rgb()`,
 * `oklch()`…): the browser paints it and the pixel is read. Null if it isn't a colour.
 */
export function colorOf(value: string): { hex: string; alpha: number } | null {
  const v = value.trim();
  if (
    v === "" ||
    !CSS.supports("color", v) ||
    /^(inherit|initial|unset|revert|currentcolor)$/i.test(v)
  )
    return null;
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!probe) return null;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = v;
  probe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 255] = probe.getImageData(0, 0, 1, 1).data;
  // The pixel holds the colour times its opacity.
  const alpha = a / 255;
  const channel = (c: number) =>
    Math.round(alpha === 0 ? 0 : Math.min(255, c / alpha))
      .toString(16)
      .padStart(2, "0");
  return { hex: `#${channel(r)}${channel(g)}${channel(b)}`, alpha: Math.round(alpha * 100) / 100 };
}

/** `hex` with an opacity, as CSS: `#rrggbb`, or `rgb(r g b / a)` when it isn't solid. */
export function withAlpha(hex: string, alpha: number): string {
  if (alpha >= 1) return hex;
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${alpha})`;
}

/** A time as the reader's own, short. */
export function shortTime(at: number | string): string {
  const d = new Date(typeof at === "number" ? at * 1000 : at);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
