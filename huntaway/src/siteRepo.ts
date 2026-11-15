import { Effect, Redacted, Schema } from "effect"
import type { SqlClient } from "effect/sql"

// Hosted docs' tables (schema.ts): each profile's connection to a docs site with its tokens, the OAuth clients this host
// registered with sites, and where its documents went on them. The tokens are read here alone, as `Redacted` values:
// nothing sends them to a page, and nothing logs them. Single statements.

/** A profile's connection to a docs site. `kind` is `oauth` (the device flow's tokens) or `token` (a pasted one). */
export interface SiteConnection {
  readonly profile_id: string
  readonly site_url: string
  readonly kind: "oauth" | "token"
  readonly access_token: Redacted.Redacted
  readonly refresh_token: Redacted.Redacted | null
  /** When the access token expires, in milliseconds since the epoch (null: it doesn't, or isn't known to). */
  readonly expires_at: number | null
  /** The docs site's username, once it's known. */
  readonly login: string | null
  readonly connected_at: string
}

const ConnectionRow = Schema.Struct({
  profile_id: Schema.String,
  site_url: Schema.String,
  kind: Schema.Literals(["oauth", "token"]),
  access_token: Schema.String,
  refresh_token: Schema.NullOr(Schema.String),
  expires_at: Schema.NullOr(Schema.Finite),
  login: Schema.NullOr(Schema.String),
  connected_at: Schema.String,
})

export const PublishedRow = Schema.Struct({
  site_url: Schema.String,
  remote_slug: Schema.String,
  remote_version: Schema.Int,
  local_version: Schema.Int,
  url: Schema.String,
  version_url: Schema.String,
  login: Schema.NullOr(Schema.String),
  published_at: Schema.String,
})
/** Where a document went on a site, and which of its versions it was. */
export type Published = typeof PublishedRow.Type

const decode =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  <E, R>(statement: Effect.Effect<ReadonlyArray<unknown>, E, R>) =>
    statement.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(schema))), Effect.orDie)
const first = <A, R>(found: Effect.Effect<ReadonlyArray<A>, never, R>) => Effect.map(found, (list) => list[0] ?? null)
const redacted = (s: string | null) => (s === null ? null : Redacted.make(s))
const reveal = (s: Redacted.Redacted | null) => (s === null ? null : Redacted.value(s))

const connectionRows = decode(ConnectionRow)
const publishedRows = decode(PublishedRow)
const clientRows = decode(Schema.Struct({ client_id: Schema.String }))
const changedRows = decode(Schema.Struct({ profile_id: Schema.String }))

export const makeSiteRepo = (sql: SqlClient.SqlClient) => ({
  client: (site: string) => Effect.map(first(clientRows(sql`SELECT client_id FROM docs_site_clients WHERE site_url = ${site}`)), (r) => r?.client_id ?? null),
  setClient: (site: string, client: string, now: string) =>
    sql`INSERT INTO docs_site_clients (site_url, client_id, created_at) VALUES (${site}, ${client}, ${now})
      ON CONFLICT(site_url) DO UPDATE SET client_id = excluded.client_id, created_at = excluded.created_at`.pipe(Effect.asVoid, Effect.orDie),
  connection: (profile: string) =>
    Effect.map(first(connectionRows(sql`SELECT * FROM docs_site_connections WHERE profile_id = ${profile}`)), (r): SiteConnection | null =>
      r === null ? null : { ...r, access_token: Redacted.make(r.access_token), refresh_token: redacted(r.refresh_token) },
    ),
  /** Connects the profile (replacing any connection it had). */
  connect: (c: Omit<SiteConnection, "connected_at">, now: string) =>
    sql`INSERT INTO docs_site_connections (profile_id, site_url, kind, access_token, refresh_token, expires_at, login, connected_at)
      VALUES (${c.profile_id}, ${c.site_url}, ${c.kind}, ${Redacted.value(c.access_token)}, ${reveal(c.refresh_token)}, ${c.expires_at}, ${c.login}, ${now})
      ON CONFLICT(profile_id) DO UPDATE SET site_url = excluded.site_url, kind = excluded.kind, access_token = excluded.access_token,
        refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, login = excluded.login, connected_at = excluded.connected_at`.pipe(
      Effect.asVoid,
      Effect.orDie,
    ),
  /** Saves refreshed tokens, if the connection still has the refresh token they replace (the site rotates them). Whether it did. */
  refreshed: (
    profile: string,
    used: Redacted.Redacted,
    t: { readonly access: Redacted.Redacted; readonly refresh: Redacted.Redacted | null; readonly expires_at: number | null },
  ) =>
    Effect.map(
      changedRows(sql`UPDATE docs_site_connections SET access_token = ${Redacted.value(t.access)}, refresh_token = ${reveal(t.refresh)}, expires_at = ${t.expires_at}
        WHERE profile_id = ${profile} AND refresh_token = ${Redacted.value(used)} RETURNING profile_id`),
      (r) => r.length > 0,
    ),
  /** Records the site's username, if the connection still has this access token. */
  setLogin: (profile: string, access: Redacted.Redacted, login: string) =>
    sql`UPDATE docs_site_connections SET login = ${login} WHERE profile_id = ${profile} AND access_token = ${Redacted.value(access)}`.pipe(
      Effect.asVoid,
      Effect.orDie,
    ),
  /** Forgets the profile's connection (with `access`, only if it's still the one with that token). Whether it had one. */
  disconnect: (profile: string, access?: Redacted.Redacted) =>
    Effect.map(
      changedRows(
        access === undefined
          ? sql`DELETE FROM docs_site_connections WHERE profile_id = ${profile} RETURNING profile_id`
          : sql`DELETE FROM docs_site_connections WHERE profile_id = ${profile} AND access_token = ${Redacted.value(access)} RETURNING profile_id`,
      ),
      (r) => r.length > 0,
    ),
  published: (doc: string, site: string) =>
    first(
      publishedRows(sql`SELECT site_url, remote_slug, remote_version, local_version, url, version_url, login, published_at
        FROM docs_site_published WHERE doc_id = ${doc} AND site_url = ${site}`),
    ),
  setPublished: (doc: string, p: Omit<Published, "published_at">, now: string) =>
    sql`INSERT INTO docs_site_published (doc_id, site_url, remote_slug, remote_version, local_version, url, version_url, login, published_at)
      VALUES (${doc}, ${p.site_url}, ${p.remote_slug}, ${p.remote_version}, ${p.local_version}, ${p.url}, ${p.version_url}, ${p.login}, ${now})
      ON CONFLICT(doc_id, site_url) DO UPDATE SET remote_slug = excluded.remote_slug, remote_version = excluded.remote_version,
        local_version = excluded.local_version, url = excluded.url, version_url = excluded.version_url, login = excluded.login,
        published_at = excluded.published_at`.pipe(Effect.asVoid, Effect.orDie),
})

export type SiteRepo = ReturnType<typeof makeSiteRepo>
