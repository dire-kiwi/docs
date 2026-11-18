// The plugin's pages outside Huntaway, to work on them: `pnpm preview` (after `pnpm build`), then open
// http://localhost:4100/docs/. It runs the plugin on a database of its own (.preview/plugin.db) with a pretend board (one
// profile, one project, one task) and shows each page as the board does: in a sandboxed frame with no network under a
// strict policy, with the board's theme as CSS variables and `window.huntaway` as the bridge (calls go to the plugin
// here). Messages the plugin sends to the task (comments and answers) are printed. The first run publishes a sample document.
import { mkdirSync } from "node:fs"
import { createServer } from "node:http"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer, ManagedRuntime, Option, Scope } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import sharp from "sharp"
import { PluginError, PluginHost, PluginImport } from "@huntaway/plugin"
import type { CallContext, PluginHostShape, PluginTask } from "@huntaway/plugin"
import plugin, { makeParts } from "../src/index.ts"

const PORT = Number(process.env["PORT"] ?? 4100)
const BOARD = `http://localhost:${PORT}`
const profile = { id: "preview", name: "Preview" }
const project = { id: "pr", key: "DOC", name: "docs", profile_id: profile.id, repo_path: process.cwd() }
const task: PluginTask = { id: "task-1", key: "DOC-1", title: "Write the preview", kind: "task", status: "in_progress", profile_id: profile.id, project_id: project.id }

let reloads = 0
const host: PluginHostShape = {
  plugin: "docs",
  hostId: "preview",
  hostName: "preview",
  filesDir: ".preview/files",
  boardUrl: Effect.succeed(BOARD),
  pageUrl: (path) => Effect.succeed(`${BOARD}/docs/${path}`),
  profiles: Effect.succeed([profile]),
  profile: (id) => Effect.succeed(id === profile.id ? profile : null),
  task: (ref) => Effect.succeed(ref === task.id || ref === task.key ? task : null),
  project: (id) => Effect.succeed(id === project.id ? project : null),
  sendToTask: (to, text) => (to === task.id ? Effect.sync(() => console.log(`\n--- to ${task.key} ---\n${text}\n`)) : Effect.fail(PluginError.notFound(`task ${to} is gone`))),
  emit: (e) => Effect.sync(() => void (e.reload === true && reloads++)),
  secrets: { get: () => Effect.succeed(Option.none()), set: () => Effect.void, remove: () => Effect.void },
}

mkdirSync(".preview", { recursive: true })
const runtime = ManagedRuntime.make(
  Layer.mergeAll(SqliteClient.layer({ filename: ".preview/plugin.db" }).pipe(Layer.orDie), NodeFileSystem.layer, NodePath.layer, FetchHttpClient.layer),
)

const parts = await runtime.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY)`
    const done = new Set((yield* sql<{ readonly name: string }>`SELECT name FROM migrations`).map((r) => r.name))
    for (const m of plugin.migrations ?? []) {
      if (done.has(m.name)) continue
      yield* m.run.pipe(Effect.provideService(PluginImport, { tables: [], rows: () => Effect.succeed([]) }))
      yield* sql`INSERT INTO migrations (name) VALUES (${m.name})`
    }
    // The plugin's background work (a hosted sign-in's polling) lasts as long as the server, as on the board.
    return yield* makeParts().pipe(Effect.provideService(PluginHost, host), Effect.provideService(Scope.Scope, yield* Scope.make()))
  }).pipe(Effect.orDie),
)

const call: CallContext = { run_id: "run-1", call_id: "call-1", task, project, profile, review: false }
const tool = (name: string, args: Record<string, unknown>) => runtime.runPromise(parts.mcp!.tools.find((t) => t.tool.name === name)!.run(args, call))
const listed = (await tool("list_documents", {})) as { structuredContent: { documents: Array<unknown> } }
if (listed.structuredContent.documents.length === 0) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="160"><rect width="480" height="160" rx="12" fill="#7c7cf8"/><text x="240" y="95" font-size="40" text-anchor="middle" fill="#fff" font-family="sans-serif">A chart</text></svg>`
  const chart = (await sharp(Buffer.from(svg)).png().toBuffer()).toString("base64")
  await tool("publish_document", {
    images: [{ name: "images/chart.png", data: chart }],
    title: "Preview",
    message: "A sample to look at",
    labels: ["samples"],
    pages: [
      {
        path: "index.mdx",
        content:
          "# Preview\n\nSelect some of this text and comment on it: the comment is saved when you click away, and shows beside the text.\n\n" +
          '<Callout type="tip">Pages render with the hosted site\'s renderer.</Callout>\n\n![A chart](images/chart.png)\n\n## A table\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nSee [the plan](plan/phase-1.md).\n\n' +
          "## Questions\n\nAnswers save as you give them; **Send** puts them in a message to the task.\n\n" +
          '<RadioGroup name="database" label="Which database?" options={["SQLite", "Postgres"]} other />\n\n' +
          '<CheckboxGroup name="phases" label="Which phases should go ahead?" options={["Phase 1", "Phase 2", "Phase 3"]} other="Something else" />\n\n' +
          '<Select name="region" label="Deploy region" options={["us-east", "eu-west", "ap-southeast"]} other="Somewhere else" />\n\n' +
          '<TextInput name="owner" label="Who should own this work?" placeholder="GitHub username" />\n\n<Approval />\n',
      },
      { path: "plan/phase-1", content: "# Phase 1\n\nBack to [the overview](../index.md).\n\n```ts\nconst x = 1\n```\n" },
    ],
  })
}

const session = { kind: "board" as const, device_id: null, scopes: ["read", "operate", "settings"] }
const THEME =
  "color-scheme:dark;--color-bg:#0b0b0e;--color-fg:#e6e6ec;--color-muted:#9a9aab;--color-line-strong:#33333f;--color-panel-2:#16161d;--color-accent:#7c7cf8;--font-sans:ui-sans-serif,system-ui,sans-serif;--font-mono:ui-monospace,monospace"
const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:"

/** The bridge in the frame, as the board's (apps/web/src/components/plugins/frameSource.ts), and links asking the page to follow them. */
const bridge = (context: unknown) => `<script>(() => {
  const waiting = new Map(); let next = 0; const listeners = []
  const post = (m) => parent.postMessage({ iaPlugin: m }, "*")
  window.huntaway = { context: ${JSON.stringify(context)},
    call(method, payload) { const id = ++next; return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); post({ kind: "call", id, method, payload: payload ?? null }) }) },
    navigate(path) { post({ kind: "navigate", path }) }, openTask(id) { post({ kind: "openTask", id }) }, onEvent(l) { listeners.push(l) } }
  addEventListener("message", (e) => { const r = e.data && e.data.iaPluginReply; if (r) { const w = waiting.get(r.id); waiting.delete(r.id); if (w) r.ok ? w.resolve(r.value) : w.reject(new Error(String(r.error))) } })
  addEventListener("click", (e) => { if (e.defaultPrevented) return; const a = e.target instanceof Element ? e.target.closest("a[href]") : null; const href = a ? a.getAttribute("href") : ""
    if (!a || !href || href.startsWith("#")) return; e.preventDefault(); post({ kind: "navigate", path: href }) })
})()</script>`

const shell = (title: string, frame: string) => `<!doctype html><meta charset="utf-8"><title>${title.replace(/</g, "&lt;")}</title>
<style>html,body{margin:0;height:100%;background:#0b0b0e}iframe{border:0;width:100%;height:100%;display:block}</style>
<iframe sandbox="allow-scripts" srcdoc="${frame.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe>
<script>
const frame = document.querySelector("iframe")
addEventListener("message", async (e) => {
  const m = e.data && e.data.iaPlugin
  if (!m || e.source !== frame.contentWindow) return
  if (m.kind === "navigate") { const u = new URL(m.path, location.href); if (u.origin === location.origin) location.href = u.href; else open(u.href, "_blank", "noopener") }
  if (m.kind === "openTask") alert("Task " + m.id)
  if (m.kind === "call") {
    const res = await fetch("/call", { method: "POST", body: JSON.stringify({ method: m.method, payload: m.payload }) })
    const out = await res.json()
    frame.contentWindow.postMessage({ iaPluginReply: { id: m.id, ok: res.ok, value: out.value, error: out.error } }, "*")
    if (out.reload) location.reload()
  }
})
</script>`

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", BOARD)
  try {
    if (req.method === "POST" && url.pathname === "/call") {
      let body = ""
      for await (const chunk of req) body += chunk
      const { method, payload } = JSON.parse(body)
      const before = reloads
      const exit = await runtime.runPromiseExit(parts.calls![method]!.run(payload, session))
      res.setHeader("content-type", "application/json")
      if (exit._tag === "Success") return res.end(JSON.stringify({ value: exit.value, reload: reloads > before }))
      res.statusCode = 400
      return res.end(JSON.stringify({ error: String((exit.cause as any).reasons?.[0]?.error?.message ?? exit.cause) }))
    }
    if (!url.pathname.startsWith("/docs")) return res.writeHead(302, { location: "/docs/" }).end()
    const path = url.pathname.replace(/^\/docs\/?/, "")
    const page = await runtime.runPromise(parts.pages!.render({ slot: "page", path, query: {}, task_id: null, session }))
    if (page._tag === "Redirect") return res.writeHead(302, { location: `/docs/${page.path}` }).end()
    const frame = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><style>:root{${THEME}}html,body{margin:0}</style>${bridge({ host: "preview", plugin: "docs", slot: "page", path, task_id: null })}${page.html}`
    res.setHeader("content-type", "text/html; charset=utf-8")
    res.end(shell(page.title ?? "Docs", frame))
  } catch (e) {
    res.statusCode = 500
    res.end(String(e))
  }
}).listen(PORT, () => console.log(`The docs plugin's pages: ${BOARD}/docs/`))
