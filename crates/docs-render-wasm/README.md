# @dire-kiwi/docs-render

The renderer of [docs](https://github.com/dire-kiwi/docs) as WebAssembly, for Node and for browsers: Markdown/MDX → sanitized HTML, page paths and the menu tree, the checks `publish_document` runs, the MDX component reference and the MCP tool definitions. It is the same Rust code the hosted server runs (`crates/docs-render`), so pages render, and publishes are accepted or rejected, exactly as they are there.

## Install

Each release attaches the package to a GitHub release, so it installs from a URL, without a registry or a token:

```sh
pnpm add https://github.com/dire-kiwi/docs/releases/download/render-v0.7.0/dire-kiwi-docs-render-0.7.0.tgz
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

The look is print: ink on paper, with an ink line and a hard offset shadow around what the reader can use. It is all CSS variables on `.docs-render`, to override to match your theme:

| Variables | |
|-----------|-|
| `--bg`, `--bg-soft`, `--fg`, `--fg-muted`, `--border` | Paper, sunken paper (table heads, inline code), ink, quieter ink and hairlines. |
| `--line`, `--shadow` | The line around fields, inputs and collapsible sections, and their offset shadow (`transparent` for none). |
| `--accent`, `--accent-fg` | Links, the chosen answer, focus; and text on the accent. |
| `--success`, `--warning`, `--danger` | Callouts and the three approval stamps. |
| `--bg-mark`, `--mark-fg` | Highlighter (hover on scale points and collapsible sections), and text on it. |
| `--code-bg`, `--code-fg` | Code blocks. |
| `--radius`, `--font`, `--font-display`, `--mono` | Corners, body type, headings and labels. |

Each colour is a `light-dark()` pair and `.docs-render` has `color-scheme: light dark`, so pages follow the reader's system. Set `color-scheme: light` or `dark` on `.docs-render` to pick one (or `inherit`, to follow your page's).

The fonts (Fraunces for headings, Atkinson Hyperlegible Next for text and Atkinson Hyperlegible Mono for code and labels) are not in the package: load them yourself, e.g. from `@fontsource-variable`, or set `--font`, `--font-display` and `--mono`. Without them the stacks fall back to system serif, sans and mono fonts.

The site's form autosave and text-selection comments (`frontend/src/fields.ts`, `selection.ts`) are not in the package yet. Form fields render with `data-field` and `data-kind` attributes, so you can read the answers yourself.

## API

Errors are thrown as plain strings: the same messages the hosted server reports. A missing or wrongly typed argument throws a string too (e.g. `path must be a string, not number`). Full types are in `docs_render.d.ts`.

| Function | |
|---|---|
| `render(source, format, { pagePath, baseUrl, answers?, images? }?)` | → `{ html, toc, hasH1, fields, warnings, imageSrcs }`. `format` is `"md"`, `"mdx"` or `"html"` (a mockup: an HTML document the design editor shows, for which `html` is empty and `imageSrcs` lists what its `src`s and CSS `url()`s name). Relative links are rewritten against `baseUrl` (ending in `/`). Without options, the page is `index` and `baseUrl` is `/`. `answers` (field name → saved answer) prefills form fields. `images` (image name → URL) points each `<img src>` that refers to one of the version's images at its URL; `imageSrcs` lists the page's relative `<img src>`s. `data:` URIs are always stripped. Throws if the source cannot be parsed (e.g. an unclosed MDX tag). |
| `meta(source, format)` | → `{ title, order }` from YAML frontmatter `title:` / `order:`, else the first `# heading`. |
| `normalizePath(raw)` | `./Plan/Phase 1.md` → `plan/phase-1`. Throws for invalid paths. |
| `urlSuffix(path)`, `pathCandidates(suffix)` | Page path ↔ URL: `plan/index` ↔ `plan/`, `index` ↔ `` . |
| `normalizeFolder(raw)` | ` docs//plans/ ` → `docs/plans`: the folder a document is filed in, as `publish_document` and `move_document` normalise it (`""` is the top level). Throws for `.`/`..` segments, control characters and folders over 200 characters. |
| `normalizeLabel(raw)`, `normalizeLabels(raws)` | ` Research // AI ` → `Research/AI`: document labels as `publish_document` and `set_document_labels` normalise them (case is kept). `normalizeLabels` also drops duplicates, ignoring case, and allows at most 20. Throws for empty labels, control characters and labels over 100 characters. |
| `labelMatches(label, filter)` | Whether `label` is `filter` or nested under it, ignoring case (`research/ai` is under `research`, `researchers` isn't). |
| `withKnownCase(label, known)` | Spell a label the way a label set already does, so the first use wins: `("research/x", ["Research/AI"])` → `Research/x`. |
| `labelTree(labelsPerDocument)` | → nested `{ name, path, documents, docs, children }[]`, as `list_labels` returns it. `documents` counts the documents with the label or one under it; `docs` are the indexes of those with exactly that label. |
| `resolveLink(from, href)` | → `{ path, suffix }` for a relative link written in page `from`, or `null` for absolute URLs, `/root` links and `#fragments`. |
| `titleFromPath(path)` | `plan/phase-1` → `Phase 1`, `index` → `Overview`. |
| `navTree([[path, title], ...])` | → nested `{ segment, title, page, children }[]` for the menu. |
| `validatePage(source, format?, path = "index")` | → `{ path, format, title, position, warnings }`, the checks `publish_document` runs on one page. Without `format`, it is inferred as publishing does (extension, then content). Throws what `publish_document` would return. |
| `validatePages(pages)` | `pages` as given to `publish_document` (`{ path, content, format?, title? }[]`) → `{ pages, warnings }`. Adds the whole-publish checks: at most 500 pages, no duplicate paths. Inline `data:image/...;base64,` images are taken out first (each page's `source` refers to them by name) and don't count towards the page size. |
| `validatePublish(pages, images)` | `validatePages` plus `publish_document`'s `images` (`{ name, data }[]` in base64, or `{ name, upload }[]` for images uploaded on their own) → `{ pages, images, uploaded, warnings }`: each image checked (name, base64, PNG/JPEG/WebP/GIF/AVIF, given once) with the pages' inline ones, at most 200, as `{ name, label, format, data }` (`label` is how errors name it, `data` the original bytes in base64, to convert). Those given by `upload` come back in `uploaded` as `{ name, label, upload }` (the id trimmed and in lower case), for you to look up: `imageUploadMissingError(label, id)` is the message when there is none. Throws what `publish_document` would return. |
| `validateUpload(data)`, `uploadErrors()` | For an image file uploaded on its own (to a `create_upload_url` URL), in base64: checks its size (32 MiB) and what it is → `{ label: "the uploaded image", format }`, to convert as any other image; throws the message the upload answers with. And the other messages an upload URL answers with: `{ tooMany, tooBig, url, body }` (200 uploads waiting already, a file over the limit, a URL that isn't valid any more, a request without a file as its body). |
| `extractInlineImages(content, format, path = "index")` | → `{ content, images: { name, data }[] }`: the inline base64 images `publish_document` takes out of a page (not those in code), each once, named `images/inline-<16 hex of the SHA-256 of the bytes>.avif`, with `data` the original bytes in base64 for you to convert. Throws for invalid base64 or a format other than PNG, JPEG, WebP, GIF or AVIF (SVG included). |
| `normalizeImageName(raw)`, `imageCandidates(pagePath, src)` | Image names as `publish_document` takes them (`./images/a.png` → `images/a.png`), and the names an `<img src>` in a page may refer to: relative to the page's folder, then to the document root. |
| `imageLimits()`, `imageTooLargeError(subject, avifBytes)`, `imageTooManyError(count)`, `imageUnreadableError(subject, detail)` | `{ maxImageBytes: 512000, maxImages: 200, maxPageBytes: 1000000, maxUploadBytes: 33554432, uploadUrlSeconds: 3600, uploadKeptSeconds: 86400, maxWaitingUploads: 200 }`, and the message for an image over the limit after AVIF conversion (`subject` is `image "<name>"` or `inline image <n> on page "<path>"`). Converting to AVIF is up to you: the package doesn't encode images. The other two are the messages for more than 200 images, and for an image that can't be decoded. |
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
