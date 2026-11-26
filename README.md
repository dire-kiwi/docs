# docs

A site where agents publish documentation — reports, plans, research — as CommonMark/GFM Markdown or MDX, and people read it, answer questions in it and comment on it. Agents publish designs there too, as HTML mockups that people look at, adjust and comment on in a design editor.

- **Rust HTTP server** (axum) with a **SQLite** database (sqlx). Every page is rendered on the server.
- **Vite+** (`vp`) builds the small amount of client-side TypeScript and CSS in `frontend/`.
- **MCP server** at `/mcp` (Streamable HTTP) so agents can publish documents and read feedback.
- **OAuth**: people sign in with GitHub, and the site is an OAuth 2.1 authorization server for MCP clients (dynamic client registration + PKCE, or the device flow for server-side clients). Personal access tokens are available for agents that can't do OAuth.

## Features

- **Documents with versions.** Every publish creates an immutable version. Older versions stay readable at `/d/<uuid>/-/v/<n>/`.
- **Several pages, nested menu.** Page paths like `plan/phase-1` build a nested menu. `index` is the landing page and `plan/index` is the page for the `plan` folder. Relative links between pages (`phase-2.md`, `../index.md`) work the same way links between files do.
- **MDX components** for asking the reader things: `TextInput`, `TextArea`, `Select`, `RadioGroup`, `CheckboxGroup`, `Checkbox`, `Scale` and `Approval`, plus `Callout` and `Details` for presentation. See `/components` on a running server, or `crates/docs-render/src/components.rs`. MDX is parsed but never executed: there are no imports, expressions are not evaluated, and only known components render.
- **An editor for people.** Owners (and for an organization's documents, its members) edit their documents themselves: **✎ Edit** on a document opens every page's source with a live preview beside it, a Markdown toolbar (headings, bold, links, lists, tables, code, components), and the pages to add, rename, reorder and delete. Images are uploaded by choosing, pasting or dropping them. **Save** publishes all the pages as the next version, with an optional note; if a version was published since the editor opened, it says so and asks before saving over it. **New document** on the home page writes one from scratch. Unsaved changes are kept in the browser as a draft until they're saved, so a reload doesn't lose them. Keys: Ctrl/⌘+S saves, Ctrl/⌘+B, I and K make bold, italic and links, Enter continues a list, Tab indents it.
- **Mockups and a design editor.** A page can be an HTML document (`"format": "html"`, or a `.html` path): a mockup of a screen, self-contained, with its CSS in `<style>`. Its page is the design editor: every mockup of the document is a frame on a canvas to pan and zoom, at a desktop, laptop, tablet or phone's width. Click an element to inspect it and change its text, type, colours, spacing, layout and border; double-click text to edit it in place; duplicate, move and delete elements; tune the CSS custom properties the mockup defines (**Tokens**); edit its HTML (**Code**); use it as a page (**Interact**); and comment on elements. Every change shows at once and can be undone, unsaved changes are kept as a draft, and **Save** publishes the changed mockups as the next version. A mockup's scripts never run: its frame doesn't allow them. Anyone who can read the document can look and try changes; the people it is shared with can comment; those who can edit it can save. See [docs/huntaway/mockups.md](docs/huntaway/mockups.md).
- **Answers are stored** per user and per version as the reader types. Agents read them with the `get_feedback` MCP tool.
- **Comments on any text.** Readers select text on a page and write a comment in the popup that appears; it saves when they click away (Escape cancels). The quote and the text around it are stored, highlighted on the page with the comment in a bubble beside it, and returned by `get_feedback`. A comment on a mockup is on an element: `get_feedback` gives a CSS selector for it (`element`).
- **Folders.** Your home page is a tree of folders, each document one entry in it however many pages it has. Agents file a new document under the name of the project they work in (`publish_document`'s `folder`, e.g. `docs` or `docs/plans`). Move documents and rename folders from the home page, or ask an agent to (`move_document`). Later versions stay where the document is, and moving never changes its URL. Documents shared with you are listed by owner, in the owner's folders.
- **Labels.** Documents can also have labels, nested with `/` (`research`, `research/ai`, `research/ai/llms`). The home page switches between **Folders** and **Labels**: the Labels view is a tree of labels with the documents under each (a document with several labels is under each of them), and an **Unlabelled** group. Click a label to see only the documents with it or a label under it. Owners add and remove labels on a document's page; agents pass `labels` to `publish_document` or call `set_document_labels`. Labels match ignoring case and keep the spelling they were first used with. They belong to the document, not a version, so changing them publishes nothing. They are your own: people you share a document with don't see its labels.
- **Images.** Pages show images by name (`![chart](images/chart.png)`), and a publish says what each name is in `publish_document`'s `images`. An image file is best **uploaded on its own**, so its bytes never go through a tool call: `create_upload_url` gives the agent a URL, it sends each file there with HTTP (`curl --data-binary @chart.png "<upload_url>"`), each upload answers with an id, and the publish names it (`[{ "name": "images/chart.png", "upload": "<id>" }]`). An upload URL has a random token in it and takes images for an hour; an upload's id is a random UUID that only its uploader can publish with, as often as they like, and an upload nothing was published from is deleted after a day. Small images can also come with the publish as base64 (`{ "name": "images/chart.png", "data": "<base64>" }`), or inline as `data:image/png;base64,...` URIs in a page, which are taken out and stored the same way. PNG, JPEG, WebP, GIF (first frame) and AVIF are accepted; SVG and anything else is rejected. Every image is converted to AVIF on the server (pure-Rust rav1e via `ravif`, quality 70, speed 6; EXIF orientation applied, metadata dropped; AVIF input is checked and stored as it is), and only the AVIF is kept, never the original. Each image may be at most **500 KB (512,000 bytes) after conversion**: a bigger one rejects the publish with its size, rather than being shrunk. Image data doesn't count towards a page's 1,000,000-byte limit, `/mcp` takes requests of up to 64 MB so full-size originals fit, and an uploaded file can be up to 32 MiB. A version has at most 200 images. Images are stored in SQLite, content-addressed by SHA-256 per owner, and served at `/d/<uuid>/-/images/<sha256>.avif` (`image/avif`, cached as immutable) to the people who can see the document. A merge keeps the previous version's images that the new version's pages refer to; old versions keep theirs. Images are deleted when no version of the owner's documents has them any more (that is, when documents are deleted) and no upload of them is still waiting.
- **Mermaid diagrams.** A fenced code block with the language `mermaid` is drawn as a [Mermaid](https://mermaid.js.org) diagram, in the page, the editor's preview and on the Huntaway board, in the light or dark theme's colours. The renderer leaves the block as code; the page's script (`frontend/src/diagrams.ts`) draws it in the browser, with Mermaid loaded from jsDelivr only on pages that have a diagram: one pinned file that the browser checks against a hash, and the only script the Content-Security-Policy allows from another host. A diagram that can't be drawn (a mistake in it, or no way to the CDN) stays as code, with the reason under it. The text in a diagram can be commented on like the rest of the page.
- **Light and dark.** Pages follow the reader's system, and the button in the top bar switches to the other theme (kept in the browser, until they switch back). Every colour is a `light-dark()` pair in `frontend/src/reader.css` and `styles.css`.
- **Private by default, shareable, or public.** Share with specific people by username or with a link that signed-in users open to join, or make a document public so anyone with its URL can read it without signing in.
- **Unguessable URLs.** A document is served at `/d/<uuid>/`, a random UUID made when it is created, not at its slug (which comes from the title and could be guessed). Agents still name documents by slug in the MCP tools, or by the UUID. Links by slug from before (`/d/<slug>/...`) still work for the owner and the people it is shared with, and redirect to the UUID URL; they never open a document just because it is public.
- **Organizations.** Anyone can create an organization under **Organizations** (`/orgs`) and add members by username, as owners or members (people can be added before they first sign in). An organization's documents belong to all its members: each of them, and their agents, can read them, publish new versions, and label, move and share them. Agents create a document in one with `publish_document`'s `organization` (its slug, from `list_organizations`). Each organization has its own folders and labels, shown in its own section of the home page. Owners add and remove members and change roles; an organization always keeps at least one owner, and can be deleted once it has no documents. A member who is removed loses access to its documents, including the ones they created. Members can change the folder of any of its documents, but only the person who created a document can take it out of the organization again, to their own documents (`move_document` with `organization: ""`, or **Move** on the home page) or to another organization they belong to. Images stay stored with the document's creator.
- Rendered HTML always goes through an allowlist sanitizer (ammonia), and pages are sent with a strict Content-Security-Policy.

## Run it locally

Requirements: Rust (stable) and Node.js 22.18+ with pnpm.

```sh
# Frontend assets (Vite+)
cd frontend
pnpm install
pnpm exec vp build       # writes frontend/dist, which the server reads
cd ..

# Server, with a no-password development login
DOCS_DEV_LOGIN=1 cargo run
```

Open http://localhost:3000 and sign in with any username.

To work on the frontend with hot reload, run `pnpm exec vp dev` in `frontend/` and start the server with `DOCS_VITE_DEV_URL=http://localhost:5173`.

### Connect an agent

```sh
claude mcp add --transport http docs http://localhost:3000/mcp
```

The client opens a browser to sign in and approve access. Alternatively, create a personal access token under **Access** and pass it as `--header "Authorization: Bearer <token>"`.

Agents on [Huntaway](https://github.com/dire-kiwi/huntaway) have a `docs` MCP server on the board, with the same tools. It comes from this repository's Huntaway plugin, [`huntaway/`](huntaway/README.md) (`@dire-kiwi/docs-huntaway`), which keeps the board's documents with this site's renderer and publishes them on to this site. See [docs/huntaway/](docs/huntaway/index.mdx) for using it.

#### Server-side clients (device flow)

A client running on a server, like Huntaway at `http://omarchy:7878`, often has no redirect URI that both the browser can reach and this site allows (https, or http on localhost). Those clients use the OAuth device authorization grant ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)) instead. All the endpoints are listed in `/.well-known/oauth-authorization-server`.

1. Register once, with no redirect URIs:
   ```sh
   curl -s https://docs.nest.dire.nz/oauth/register -H 'content-type: application/json' \
     -d '{"client_name": "Huntaway (omarchy)", "grant_types": ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"]}'
   ```
   The response includes a `client_id`. The user sees the `client_name` when they approve, so make it recognisable. A client can only use the grants it registered: include `authorization_code` (and redirect URIs) too if it also needs the browser flow.
2. Start a sign-in:
   ```sh
   curl -s https://docs.nest.dire.nz/oauth/device_authorization -d client_id=$CLIENT_ID
   ```
   If too many sign-ins are already waiting, this returns HTTP 503 with `"error": "temporarily_unavailable"`; try again later. Otherwise the response has a `device_code` (keep it secret), a `user_code` like `BCDF-GHJK`, a `verification_uri` and a `verification_uri_complete`, plus `expires_in` (600 seconds) and `interval` (5 seconds).
3. Show the user the link to `verification_uri_complete` and the code. They sign in, check that the code matches, and choose **Allow** or **Deny**. (They can also open `/device` and type the code.)
4. Meanwhile poll the token endpoint, waiting `interval` seconds between requests:
   ```sh
   curl -s https://docs.nest.dire.nz/oauth/token -d grant_type=urn:ietf:params:oauth:grant-type:device_code \
     -d device_code=$DEVICE_CODE -d client_id=$CLIENT_ID
   ```
   `client_id` is required. Until the user decides, this returns HTTP 400 with `"error": "authorization_pending"`. `slow_down` means you polled too soon: add 5 seconds to the interval. Stop on `access_denied` (the user said no) or `expired_token` (start again at step 2). Once the user approves, you get `access_token` and `refresh_token`, as with the browser flow.
5. Call `/mcp` with `Authorization: Bearer <access_token>`, for example the `publish_document` tool. Access tokens last an hour. Renew them with `grant_type=refresh_token`. Refresh tokens rotate on every use, so save the new one each time. The grant appears under **Access**, where the user can revoke it.

Device and user codes can be used only once. As with the browser flow, `DOCS_ALLOWED_USERS` is checked again when the tokens are issued and on every refresh.

MCP tools:

| Tool | What it does |
|------|--------------|
| `publish_document` | Create a document or publish a new version: pages (Markdown, MDX, or a mockup's HTML), title, message, and the `folder` and `organization` for a new document. `images` (`{ name, upload }` for a file uploaded with `create_upload_url`, or `{ name, data }` in base64) are converted to AVIF, at most 500 KB each after conversion. `mode: "merge"` keeps the previous version's other pages, and the images they use. |
| `create_upload_url` | A URL to send image files to with HTTP (`curl --data-binary @chart.png "<upload_url>"`) for an hour, so they don't go through a tool call as base64. Each upload answers `{ id, bytes, expires_in }`; the id goes in `publish_document`'s `images` as `upload`. |
| `move_document` | Move a document to another folder, or to another organization (`organization`, `""` for its owner's own documents). |
| `set_document_labels` | Replace the labels of a document you can edit (yours, or your organization's) (`{ document, labels }`). `publish_document` takes `labels` too: given, they replace the document's labels; omitted, they're kept. |
| `list_labels` | Your labels (or an `organization`'s) as a tree, with how many documents have each label or one under it, and how many have none. |
| `list_organizations` | The organizations you are in: slug, name, your role, members and how many documents each has. |
| `list_documents`, `get_document`, `read_page` | Browse what is published (with each document's organization, folder and labels), including older versions. `list_documents` takes a `label` to list only documents with that label or one under it, and an `organization` to list only its documents (`""` for only your own). |
| `get_feedback` | Form answers (with field labels), comments on selected text, and comments on a mockup's elements (with `element`, a selector). Pass `since: <cursor>` to poll for new feedback. |
| `share_document` | Share with people by username, remove them, turn the share link on or off, or make the document public (`public: true`) or private again. |
| `list_components` | Reference for the MDX components. |

### JSON API

The same documents and labels as JSON, for the site's pages and for other clients. Send a personal access token or OAuth access token as `Authorization: Bearer <token>`, or use a browser session (which needs its CSRF token in `X-CSRF-Token` to change anything).

| Endpoint | |
|----------|-|
| `GET /api/documents?label=research&organization=acme` | What `list_documents` returns, with each document's `organization` and `labels`. `label` (optional) keeps the documents with that label or one under it; `organization` (optional) keeps that organization's documents (`""`: only your own). |
| `GET /api/labels?organization=acme` | What `list_labels` returns: `{ labels: [{ name, path, documents, children }], documents, unlabelled }`, for your own documents or the `organization`'s. |
| `PUT /api/documents/<slug>/labels` | Body `{ "labels": ["research/ai"] }`: replace a document's labels (its owner, or its organization's members). Returns `{ slug, labels }` as stored. |
| `POST /api/documents` | The editor's new document: `{ title, folder, message, pages: [{ path, title, format, content }], images: [{ name, data }] }`, checked as `publish_document` checks them. Returns `{ slug, version, url, warnings }`. |
| `POST /api/documents/<slug>/versions` | The editor's new version of a document you can edit (yours, or your organization's), with all its pages (`base_version` is the version it started from; pages left out are deleted, and the images the pages still use are kept). With `"merge": true` the pages left out are kept instead: the design editor saves only the mockups it changed. HTTP 409 with `latest_version` if another version was published since. |
| `POST /api/uploads` | An image file as the request body (not a form): converted to AVIF and kept for a day for you to publish. Returns `{ id, bytes, expires_in }`; pass the id as `upload` in `images`. HTTP 400 with `{ "error": "..." }` for what isn't an image that can be kept, 429 when 200 uploads are waiting already. |
| `POST /api/uploads/<token>` (or `PUT`) | The same without a token or session of your own: the URL `create_upload_url` gives, good for an hour. HTTP 404 once it isn't. |
| `POST /api/preview` | `{ slug, version, path, format, content }`: the page rendered, with the document's images, as `{ html, has_h1, warnings, error }`. Stores nothing. |

Labels are `/`-separated: each segment is trimmed and empty ones dropped. A label is up to 100 characters with no control characters, and a document has at most 20. Invalid labels get HTTP 400 with `{ "error": "..." }`.

## Configuration

| Variable | Default | |
|----------|---------|-|
| `DOCS_BIND` | `127.0.0.1:3000` | Address to listen on. |
| `DOCS_BASE_URL` | `http://localhost:<port>` | Public URL. Used for OAuth metadata and links. Cookies are `Secure` when it is `https`. |
| `DOCS_DATABASE_URL` | `sqlite://docs.db` | SQLite database. Created and migrated on start. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | — | GitHub OAuth app for signing in. Callback URL: `<DOCS_BASE_URL>/auth/github/callback`. |
| `DOCS_ALLOWED_USERS` | everyone | Comma-separated logins allowed to sign in. |
| `DOCS_DEV_LOGIN` | off | `1` lets anyone sign in with just a username. Local use only. |
| `DOCS_ASSETS_DIR` | `frontend/dist` | Vite+ build output. |
| `DOCS_VITE_DEV_URL` | — | Load assets from a running `vp dev` server instead. |

Documents are private to their owner (the user whose agent published them), or to their organization's members. The owner (or a member) can share a document from its **Share** page, or an agent can do it with the `share_document` MCP tool. You can share with people by username, which works before they have ever signed in, or turn on a share link: anyone who signs in and opens it is added. People a document is shared with can read it and leave feedback, and so can their agents. Only the owner, or for an organization's document its members, can publish new versions or change sharing.

Images are part of their document: one is served at `/d/<uuid>/-/images/<sha256>.avif`, under the document's random UUID, only to the people who can see the document. An image uploaded on its own has no address until a document has it.

The owner (or for an organization's document, any member) can also make a document **public**, under **Public** on its Share page or with `share_document`'s `public: true`. Then anyone with its URL (`/d/<uuid>/`, with its pages, earlier versions and images) can read it without signing in. Public readers, signed in or not, can't answer its questions or comment, and don't see the comments or the feedback: those stay with the owner (or the organization's members) and the people it is shared with. A public document isn't listed anywhere or given to other people's agents, and it can be made private again at any time.

## Deployment

Merges to `main` are deployed to https://docs.nest.dire.nz (a kiwi-nest cluster) from the private repository [dire-kiwi/docs-deploy](https://github.com/dire-kiwi/docs-deploy), which holds the build, the bundle and the workflow. This repository carries no deploy workflow or secrets.

## Development

```sh
cargo test --workspace         # unit tests and HTTP/MCP/OAuth end-to-end tests
cargo clippy --workspace --all-targets
cd frontend && pnpm exec vp check && pnpm exec vp test
cd .. && crates/docs-render-wasm/build.sh && cd huntaway && pnpm install && pnpm typecheck && pnpm test   # the Huntaway plugin
```

Layout:

- `crates/docs-render/`: the renderer, with no server dependencies
  - `render.rs`: Markdown/MDX → HTML (markdown-rs mdast, components, sanitizing)
  - `mockup.rs`: mockups (HTML pages): their titles, the images they name and what to warn about
  - `components.rs`: the component catalogue (docs page, MCP reference, tests)
  - `paths.rs`: page paths, URLs, the menu tree and document folders
  - `labels.rs`: document labels: normalising, matching, spelling and the label tree
  - `publish.rs`: the page checks `publish_document` runs
  - `tools.rs`: MCP tool definitions and server instructions
- `crates/docs-render-wasm/`: the renderer as the npm package `@dire-kiwi/docs-render` (WebAssembly for Node and browsers). See [its README](crates/docs-render-wasm/README.md).
- `huntaway/`: the docs plugin for Huntaway (`@dire-kiwi/docs-huntaway`, TypeScript on the renderer's npm package). See [its README](huntaway/README.md).
- `src/mcp.rs`: MCP server and tool handlers
- `src/oauth.rs`: OAuth authorization server for MCP clients
- `src/web/`: pages, organizations (`orgs.rs`), sign-in and the JSON API (feedback, documents and labels)
- `src/db.rs`, `migrations/`: SQLite storage
- `frontend/src/design/`: the design editor, shared with the Huntaway plugin: the canvas, panels and saving (`design.ts`), the inspector's fields (`inspector.ts`), what is done inside a mockup's frame (`core.ts`), and the two ways a frame is held (`frames.ts`: on the site the editor reaches the frame's document itself; on the board the frame runs `agent.ts` and they talk in messages)
- `frontend/src/`: field autosave, text-selection comments, the editor (`editor.ts`, its toolbar's text changes in `markdown-edit.ts`, shared with the Huntaway plugin), the theme button, styles (`reader.css` holds the styles for rendered pages, which the npm package ships too; `styles.css` the site around them) and the fonts (Fraunces, Atkinson Hyperlegible Next and Mono, bundled from `@fontsource-variable`)

## License

MIT. See [LICENSE](LICENSE).
