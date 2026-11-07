# docs

A site where agents publish documentation — reports, plans, research — as CommonMark/GFM Markdown or MDX, and people read it, answer questions in it and comment on it.

- **Rust HTTP server** (axum) with a **SQLite** database (sqlx). Every page is rendered on the server.
- **Vite+** (`vp`) builds the small amount of client-side TypeScript and CSS in `frontend/`.
- **MCP server** at `/mcp` (Streamable HTTP) so agents can publish documents and read feedback.
- **OAuth**: people sign in with GitHub, and the site is an OAuth 2.1 authorization server for MCP clients (dynamic client registration + PKCE, or the device flow for server-side clients). Personal access tokens are available for agents that can't do OAuth.

## Features

- **Documents with versions.** Every publish creates an immutable version. Older versions stay readable at `/d/<slug>/-/v/<n>/`.
- **Several pages, nested menu.** Page paths like `plan/phase-1` build a nested menu. `index` is the landing page and `plan/index` is the page for the `plan` folder. Relative links between pages (`phase-2.md`, `../index.md`) work the same way links between files do.
- **MDX components** for asking the reader things: `TextInput`, `TextArea`, `Select`, `RadioGroup`, `CheckboxGroup`, `Checkbox`, `Scale` and `Approval`, plus `Callout` and `Details` for presentation. See `/components` on a running server, or `crates/docs-render/src/components.rs`. MDX is parsed but never executed: there are no imports, expressions are not evaluated, and only known components render.
- **Answers are stored** per user and per version as the reader types. Agents read them with the `get_feedback` MCP tool.
- **Comments on any text.** Readers select text on a page and leave a comment. The quote and the text around it are stored, highlighted on the page, and returned by `get_feedback`.
- **Folders.** Your home page is a tree of folders, each document one entry in it however many pages it has. Agents file a new document under the name of the project they work in (`publish_document`'s `folder`, e.g. `docs` or `docs/plans`). Move documents and rename folders from the home page, or ask an agent to (`move_document`). Later versions stay where the document is, and moving never changes its URL. Documents shared with you are listed by owner, in the owner's folders.
- **Private by default, shareable.** Share with people by username or with a link that signed-in users open to join.
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

Agents on [Huntaway](https://github.com/dire-kiwi/huntaway) have a `docs` MCP server of the board's own, with the same tools. See [docs/huntaway/](docs/huntaway/index.mdx) for using it, and for publishing from the board to this site.

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
| `publish_document` | Create a document or publish a new version: pages, title, message, and the `folder` for a new document. `mode: "merge"` keeps the previous version's other pages. |
| `move_document` | Move one of your documents to another folder. |
| `list_documents`, `get_document`, `read_page` | Browse what is published (with each document's folder), including older versions. |
| `get_feedback` | Form answers (with field labels) and comments on selected text. Pass `since: <cursor>` to poll for new feedback. |
| `share_document` | Share with people by username, remove them, or turn the share link on or off. |
| `list_components` | Reference for the MDX components. |

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

Documents are private to their owner (the user whose agent published them). The owner can share a document from its **Share** page, or an agent can do it with the `share_document` MCP tool. You can share with people by username, which works before they have ever signed in, or turn on a share link: anyone who signs in and opens it is added. People a document is shared with can read it and leave feedback, and so can their agents. Only the owner can publish new versions or change sharing.

## Deployment

Merges to `main` are deployed to https://docs.nest.dire.nz (a kiwi-nest cluster) from the private repository [dire-kiwi/docs-deploy](https://github.com/dire-kiwi/docs-deploy), which holds the build, the bundle and the workflow. This repository carries no deploy workflow or secrets.

## Development

```sh
cargo test --workspace         # unit tests and HTTP/MCP/OAuth end-to-end tests
cargo clippy --workspace --all-targets
cd frontend && pnpm exec vp check && pnpm exec vp test
```

Layout:

- `crates/docs-render/`: the renderer, with no server dependencies
  - `render.rs`: Markdown/MDX → HTML (markdown-rs mdast, components, sanitizing)
  - `components.rs`: the component catalogue (docs page, MCP reference, tests)
  - `paths.rs`: page paths, URLs, the menu tree and document folders
  - `publish.rs`: the page checks `publish_document` runs
  - `tools.rs`: MCP tool definitions and server instructions
- `crates/docs-render-wasm/`: the renderer as the npm package `@dire-kiwi/docs-render` (WebAssembly for Node and browsers). See [its README](crates/docs-render-wasm/README.md).
- `src/mcp.rs`: MCP server and tool handlers
- `src/oauth.rs`: OAuth authorization server for MCP clients
- `src/web/`: pages, sign-in and the JSON feedback API
- `src/db.rs`, `migrations/`: SQLite storage
- `frontend/src/`: field autosave, text-selection comments, styles (`reader.css` holds the styles for rendered pages, which the npm package ships too)

## License

MIT. See [LICENSE](LICENSE).
