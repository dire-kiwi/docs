# @dire-kiwi/docs-render

The renderer of [docs](https://github.com/dire-kiwi/docs) as WebAssembly, for Node and for browsers: Markdown/MDX → sanitized HTML, page paths and the menu tree, the checks `publish_document` runs, the MDX component reference and the MCP tool definitions. It is the same Rust code the hosted server runs (`crates/docs-render`), so pages render, and publishes are accepted or rejected, exactly as they are there.

## Install

Each release attaches the package to a GitHub release, so it installs from a URL, without a registry or a token:

```sh
pnpm add https://github.com/dire-kiwi/docs/releases/download/render-v0.1.0/dire-kiwi-docs-render-0.1.0.tgz
```

## Use it from Node

The Node entry loads the WebAssembly when it is imported, so everything works straight away:

```ts
import { render, validatePages, toolDefinitions } from "@dire-kiwi/docs-render";

const page = render("# Plan\n\n<Approval />", "mdx", { pagePath: "index", baseUrl: "/d/plan/" });
page.html; // sanitized HTML
page.fields; // [{ name: "approval", kind: "approval", label: "Do you approve this?" }]
```

## Use it from a browser (Vite)

The browser entry needs `init()` once before anything else. Vite finds the `.wasm` file through `import.meta.url` in builds and in the dev server:

```ts
import init, { render } from "@dire-kiwi/docs-render";
import "@dire-kiwi/docs-render/styles.css";

await init();
const { html } = render(source, "md", { pagePath: "plan/phase-1", baseUrl: "/d/plan/" });
```

`init` also takes the module explicitly, as a URL, a `Response`, bytes or a `WebAssembly.Module`:

```ts
import wasmUrl from "@dire-kiwi/docs-render/docs_render_bg.wasm?url";
await init({ module_or_path: wasmUrl });
```

Calling `init()` in Node does nothing, so shared code can always call it. `@dire-kiwi/docs-render/web` is the browser entry, if you need it on purpose (e.g. `initSync({ module: bytes })` in a worker).

## Styles

`@dire-kiwi/docs-render/styles.css` holds the docs reader styles: rendered Markdown, code, tables, callouts and form fields. They are scoped with `@scope (.docs-render)`, so they do not touch the rest of your page:

```html
<div class="docs-render">
  <article class="doc-content"><!-- render(...).html --></article>
</div>
```

The colours are CSS variables on `.docs-render` (`--bg`, `--bg-soft`, `--fg`, `--fg-muted`, `--border`, `--accent`, `--accent-fg`, `--danger`, `--success`, `--warning`, `--radius`, `--font`, `--mono`), with a dark set under `prefers-color-scheme: dark`. Override them to match your theme.

The site's form autosave and text-selection comments (`frontend/src/fields.ts`, `selection.ts`) are not in the package yet. Form fields render with `data-field` and `data-kind` attributes, so you can read the answers yourself.

## API

Errors are thrown as plain strings: the same messages the hosted server reports. A missing or wrongly typed argument throws a string too (e.g. `path must be a string, not number`). Full types are in `docs_render.d.ts`.

| Function | |
|---|---|
| `render(source, format, { pagePath, baseUrl, answers? }?)` | → `{ html, toc, hasH1, fields, warnings }`. `format` is `"md"` or `"mdx"`. Relative links are rewritten against `baseUrl` (ending in `/`). Without options, the page is `index` and `baseUrl` is `/`. `answers` (field name → saved answer) prefills form fields. Throws if the source cannot be parsed (e.g. an unclosed MDX tag). |
| `meta(source, format)` | → `{ title, order }` from YAML frontmatter `title:` / `order:`, else the first `# heading`. |
| `normalizePath(raw)` | `./Plan/Phase 1.md` → `plan/phase-1`. Throws for invalid paths. |
| `urlSuffix(path)`, `pathCandidates(suffix)` | Page path ↔ URL: `plan/index` ↔ `plan/`, `index` ↔ `` . |
| `resolveLink(from, href)` | → `{ path, suffix }` for a relative link written in page `from`, or `null` for absolute URLs, `/root` links and `#fragments`. |
| `titleFromPath(path)` | `plan/phase-1` → `Phase 1`, `index` → `Overview`. |
| `navTree([[path, title], ...])` | → nested `{ segment, title, page, children }[]` for the menu. |
| `validatePage(source, format?, path = "index")` | → `{ path, format, title, position, warnings }`, the checks `publish_document` runs on one page. Without `format`, it is inferred as publishing does (extension, then content). Throws what `publish_document` would return. |
| `validatePages(pages)` | `pages` as given to `publish_document` (`{ path, content, format?, title? }[]`) → `{ pages, warnings }`. Adds the whole-publish checks: at most 500 pages, no duplicate paths. |
| `componentsReference()` | The `list_components` text (Markdown). |
| `components()` | The component catalogue: name, summary, props, answer shape and example. |
| `toolDefinitions()` | The MCP `tools/list` entries the hosted server advertises (name, title, description, inputSchema, annotations). |
| `serverInstructions()` | The `instructions` from the hosted server's MCP `initialize` result. |
| `sanitize(html)` | The allowlist sanitizer every rendered page goes through. |

## Develop

From the repository root:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version <the wasm-bindgen version in Cargo.lock> --locked
crates/docs-render-wasm/build.sh   # → target/npm/dire-kiwi-docs-render-<version>.tgz
crates/docs-render-wasm/test.sh    # installs the tarball and compares it with the native renderer
```

To release, bump `version` in `crates/docs-render-wasm/Cargo.toml`, merge, and push a tag `render-v<version>` on `main`. CI builds, tests and attaches the tarball to a GitHub release.
