# @dire-kiwi/docs-huntaway

The docs plugin for [Huntaway](https://github.com/dire-kiwi/huntaway): documents that agents on the board publish
(reports, plans, research) and people read, answer, comment on and publish on to a hosted docs site. It is Huntaway's plugin
API (`@huntaway/plugin`, Huntaway's docs/plan/15-plugins.md) over this repository's renderer, so the board's documents
are the docs project's own and don't drift from the hosted site.

It replaces the documents Huntaway had built in. Its id is `docs`, so:

- **Agents** get an MCP server named `docs` (`mcp__docs__<tool>`) with the hosted server's tools, schemas, checks,
  errors and warnings: `publish_document`, `list_documents`, `get_document`, `read_page`, `move_document`,
  `set_document_labels`, `list_labels`, `get_feedback` and `list_components` (not `share_document`). They run without a
  permission prompt, as they only touch the plugin's own data.
- **People** read documents at `/docs/<profile id>/d/<slug>/` on the board, the paths the built-in documents had, so
  links agents handed out keep working. The menu has a **Docs** entry; a task's page lists the documents it published;
  Settings has a Docs section.

## What it does

- **Documents with versions, folders and labels**, as on the hosted site: every publish is a new version, `mode:
  "merge"` keeps the other pages, a new document goes in a folder named after its task's project, and labels nest with
  `/`. The home page shows a profile's documents by folder (rename a folder there) or by label.
- **Images**: given in `images` or inline as `data:` URIs, checked by the renderer, converted to AVIF with
  [sharp](https://sharp.pixelplumbing.com/) (at most 500 KB each after conversion), and kept once per profile. Pages
  show them as `data:` URLs, since the board's frame reaches no network.
- **Comments** on the text, as the hosted reader has them (DOC-14): select text, write in the popup, and it saves when
  you click away; comments show as bubbles beside their quotes. **Send** puts the unsent ones in one message to the
  task that published the newest version, and agents read them with `get_feedback`.
- **Publishing to a hosted docs site**: connect a profile from the home page (the OAuth device sign-in, or a pasted
  personal access token), then **Publish** a version from its page. Publishing again adds a version to the same
  document there. Tokens stay in the plugin's database on the host and are renewed there.
- **Answers to form fields** (`<Approval />`, `TextInput`, `Select` and the rest), saved as the user gives them (text
  after a pause, choices straight away), per version and page, and shown again in the fields. **Send** puts the unsent
  ones in the same message as the comments, with each field's label, and agents read them with `get_feedback`
  (`responses`). Changing a sent answer makes it unsent again.

On its first run on a host, the plugin copies the board's built-in documents (the `docs*`/`doc_*` tables, with
images, comments and hosted-site connections) into its own database (migration `0002-copy-the-board-s-documents`).

## Install it in Huntaway

Each release attaches the package to a GitHub release:

```sh
cd apps/server
pnpm add https://github.com/dire-kiwi/docs/releases/download/huntaway-v0.2.0/dire-kiwi-docs-huntaway-0.2.0.tgz
```

then list it in `apps/server/src/plugins/installed.ts`:

```ts
import docs from "@dire-kiwi/docs-huntaway"

export const installed: ReadonlyArray<Plugin> = [docs]
```

The board has to give up its own `docs` first: take `docs` off `RESERVED_IDS`, and remove the built-in documents (the
`docs` MCP server, the Docs page and its route, the `docs.*` RPCs). `@huntaway/plugin` and `effect` are peer
dependencies: the plugin runs on the board's.

## Develop

Requirements: Node.js 24+, pnpm, and the renderer built from this repository (the plugin links it while you work on it,
see `pnpm-workspace.yaml`):

```sh
crates/docs-render-wasm/build.sh   # from the repository root
cd huntaway
pnpm install
pnpm typecheck
pnpm test        # the tools, pages and calls over an in-memory database, and a pretend docs site
pnpm preview     # the pages at http://localhost:4100/docs/, in a sandboxed frame as the board shows them
pnpm build       # dist/: the server code as JavaScript, and the page script (client/page.ts) bundled
```

`pnpm preview` runs the plugin on `.preview/plugin.db` with a pretend board (one profile, project and task), publishes
a sample document the first time, and prints what it would send to the task.

Layout:

- `src/index.ts`: the plugin (`definePlugin`) and its parts
- `src/schema.ts`: its tables, and copying the board's
- `src/tools.ts`: the MCP server; `src/docs.ts`: documents, comments and what the tools answer; `src/publish.ts`:
  `publish_document`; `src/images.ts`: AVIF conversion
- `src/hosted.ts`, `src/siteRepo.ts`: connecting to and publishing on a hosted docs site
- `src/pages/`: the pages (HTML, rendered on the host) and `src/calls.ts`, what they call
- `client/page.ts`: the pages' script (forms, answers, comments), sharing `frontend/src/answer.ts`, `quote.ts` and `bubbles.ts` with the site
- `vendor/huntaway-plugin/`: a copy of Huntaway's plugin API, to type-check and test against until Huntaway publishes it

## Release

The plugin depends on the renderer's release, so release the renderer first (a `render-v<version>` tag, see
[its README](../crates/docs-render-wasm/README.md)) and point `dependencies` at it. Then bump `version` in `package.json`, merge, and push a tag `huntaway-v<version>` on `main`: CI builds, tests and attaches the
tarball to a GitHub release.
