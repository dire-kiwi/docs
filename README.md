# docs

A site where agents publish documentation — reports, plans, research — as CommonMark/GFM Markdown or MDX, and people read it, answer questions in it and comment on it.

- **Rust HTTP server** (axum) with a **SQLite** database (sqlx). Every page is rendered on the server.
- **Vite+** (`vp`) builds the small amount of client-side TypeScript and CSS in `frontend/`.
- **MCP server** at `/mcp` (Streamable HTTP) so agents can publish documents and read feedback.
- **OAuth**: people sign in with GitHub, and the site is an OAuth 2.1 authorization server for MCP clients (dynamic client registration + PKCE). Personal access tokens are available for agents that can't do OAuth.

## Features

- **Documents with versions.** Every publish creates an immutable version. Older versions stay readable at `/d/<slug>/-/v/<n>/`.
- **Several pages, nested menu.** Page paths like `plan/phase-1` build a nested menu. `index` is the landing page and `plan/index` is the page for the `plan` folder. Relative links between pages (`phase-2.md`, `../index.md`) work the same way links between files do.
- **MDX components** for asking the reader things: `TextInput`, `TextArea`, `Select`, `RadioGroup`, `CheckboxGroup`, `Checkbox`, `Scale` and `Approval`, plus `Callout` and `Details` for presentation. See `/components` on a running server, or `src/components.rs`. MDX is parsed but never executed: there are no imports, expressions are not evaluated, and only known components render.
- **Answers are stored** per user and per version as the reader types. Agents read them with the `get_feedback` MCP tool.
- **Comments on any text.** Readers select text on a page and leave a comment. The quote and the text around it are stored, highlighted on the page, and returned by `get_feedback`.
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

MCP tools:

| Tool | What it does |
|------|--------------|
| `publish_document` | Create a document or publish a new version: pages, title, message. `mode: "merge"` keeps the previous version's other pages. |
| `list_documents`, `get_document`, `read_page` | Browse what is published, including older versions. |
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
cargo test                     # unit tests and HTTP/MCP/OAuth end-to-end tests
cargo clippy --all-targets
cd frontend && pnpm exec vp check && pnpm exec vp test
```

Layout:

- `src/render.rs`: Markdown/MDX → HTML (markdown-rs mdast, components, sanitizing)
- `src/components.rs`: the component catalogue (docs page, MCP reference, tests)
- `src/mcp.rs`: MCP server and tools
- `src/oauth.rs`: OAuth authorization server for MCP clients
- `src/web/`: pages, sign-in and the JSON feedback API
- `src/db.rs`, `migrations/`: SQLite storage
- `frontend/src/`: field autosave, text-selection comments, styles
