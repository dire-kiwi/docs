import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { PluginImport } from "@huntaway/plugin"
import type { PluginMigration } from "@huntaway/plugin"

// The plugin's database (its own SQLite file on each host): the tables the board kept its built-in documents in, as it
// had them (apps/server/migrations/2026-11-12-initial.ts in dire-kiwi/huntaway), so its rows copy across unchanged.
// Profiles are the board's, so nothing here refers to them: a profile's documents are its `profile_id`.

const TABLES = [
  `CREATE TABLE docs (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    folder TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (profile_id, slug)
  ) STRICT`,
  `CREATE INDEX docs_profile_folder ON docs(profile_id, folder)`,
  `CREATE TABLE doc_versions (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    message TEXT,
    task_id TEXT,
    run_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (doc_id, number)
  ) STRICT`,
  `CREATE INDEX doc_versions_task ON doc_versions(task_id)`,
  `CREATE TABLE doc_pages (
    version_id TEXT NOT NULL REFERENCES doc_versions(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    title TEXT NOT NULL,
    format TEXT NOT NULL,
    source TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (version_id, path)
  ) STRICT`,
  `CREATE TABLE doc_labels (
    doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    PRIMARY KEY (doc_id, label)
  ) STRICT`,
  `CREATE TABLE doc_images (
    profile_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    data BLOB NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (profile_id, sha256)
  ) STRICT`,
  `CREATE TABLE doc_version_images (
    version_id TEXT NOT NULL REFERENCES doc_versions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    PRIMARY KEY (version_id, name)
  ) STRICT`,
  `CREATE INDEX doc_version_images_sha ON doc_version_images(sha256)`,
  `CREATE TABLE doc_comments (
    id INTEGER PRIMARY KEY,
    version_id TEXT NOT NULL REFERENCES doc_versions(id) ON DELETE CASCADE,
    page_path TEXT NOT NULL,
    quote TEXT NOT NULL,
    prefix TEXT NOT NULL DEFAULT '',
    suffix TEXT NOT NULL DEFAULT '',
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sent_at TEXT
  ) STRICT`,
  `CREATE INDEX doc_comments_version ON doc_comments(version_id, page_path)`,
  `CREATE TABLE docs_site_clients (
    site_url TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT`,
  // expires_at is milliseconds since the epoch, not a timestamp string.
  `CREATE TABLE docs_site_connections (
    profile_id TEXT PRIMARY KEY,
    site_url TEXT NOT NULL,
    kind TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at INTEGER,
    login TEXT,
    connected_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE docs_site_published (
    doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    site_url TEXT NOT NULL,
    remote_slug TEXT NOT NULL,
    remote_version INTEGER NOT NULL,
    local_version INTEGER NOT NULL,
    url TEXT NOT NULL,
    version_url TEXT NOT NULL,
    login TEXT,
    published_at TEXT NOT NULL,
    PRIMARY KEY (doc_id, site_url)
  ) STRICT`,
]

/** The board's tables this plugin copies, parents before children (for the foreign keys). */
export const IMPORTED = [
  "docs",
  "doc_versions",
  "doc_pages",
  "doc_labels",
  "doc_images",
  "doc_version_images",
  "doc_comments",
  "docs_site_clients",
  "docs_site_connections",
  "docs_site_published",
] as const

/** Which of a copied row's columns this database has (the board's may have more one day). */
const COLUMNS: Readonly<Record<string, ReadonlyArray<string>>> = {
  docs: ["id", "profile_id", "slug", "title", "folder", "created_at", "updated_at"],
  doc_versions: ["id", "doc_id", "number", "message", "task_id", "run_id", "created_at"],
  doc_pages: ["version_id", "path", "title", "format", "source", "position"],
  doc_labels: ["doc_id", "label"],
  doc_images: ["profile_id", "sha256", "data", "width", "height", "created_at"],
  doc_version_images: ["version_id", "name", "sha256"],
  doc_comments: ["id", "version_id", "page_path", "quote", "prefix", "suffix", "comment", "created_at", "updated_at", "sent_at"],
  docs_site_clients: ["site_url", "client_id", "created_at"],
  docs_site_connections: ["profile_id", "site_url", "kind", "access_token", "refresh_token", "expires_at", "login", "connected_at"],
  docs_site_published: ["doc_id", "site_url", "remote_slug", "remote_version", "local_version", "url", "version_url", "login", "published_at"],
}

/** Copies the board's built-in documents (and its hosted-site connections) the first time the plugin runs. */
const importBoard = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const board = yield* PluginImport
  let copied = 0
  for (const table of IMPORTED) {
    // A board that doesn't list a table (an older or newer one) or doesn't have it has nothing of it to copy.
    if (!board.tables.includes(table)) continue
    const rows = yield* board.rows(table).pipe(Effect.catchTag("PluginError", () => Effect.succeed([])))
    const columns = COLUMNS[table] ?? []
    for (const row of rows) {
      const record: Record<string, unknown> = {}
      for (const c of columns) if (c in row) record[c] = row[c]
      yield* sql`INSERT OR IGNORE INTO ${sql(table)} ${sql.insert(record)}`
      copied++
    }
  }
  if (copied > 0) yield* Effect.logInfo(`docs: copied ${copied} rows of the board's built-in documents`)
})

export const migrations: ReadonlyArray<PluginMigration> = [
  {
    name: "0001-documents",
    run: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      for (const statement of TABLES) yield* sql.unsafe(statement)
    }),
  },
  { name: "0002-copy-the-board-s-documents", run: importBoard },
  {
    // The user's answers to a version's form fields (one person per board profile, so no user column): `value` is the
    // answer as JSON. A changed answer is unsent again (`sent_at` NULL) until the user sends it to the task.
    name: "0003-answers",
    run: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`CREATE TABLE doc_answers (
        version_id TEXT NOT NULL REFERENCES doc_versions(id) ON DELETE CASCADE,
        page_path TEXT NOT NULL,
        field TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT,
        PRIMARY KEY (version_id, page_path, field)
      ) STRICT`)
    }),
  },
  {
    // What the user has changed in the editor and not saved (`data`: the editor's draft as JSON), so the board reloading
    // the page (as it does when any document changes) doesn't lose it. One per document, and one (slug '') for a new
    // document; gone once it's saved.
    name: "0004-drafts",
    run: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`CREATE TABLE doc_drafts (
        profile_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, slug)
      ) STRICT`)
    }),
  },
  {
    // Mockups (pages whose format is 'html', shown in the design editor): a comment on one is on an element, and
    // `anchor` is a CSS selector for it ('' for a comment on a page's text).
    name: "0005-comment-anchors",
    run: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`ALTER TABLE doc_comments ADD COLUMN anchor TEXT NOT NULL DEFAULT ''`)
    }),
  },
]
