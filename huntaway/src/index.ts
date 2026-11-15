import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { Effect, FileSystem, Path } from "effect"
import type { Scope } from "effect"
import { HttpClient } from "effect/http"
import { SqlClient, SqlError } from "effect/sql"
import { definePlugin, PluginHost } from "@huntaway/plugin"
import type { PluginHostShape, PluginParts } from "@huntaway/plugin"
import { makeCalls } from "./calls.ts"
import { makeDocs } from "./docs.ts"
import { DEFAULT_TIMING, makeHosted } from "./hosted.ts"
import type { SiteTiming } from "./hosted.ts"
import { makeImages } from "./images.ts"
import { makePages } from "./pages/index.ts"
import type { Assets } from "./pages/index.ts"
import { loadRenderer } from "./render.ts"
import { makeRepo } from "./repo.ts"
import { migrations } from "./schema.ts"
import { makeSiteRepo } from "./siteRepo.ts"
import { docsTools, INSTRUCTIONS } from "./tools.ts"

// The docs plugin for Huntaway (dire-kiwi/huntaway docs/plan/15-plugins.md): the board's documents, as the docs project
// keeps them. Agents publish reports, plans and research through its `docs` MCP server exactly as they would to the
// hosted site (the same renderer, tools, checks and messages); people read them on its pages at `/docs/…`, comment on
// their text for the agent, and publish them on to a hosted docs site. Its data is in the plugin's own SQLite database
// on each host, copied from the board's built-in documents the first time it runs.

export const VERSION = "0.1.0"

const require = createRequire(import.meta.url)

/** The reader styles and the page script, read once as the plugin starts. */
const loadAssets = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const readerCss = yield* fs.readFileString(require.resolve("@dire-kiwi/docs-render/styles.css"))
  // Next to this module once it's built (dist/), or in dist/ beside src/ when it runs from its sources (tests).
  const here = path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)))
  const candidates = [path.join(here, "client.js"), path.join(here, "..", "dist", "client.js")]
  let script: string | null = null
  for (const c of candidates) {
    if (yield* fs.exists(c)) {
      script = yield* fs.readFileString(c)
      break
    }
  }
  if (script === null) return yield* Effect.die(new Error(`the docs plugin's page script isn't built (looked for ${candidates.join(", ")}): run its build`))
  const assets: Assets = { readerCss, script }
  return assets
})

/** The plugin's parts, from its services (and, for tests, how long it waits for a docs site). */
export const makeParts = (options: { readonly timing?: SiteTiming } = {}): Effect.Effect<
  PluginParts,
  never,
  SqlClient.SqlClient | PluginHost | HttpClient.HttpClient | FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const host: PluginHostShape = yield* PluginHost
    const lib = yield* yield* loadRenderer
    const assets = yield* Effect.orDie(loadAssets)
    const repo = makeRepo(sql)
    const images = yield* makeImages
    const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.catchIf(sql.withTransaction(effect), SqlError.isSqlError, (e) => Effect.die(e)) as Effect.Effect<A, E, R>
    const docs = makeDocs({ repo, images, lib, host, transaction, uuid: Effect.sync(randomUUID) })
    const hosted = yield* makeHosted({ sites: makeSiteRepo(sql), docs: repo, host, timing: options.timing ?? DEFAULT_TIMING })
    return {
      mcp: { tools: docsTools(lib, docs), instructions: INSTRUCTIONS, preApproved: true, maxRequestBytes: 64 * 1024 * 1024 },
      pages: makePages({ docs, hosted, lib, host, assets }),
      calls: makeCalls(docs, hosted),
    }
  })

export default definePlugin({
  id: "docs",
  name: "Docs",
  version: VERSION,
  description: "Documents agents publish for you (reports, plans, research), with versions, folders, labels, images and comments, and publishing to a hosted docs site.",
  migrations,
  make: makeParts(),
})
