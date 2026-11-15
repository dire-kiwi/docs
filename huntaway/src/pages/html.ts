// Building the plugin's pages: HTML the board shows in a sandboxed frame with its theme as CSS variables (`--color-*`,
// `--font-*`) and `window.huntaway` as the bridge. Everything shown is escaped here; rendered pages come sanitized from
// the renderer. Styles and the page script are inline (the frame's policy allows nothing else).

export const escape = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;")

/** A template whose `${}` values are escaped, unless they're `raw` (or arrays of `raw`). */
export class Raw {
  readonly html: string
  constructor(html: string) {
    this.html = html
  }
  toString() {
    return this.html
  }
}
export const raw = (html: string) => new Raw(html)

type Value = string | number | null | undefined | false | Raw | ReadonlyArray<Value>
const show = (v: Value): string =>
  v === null || v === undefined || v === false ? "" : v instanceof Raw ? v.html : Array.isArray(v) ? v.map(show).join("") : escape(String(v))

export const html = (strings: TemplateStringsArray, ...values: ReadonlyArray<Value>): Raw =>
  raw(strings.reduce((out, s, i) => out + s + (i < values.length ? show(values[i] as Value) : ""), ""))

/** A JSON value inside a `<script>` or an attribute, so nothing in it closes either. */
export const json = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c")

/** A time the page script shows in the reader's own zone (`<time>`), in UTC until it runs. */
export const time = (iso: string | null) => (iso === null ? "" : html`<time datetime="${iso}">${iso.slice(0, 16).replace("T", " ")} UTC</time>`)

/** Where one of the plugin's pages is, from the board's root. */
export const at = (path: string) => `/docs/${path}`
