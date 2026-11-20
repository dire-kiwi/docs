/** Text helpers of the design editor that need no document, so they can be tested alone. */

const URL_FN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s][^)]*?))\s*\)/g;

/** `css` with each `url(...)` whose reference `change` knows pointing at what it gives. */
export function mapCssUrls(css: string, change: (ref: string) => string | undefined): string {
  return css.replace(URL_FN, (all: string, double?: string, single?: string, bare?: string) => {
    const to = change((double ?? single ?? bare ?? "").trim());
    return to === undefined ? all : `url("${to}")`;
  });
}

/** Text on one line, cut to `max` characters. */
export function shortText(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * A CSS selector from the steps down to an element: each its tag and place among its
 * parent's children, starting at `<body>` or at the nearest ancestor with an id of its own.
 */
export function selectorSteps(steps: { tag: string; id: string | null; index: number }[]): string {
  return steps
    .map((s) =>
      s.id !== null
        ? `#${s.id}`
        : s.tag === "body" || s.tag === "head"
          ? s.tag
          : `${s.tag}:nth-child(${s.index})`,
    )
    .join(" > ");
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** How a comment quotes an element, for someone reading the mockup's HTML: its tag and the start of its text. */
export function quoteOf(
  tag: string,
  id: string | null,
  classes: string | null,
  text: string,
  attrs: Record<string, string | null | undefined> = {},
): string {
  let open = `<${tag}`;
  if (id) open += ` id="${escapeAttr(id)}"`;
  if (classes?.trim()) open += ` class="${escapeAttr(shortText(classes, 80))}"`;
  for (const [name, value] of Object.entries(attrs)) {
    if (value) open += ` ${name}="${escapeAttr(shortText(value, 120))}"`;
  }
  const inside = shortText(text, 140);
  return inside === "" ? `${open}>` : `${open}>${inside}</${tag}>`;
}

/** The end of a page's URL (the renderer's `url_suffix`): `index` is its folder. */
export function urlSuffix(path: string): string {
  if (path === "index") return "";
  return path.endsWith("/index") ? path.slice(0, -"index".length) : path;
}

/** A length as CSS takes it: a bare number is pixels. */
export function cssLength(value: string): string {
  const v = value.trim();
  return /^-?(\d+\.?\d*|\.\d+)$/.test(v) && Number(v) !== 0 ? `${v}px` : v;
}

/** A used value as a field shows it: whole pixels without their unit noise (`12.5px` → `12.5`). */
export function shownLength(value: string): string {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
  return m ? String(Math.round(Number(m[1]) * 100) / 100) : value.trim();
}
