import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { byLowercase } from "./rules.ts"

// The plugin's tables (schema.ts): `docs` (a profile's, slug unique in it, with its folder), its immutable `doc_versions`
// and their `doc_pages`, `doc_labels`, the profile's AVIFs by sha256 (`doc_images`) and the names versions give them
// (`doc_version_images`), and `doc_comments` and `doc_answers` on a version's pages. Single statements; `Docs` puts them in
// transactions. SQL errors and rows that don't decode are defects.

export const Format = Schema.Literals(["md", "mdx"])
export type Format = typeof Format.Type

/** A document as it's kept, with its latest version's number, how many pages that has, and its labels (sorted). */
export interface Doc {
  readonly id: string
  readonly profile_id: string
  readonly slug: string
  readonly title: string
  readonly folder: string
  readonly created_at: string
  readonly updated_at: string
  readonly latest_version: number
  readonly page_count: number
  readonly labels: ReadonlyArray<string>
}

const DocRow = Schema.Struct({
  id: Schema.String,
  profile_id: Schema.String,
  slug: Schema.String,
  title: Schema.String,
  folder: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  latest_version: Schema.NullOr(Schema.Finite),
  page_count: Schema.Finite,
  labels: Schema.NullOr(Schema.String),
})

export const VersionRow = Schema.Struct({
  id: Schema.String,
  number: Schema.Int,
  message: Schema.NullOr(Schema.String),
  task_id: Schema.NullOr(Schema.String),
  run_id: Schema.NullOr(Schema.String),
  created_at: Schema.String,
})
export type VersionRow = typeof VersionRow.Type

const PageSummaryRow = Schema.Struct({ path: Schema.String, title: Schema.String, format: Format, position: Schema.Int })
export type PageSummary = typeof PageSummaryRow.Type
const PageRow = Schema.Struct({ ...PageSummaryRow.fields, source: Schema.String })
/** A page with its source. */
export type DocPage = typeof PageRow.Type

const ImageRow = Schema.Struct({ name: Schema.String, sha256: Schema.String, bytes: Schema.Finite, width: Schema.Finite, height: Schema.Finite })
/** A version's image, without its bytes. */
export type DocImage = typeof ImageRow.Type
const ImageRef = Schema.Struct({ name: Schema.String, sha256: Schema.String })
const ImageData = Schema.Struct({ data: Schema.Uint8Array })

export const Comment = Schema.Struct({
  id: Schema.Int,
  version: Schema.Int,
  page: Schema.String,
  quote: Schema.String,
  prefix: Schema.String,
  suffix: Schema.String,
  comment: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  sent_at: Schema.NullOr(Schema.String),
})
export type Comment = typeof Comment.Type

/** The user's answer to a form field, its value as JSON. */
export const Answer = Schema.Struct({
  version: Schema.Int,
  page: Schema.String,
  field: Schema.String,
  value: Schema.String,
  updated_at: Schema.String,
  sent_at: Schema.NullOr(Schema.String),
})
export type Answer = typeof Answer.Type

const Id = Schema.Struct({ id: Schema.String })
const Label = Schema.Struct({ label: Schema.String })
const Count = Schema.Struct({ n: Schema.Finite })
const Published = Schema.Struct({ slug: Schema.String, title: Schema.String, number: Schema.Int, created_at: Schema.String })

/** Rows decoded with `schema`; a failure of either is a defect. */
const rowsOf =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  <E, R>(statement: Effect.Effect<ReadonlyArray<unknown>, E, R>): Effect.Effect<ReadonlyArray<S["Type"]>, never, R> =>
    statement.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(schema))), Effect.orDie)

const first = <A, R>(found: Effect.Effect<ReadonlyArray<A>, never, R>) => Effect.map(found, (list) => list[0] ?? null)
const done = <A, E, R>(statement: Effect.Effect<A, E, R>) => statement.pipe(Effect.asVoid, Effect.orDie)

const docRows = rowsOf(DocRow)
const versionRows = rowsOf(VersionRow)
const pageSummaryRows = rowsOf(PageSummaryRow)
const pageRows = rowsOf(PageRow)
const imageRows = rowsOf(ImageRow)
const imageRefRows = rowsOf(ImageRef)
const imageDataRows = rowsOf(ImageData)
const commentRows = rowsOf(Comment)
const answerRows = rowsOf(Answer)
const idRows = rowsOf(Id)
const labelRows = rowsOf(Label)
const countRows = rowsOf(Count)
const publishedRows = rowsOf(Published)

// Labels have no control characters, so a newline keeps them apart.
const docOf = (r: typeof DocRow.Type): Doc => ({
  ...r,
  latest_version: r.latest_version ?? 0,
  labels: r.labels === null || r.labels === "" ? [] : r.labels.split("\n").toSorted(byLowercase),
})

const SELECT_DOC = `SELECT d.id, d.profile_id, d.slug, d.title, d.folder, d.created_at, d.updated_at,
  (SELECT MAX(number) FROM doc_versions v WHERE v.doc_id = d.id) AS latest_version,
  (SELECT COUNT(*) FROM doc_pages p JOIN doc_versions v ON v.id = p.version_id
     WHERE v.doc_id = d.id AND v.number = (SELECT MAX(number) FROM doc_versions WHERE doc_id = d.id)) AS page_count,
  (SELECT group_concat(label, char(10)) FROM doc_labels l WHERE l.doc_id = d.id) AS labels
  FROM docs d`

const SELECT_COMMENT = `SELECT m.id, v.number AS version, m.page_path AS page, m.quote, m.prefix, m.suffix, m.comment, m.created_at, m.updated_at, m.sent_at
  FROM doc_comments m JOIN doc_versions v ON v.id = m.version_id`

const SELECT_ANSWER = `SELECT v.number AS version, a.page_path AS page, a.field, a.value, a.updated_at, a.sent_at
  FROM doc_answers a JOIN doc_versions v ON v.id = a.version_id`

/** What a new comment says: the quote, its context, and the comment. */
export interface CommentText {
  readonly quote: string
  readonly prefix: string
  readonly suffix: string
  readonly comment: string
}

/** A page ready to store. */
export interface NewPage {
  readonly path: string
  readonly title: string
  readonly format: Format
  readonly source: string
  readonly position: number
}

/** An image ready to store: its name in the version, and the AVIF it was converted to. */
export interface NewImage {
  readonly name: string
  readonly sha256: string
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
}

export const makeRepo = (sql: SqlClient.SqlClient) => {
  const selectDoc = sql.literal(SELECT_DOC)
  const selectComment = sql.literal(SELECT_COMMENT)
  const selectAnswer = sql.literal(SELECT_ANSWER)
  const versionCols = sql.literal("SELECT id, number, message, task_id, run_id, created_at FROM doc_versions")
  const comment = (doc: string, id: number) => first(commentRows(sql`${selectComment} WHERE v.doc_id = ${doc} AND m.id = ${id}`))

  return {
    /** A profile's documents, most recently updated first. */
    list: (profile: string) =>
      Effect.map(docRows(sql`${selectDoc} WHERE d.profile_id = ${profile} ORDER BY d.updated_at DESC, d.slug`), (r) => r.map(docOf)),
    get: (profile: string, slug: string) =>
      Effect.map(first(docRows(sql`${selectDoc} WHERE d.profile_id = ${profile} AND d.slug = ${slug}`)), (r) => (r === null ? null : docOf(r))),
    /** A document's versions, newest first. */
    versions: (doc: string) => versionRows(sql`${versionCols} WHERE doc_id = ${doc} ORDER BY number DESC`),
    /** Version `number` of a document, or its latest when `number` is null. */
    version: (doc: string, number: number | null) =>
      first(
        number === null
          ? versionRows(sql`${versionCols} WHERE doc_id = ${doc} ORDER BY number DESC LIMIT 1`)
          : versionRows(sql`${versionCols} WHERE doc_id = ${doc} AND number = ${number}`),
      ),
    /** A version's pages, in menu order, without and with their sources. */
    pages: (version: string) => pageSummaryRows(sql`SELECT path, title, format, position FROM doc_pages WHERE version_id = ${version} ORDER BY position, path`),
    pagesFull: (version: string) =>
      pageRows(sql`SELECT path, title, format, position, source FROM doc_pages WHERE version_id = ${version} ORDER BY position, path`),
    page: (version: string, path: string) =>
      first(pageRows(sql`SELECT path, title, format, position, source FROM doc_pages WHERE version_id = ${version} AND path = ${path}`)),
    insertDoc: (d: { readonly id: string; readonly profile_id: string; readonly slug: string; readonly title: string; readonly folder: string; readonly now: string }) =>
      done(sql`INSERT INTO docs (id, profile_id, slug, title, folder, created_at, updated_at)
        VALUES (${d.id}, ${d.profile_id}, ${d.slug}, ${d.title}, ${d.folder}, ${d.now}, ${d.now})`),
    setTitle: (doc: string, title: string) => done(sql`UPDATE docs SET title = ${title} WHERE id = ${doc}`),
    touch: (doc: string, now: string) => done(sql`UPDATE docs SET updated_at = ${now} WHERE id = ${doc}`),
    insertVersion: (v: {
      readonly id: string
      readonly doc: string
      readonly number: number
      readonly message: string | null
      readonly task_id: string | null
      readonly run_id: string | null
      readonly now: string
    }) =>
      done(sql`INSERT INTO doc_versions (id, doc_id, number, message, task_id, run_id, created_at)
        VALUES (${v.id}, ${v.doc}, ${v.number}, ${v.message}, ${v.task_id}, ${v.run_id}, ${v.now})`),
    insertPage: (version: string, p: NewPage) =>
      done(sql`INSERT INTO doc_pages (version_id, path, title, format, source, position)
        VALUES (${version}, ${p.path}, ${p.title}, ${p.format}, ${p.source}, ${p.position})`),
    pageCount: (version: string) => Effect.map(countRows(sql`SELECT COUNT(*) AS n FROM doc_pages WHERE version_id = ${version}`), (r) => r[0]?.n ?? 0),
    /** The labels of a profile's documents, in the order they were first given. */
    knownLabels: (profile: string) =>
      Effect.map(labelRows(sql`SELECT l.label FROM doc_labels l JOIN docs d ON d.id = l.doc_id WHERE d.profile_id = ${profile} ORDER BY l.rowid`), (r) =>
        r.map((x) => x.label),
      ),
    /** A document's labels from now on (spelt and deduplicated already). */
    replaceLabels: (doc: string, labels: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM doc_labels WHERE doc_id = ${doc}`
        for (const l of labels) yield* sql`INSERT INTO doc_labels (doc_id, label) VALUES (${doc}, ${l})`
      }).pipe(Effect.orDie),
    /** Keeps an AVIF for the profile (once, by its sha256) and gives it a name in a version. */
    addImage: (profile: string, version: string, im: NewImage, now: string) =>
      Effect.gen(function* () {
        yield* sql`INSERT OR IGNORE INTO doc_images (profile_id, sha256, data, width, height, created_at)
          VALUES (${profile}, ${im.sha256}, ${im.data}, ${im.width}, ${im.height}, ${now})`
        yield* sql`INSERT INTO doc_version_images (version_id, name, sha256) VALUES (${version}, ${im.name}, ${im.sha256})`
      }).pipe(Effect.orDie),
    /** Gives a version a name for an AVIF the profile has. */
    nameImage: (version: string, name: string, sha256: string) =>
      done(sql`INSERT INTO doc_version_images (version_id, name, sha256) VALUES (${version}, ${name}, ${sha256})`),
    /** A version's images' names and hashes. */
    imageRefs: (version: string) => imageRefRows(sql`SELECT name, sha256 FROM doc_version_images WHERE version_id = ${version} ORDER BY name`),
    /** A version's images, by name, without their bytes. */
    images: (version: string) =>
      imageRows(sql`SELECT vi.name, vi.sha256, length(i.data) AS bytes, i.width, i.height FROM doc_version_images vi
        JOIN doc_versions v ON v.id = vi.version_id JOIN docs d ON d.id = v.doc_id
        JOIN doc_images i ON i.profile_id = d.profile_id AND i.sha256 = vi.sha256
        WHERE vi.version_id = ${version} ORDER BY vi.name`),
    /** A profile's image's AVIF, by its sha256. */
    imageData: (profile: string, sha256: string) =>
      Effect.map(first(imageDataRows(sql`SELECT data FROM doc_images WHERE profile_id = ${profile} AND sha256 = ${sha256}`)), (r) => r?.data ?? null),
    /** Deletes a document with its versions, and the profile's images no version uses any more. Whether there was one. */
    delete: (profile: string, slug: string) =>
      Effect.gen(function* () {
        const gone = yield* idRows(sql`DELETE FROM docs WHERE profile_id = ${profile} AND slug = ${slug} RETURNING id`)
        if (gone.length === 0) return false
        yield* sql`DELETE FROM doc_images WHERE profile_id = ${profile} AND NOT EXISTS (SELECT 1 FROM doc_version_images vi
          JOIN doc_versions v ON v.id = vi.version_id JOIN docs d ON d.id = v.doc_id
          WHERE vi.sha256 = doc_images.sha256 AND d.profile_id = ${profile})`.pipe(Effect.orDie)
        return true
      }),
    move: (doc: string, folder: string) => done(sql`UPDATE docs SET folder = ${folder} WHERE id = ${doc}`),
    /** A document's comments by version, page, then age: on one version, and made or changed at or after `since`, if given. */
    comments: (doc: string, filter: { readonly version?: number | null; readonly since?: string | null } = {}) => {
      const version = filter.version ?? null
      const since = filter.since ?? null
      return commentRows(
        sql`${selectComment} WHERE v.doc_id = ${doc} AND (${version} IS NULL OR v.number = ${version}) AND (${since} IS NULL OR m.updated_at >= ${since})
          ORDER BY v.number, m.page_path, m.created_at, m.id`,
      )
    },
    comment,
    addComment: (doc: string, version: string, page: string, text: CommentText, now: string) =>
      Effect.gen(function* () {
        const added = yield* idRows(sql`INSERT INTO doc_comments (version_id, page_path, quote, prefix, suffix, comment, created_at, updated_at)
          VALUES (${version}, ${page}, ${text.quote}, ${text.prefix}, ${text.suffix}, ${text.comment}, ${now}, ${now}) RETURNING CAST(id AS TEXT) AS id`)
        const made = yield* comment(doc, Number(added[0]?.id))
        return made ?? (yield* Effect.die(new Error("a comment just added isn't there")))
      }),
    /** Changes what a comment says, which makes it unsent. Null if the document has no such comment. */
    editComment: (doc: string, id: number, text: string, now: string) =>
      Effect.gen(function* () {
        const changed = yield* idRows(sql`UPDATE doc_comments SET comment = ${text}, updated_at = ${now}, sent_at = NULL
          WHERE id = ${id} AND version_id IN (SELECT id FROM doc_versions WHERE doc_id = ${doc}) RETURNING CAST(id AS TEXT) AS id`)
        return changed.length === 0 ? null : yield* comment(doc, id)
      }),
    deleteComment: (doc: string, id: number) =>
      Effect.map(
        idRows(sql`DELETE FROM doc_comments WHERE id = ${id} AND version_id IN (SELECT id FROM doc_versions WHERE doc_id = ${doc}) RETURNING CAST(id AS TEXT) AS id`),
        (r) => r.length > 0,
      ),
    markSent: (ids: ReadonlyArray<number>, at: string) =>
      Effect.forEach(ids, (id) => sql`UPDATE doc_comments SET sent_at = ${at} WHERE id = ${id}`, { concurrency: 1, discard: true }).pipe(Effect.orDie),
    /** A document's answers by version, page and field: on one version, and given or changed at or after `since`, if given. */
    answers: (doc: string, filter: { readonly version?: number | null; readonly since?: string | null } = {}) => {
      const version = filter.version ?? null
      const since = filter.since ?? null
      return answerRows(
        sql`${selectAnswer} WHERE v.doc_id = ${doc} AND (${version} IS NULL OR v.number = ${version}) AND (${since} IS NULL OR a.updated_at >= ${since})
          ORDER BY v.number, a.page_path, a.field`,
      )
    },
    /** The answers on a version's page. */
    pageAnswers: (version: string, page: string) => answerRows(sql`${selectAnswer} WHERE a.version_id = ${version} AND a.page_path = ${page}`),
    /** Keeps an answer (as JSON), unsent. */
    saveAnswer: (version: string, page: string, field: string, value: string, now: string) =>
      done(sql`INSERT INTO doc_answers (version_id, page_path, field, value, updated_at) VALUES (${version}, ${page}, ${field}, ${value}, ${now})
        ON CONFLICT (version_id, page_path, field) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, sent_at = NULL`),
    /** Marks a document's answers sent: those still as they were when they were read to send. */
    markAnswersSent: (doc: string, sent: ReadonlyArray<Answer>, at: string) =>
      Effect.forEach(
        sent,
        (a) => sql`UPDATE doc_answers SET sent_at = ${at} WHERE page_path = ${a.page} AND field = ${a.field} AND value = ${a.value}
          AND version_id = (SELECT id FROM doc_versions WHERE doc_id = ${doc} AND number = ${a.version})`,
        { concurrency: 1, discard: true },
      ).pipe(Effect.orDie),
    /** The versions a task published, newest first, with their documents. */
    publishedBy: (profile: string, task: string) =>
      publishedRows(sql`SELECT d.slug, d.title, v.number, v.created_at FROM doc_versions v JOIN docs d ON d.id = v.doc_id
        WHERE d.profile_id = ${profile} AND v.task_id = ${task} ORDER BY v.created_at DESC, v.number DESC`),
    /** How many documents each profile has. */
    counts: Effect.map(rowsOf(Schema.Struct({ profile_id: Schema.String, n: Schema.Finite }))(sql`SELECT profile_id, COUNT(*) AS n FROM docs GROUP BY profile_id`), (r) =>
      new Map(r.map((x) => [x.profile_id, x.n])),
    ),
  }
}

export type Repo = ReturnType<typeof makeRepo>
