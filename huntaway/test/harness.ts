import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientResponse, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { HttpClientRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { PluginError, PluginHost, PluginImport } from "@huntaway/plugin"
import type { CallContext, PluginEvent, PluginHostShape, PluginParts, PluginProfile, PluginProject, PluginSession, PluginTask } from "@huntaway/plugin"
import plugin, { makeParts } from "../src/index.ts"

// The plugin on a pretend board: an in-memory database brought up to date with its migrations (copying `board`'s
// tables, as a board that had built-in documents gives them), a `PluginHost` with one profile, a project and two tasks
// that records what it's told, and an HTTP client that answers as `site` says (a pretend docs site).

export const PROFILE: PluginProfile = { id: "p1", name: "Ivan" }
export const PROJECT: PluginProject = { id: "pr1", key: "DOC", name: "Docs", profile_id: "p1", repo_path: "/repo" }
export const TASK: PluginTask = { id: "t1", key: "DOC-1", title: "Write the plan", kind: "task", status: "in_progress", profile_id: "p1", project_id: "pr1" }
export const OTHER: PluginTask = { ...TASK, id: "t2", key: "DOC-2", title: "Something else" }
export const BOARD = "http://board.test"

export const call = (task: PluginTask = TASK, n = 1): CallContext => ({
  run_id: `run-${task.id}`,
  task,
  project: PROJECT,
  profile: PROFILE,
  review: false,
  call_id: `call-${n}`,
})

export const session: PluginSession = { kind: "board", device_id: null, scopes: ["read", "operate", "settings"] }

/** A request to the pretend site: its method, URL, headers and body as text. */
export interface SiteRequest {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}
export type Site = (r: SiteRequest) => Response

const bodyText = (r: HttpClientRequest.HttpClientRequest): string => {
  const b = r.body
  return b._tag === "Uint8Array" ? new TextDecoder().decode(b.body) : ""
}

export interface Harness {
  readonly parts: PluginParts
  readonly sql: SqlClient.SqlClient
  readonly events: Array<PluginEvent>
  readonly sent: Array<{ readonly task: string; readonly text: string }>
  readonly requests: Array<SiteRequest>
  /** A tool's answer, as the board gets it. */
  readonly tool: (name: string, args: Readonly<Record<string, unknown>>, ctx?: CallContext) => Effect.Effect<{ readonly text: string; readonly json: any; readonly isError: boolean }>
  /** A tool's JSON answer, or the test fails. */
  readonly ok: (name: string, args: Readonly<Record<string, unknown>>, ctx?: CallContext) => Effect.Effect<any>
  /** A tool's error, or the test fails. */
  readonly refused: (name: string, args: Readonly<Record<string, unknown>>) => Effect.Effect<string>
  readonly page: (path: string, query?: Readonly<Record<string, string>>) => Effect.Effect<any, PluginError>
  readonly task: (id: string) => Effect.Effect<any, PluginError>
  readonly settings: Effect.Effect<any, PluginError>
  readonly call: (method: string, payload: unknown) => Effect.Effect<any, PluginError>
  /** A request to one of the plugin's routes, as the board passes it on (`url` as `create_upload_url` gives it): its status and JSON answer. */
  readonly route: (method: "POST" | "PUT", url: string, body: Uint8Array | string, headers?: Readonly<Record<string, string>>) => Effect.Effect<{ readonly status: number; readonly json: any }>
}

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

export const harness = (options: { readonly board?: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>; readonly site?: Site } = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`PRAGMA foreign_keys = ON`
    const board = options.board ?? {}
    const importer = PluginImport.of({
      tables: Object.keys(board),
      rows: (table) => (table in board ? Effect.succeed(board[table] ?? []) : Effect.fail(PluginError.notFound(table))),
    })
    for (const m of plugin.migrations ?? []) yield* m.run.pipe(Effect.provideService(PluginImport, importer), Effect.orDie)

    const events: Array<PluginEvent> = []
    const sent: Array<{ readonly task: string; readonly text: string }> = []
    const requests: Array<SiteRequest> = []
    const tasks = [TASK, OTHER]
    const secrets = new Map<string, string>()
    const host: PluginHostShape = {
      plugin: "docs",
      hostId: "h1",
      hostName: "testhost",
      filesDir: "/nonexistent",
      boardUrl: Effect.succeed(BOARD),
      pageUrl: (path) => Effect.succeed(`${BOARD}/docs/${path}`),
      profiles: Effect.succeed([PROFILE]),
      profile: (id) => Effect.succeed(id === PROFILE.id ? PROFILE : null),
      task: (ref) => Effect.succeed(tasks.find((t) => t.id === ref || t.key === ref) ?? null),
      project: (id) => Effect.succeed(id === PROJECT.id ? PROJECT : null),
      sendToTask: (task, text) =>
        tasks.some((t) => t.id === task) ? Effect.sync(() => void sent.push({ task, text })) : Effect.fail(PluginError.notFound(`task ${task} is gone`)),
      emit: (event) => Effect.sync(() => void events.push(event)),
      secrets: {
        get: (p, name) => Effect.sync(() => Option.map(Option.fromNullishOr(secrets.get(`${p}:${name}`)), (v) => Redacted.make(v))),
        set: (p, name, value) => Effect.sync(() => void secrets.set(`${p}:${name}`, Redacted.isRedacted(value) ? Redacted.value(value) : value)),
        remove: (p, name) => Effect.sync(() => void secrets.delete(`${p}:${name}`)),
      },
    }
    const site = options.site ?? (() => new Response("no site here", { status: 404 }))
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        const r: SiteRequest = { method: request.method, url: request.url, headers: request.headers, body: bodyText(request) }
        requests.push(r)
        return HttpClientResponse.fromWeb(request, site(r))
      }),
    )
    const parts = yield* makeParts({ timing: { request: 5, slowDown: 0.01, interval: 0.01 } }).pipe(
      Effect.provideService(PluginHost, host),
      Effect.provideService(HttpClient.HttpClient, client),
    )

    const tool: Harness["tool"] = (name, args, ctx = call()) =>
      Effect.gen(function* () {
        const t = parts.mcp?.tools.find((x) => x.tool.name === name)
        if (t === undefined) return yield* Effect.die(new Error(`no tool ${name}`))
        const out = (yield* Effect.orDie(t.run(args, ctx))) as { content: Array<{ text: string }>; isError?: boolean }
        const text = out.content.map((c) => c.text).join("")
        return { text, isError: out.isError === true, json: out.isError === true ? null : (() => { try { return decodeJson(text) } catch { return text } })() }
      })
    const h: Harness = {
      parts,
      sql,
      events,
      sent,
      requests,
      tool,
      ok: (name, args, ctx) => Effect.flatMap(tool(name, args, ctx), (r) => (r.isError ? Effect.die(new Error(`${name} failed: ${r.text}`)) : Effect.succeed(r.json))),
      refused: (name, args) => Effect.flatMap(tool(name, args), (r) => (r.isError ? Effect.succeed(r.text) : Effect.die(new Error(`${name} succeeded: ${r.text}`)))),
      page: (path, query = {}) => parts.pages!.render({ slot: "page", path, query, task_id: null, session }),
      task: (id) => parts.pages!.render({ slot: "task", path: "", query: {}, task_id: id, session }),
      settings: parts.pages!.render({ slot: "settings", path: "", query: {}, task_id: null, session }),
      call: (method, payload) => {
        const c = parts.calls?.[method]
        return c === undefined ? Effect.die(new Error(`no call ${method}`)) : c.run(payload, session)
      },
      route: (method, url, body, headers = {}) =>
        Effect.gen(function* () {
          // The plugin's routes are `/plugins/docs<path>`, with `:name` segments.
          const path = new URL(url).pathname.replace(/^\/plugins\/docs/, "").split("/")
          for (const r of parts.routes ?? []) {
            const pattern = r.path.split("/")
            if (r.method !== method || pattern.length !== path.length) continue
            const params: Record<string, string> = {}
            if (!pattern.every((seg, i) => (seg.startsWith(":") ? ((params[seg.slice(1)] = path[i] ?? ""), true) : seg === path[i]))) continue
            const request = HttpServerRequest.fromWeb(new Request(url, { method, body: typeof body === "string" ? body : new Uint8Array(body), headers }))
            const response = yield* r.handle(request).pipe(
              Effect.provideService(HttpRouter.RouteContext, { params, route: undefined as never }),
              Effect.provideService(HttpServerRequest.ParsedSearchParams, {}),
            )
            const web = HttpServerResponse.toWeb(response)
            return { status: web.status, json: yield* Effect.promise(() => web.json()) }
          }
          return yield* Effect.die(new Error(`no route ${method} ${url}`))
        }),
    }
    return h
  })

/** The layers a harness runs on. */
export const TestLayer = Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }).pipe(Layer.orDie), NodeFileSystem.layer, NodePath.layer)

export const withHarness = <A, E>(
  options: Parameters<typeof harness>[0],
  f: (h: Harness) => Effect.Effect<A, E>,
) => Effect.flatMap(harness(options), f).pipe(Effect.scoped, Effect.provide(TestLayer))
