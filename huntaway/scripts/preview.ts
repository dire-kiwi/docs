// The plugin's pages outside Huntaway, to work on them: `pnpm preview` (after `pnpm build`), then open
// http://localhost:4100/docs/. It runs the plugin on a database of its own (.preview/plugin.db, or in PREVIEW_DIR) with a pretend board (one
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
/** Where its database and files are kept. */
const DIR = process.env["PREVIEW_DIR"] ?? ".preview"
const profile = { id: "preview", name: "Preview" }
const project = { id: "pr", key: "DOC", name: "docs", profile_id: profile.id, repo_path: process.cwd() }
const task: PluginTask = { id: "task-1", key: "DOC-1", title: "Write the preview", kind: "task", status: "in_progress", profile_id: profile.id, project_id: project.id }

let reloads = 0
const host: PluginHostShape = {
  plugin: "docs",
  hostId: "preview",
  hostName: "preview",
  filesDir: `${DIR}/files`,
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

mkdirSync(DIR, { recursive: true })
const runtime = ManagedRuntime.make(
  Layer.mergeAll(SqliteClient.layer({ filename: `${DIR}/plugin.db` }).pipe(Layer.orDie), NodeFileSystem.layer, NodePath.layer, FetchHttpClient.layer),
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
      {
        path: "plan/phase-1",
        content:
          "# Phase 1\n\nBack to [the overview](../index.md).\n\n```ts\nconst x = 1\n```\n\n" +
          "```mermaid\nflowchart LR\n  A[Agent publishes] --> B{Approved?}\n  B -- yes --> C[Phase 2]\n  B -- no --> A\n```\n",
      },
    ],
  })
}

if (!(listed.structuredContent.documents as Array<{ slug: string }>).some((d) => d.slug === "mockups")) {
  const logo = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="24" fill="#d9480f"/><circle cx="48" cy="48" r="20" fill="#fff"/></svg>`
  const style = `:root { --bg: #fbfaf7; --ink: #1c1b22; --muted: #6b6a75; --accent: #d9480f; --card: #ffffff; --line: #e7e4dc; --radius: 14px; }
  * { box-sizing: border-box; } body { margin: 0; background: var(--bg); color: var(--ink); font: 17px/1.55 system-ui, sans-serif; }
  .cta, button { display: inline-block; padding: 12px 24px; border: 0; border-radius: 999px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; text-decoration: none; }`
  await tool("publish_document", {
    slug: "mockups",
    title: "Mockups",
    message: "Two screens to look at",
    images: [{ name: "images/logo.png", data: (await sharp(Buffer.from(logo)).png().toBuffer()).toString("base64") }],
    pages: [
      { path: "index.md", content: "# Mockups\n\nTwo screens, as HTML pages: open one from the menu to see them in the design editor.\n" },
      {
        path: "screens/home.html",
        content: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Home</title><style>${style}
  header { display: flex; align-items: center; gap: 14px; padding: 18px 48px; border-bottom: 1px solid var(--line); } header img { width: 36px; height: 36px; }
  .hero { padding: 88px 48px 64px; max-width: 900px; } h1 { font: 700 60px/1.05 Georgia, serif; margin: 0 0 18px; } .hero p { font-size: 21px; color: var(--muted); margin: 0 0 28px; }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; padding: 0 48px 88px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 24px; } .card h3 { margin: 0 0 8px; } .card p { margin: 0; color: var(--muted); }
  @media (max-width: 800px) { .hero { padding: 48px 20px; } h1 { font-size: 38px; } .cards { grid-template-columns: 1fr; padding: 0 20px 48px; } header { padding: 14px 20px; } }
</style></head><body>
<header><img src="../images/logo.png" alt=""><strong>Kea Notes</strong></header>
<section class="hero"><h1>Notes that keep up with you</h1><p>Write once, find it anywhere.</p><a class="cta" href="/signup">Start writing free</a></section>
<section class="cards"><div class="card"><h3>Fast capture</h3><p>One key from anywhere.</p></div><div class="card"><h3>Linked thinking</h3><p>Every note links both ways.</p></div><div class="card"><h3>Yours, offline</h3><p>Plain files on your machine.</p></div></section>
</body></html>`,
      },
      {
        path: "screens/sign-in.html",
        content: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in</title><style>${style}
  body { min-height: 100vh; display: grid; place-items: center; } form { width: 340px; display: grid; gap: 14px; padding: 28px; background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); }
  h1 { margin: 0; font: 700 26px Georgia, serif; } label { display: grid; gap: 4px; font-size: 13px; color: var(--muted); } input { font: inherit; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; }
</style></head><body><form><h1>Welcome back</h1><label>Email<input type="email" placeholder="you@example.com"></label><label>Password<input type="password"></label><button>Sign in</button></form></body></html>`,
      },
    ],
  })
}

const session = { kind: "board" as const, device_id: null, scopes: ["read", "operate", "settings"] }
const THEME =
  "color-scheme:dark;--color-bg:#0b0b0e;--color-fg:#e6e6ec;--color-muted:#9a9aab;--color-line-strong:#33333f;--color-panel-2:#16161d;--color-accent:#7c7cf8;--font-sans:ui-sans-serif,system-ui,sans-serif;--font-mono:ui-monospace,monospace"
// The board's policy for a plugin's frame (packages/shared/src/frameCsp.ts's FRAME_CSP, with jsDelivr alone of its CDNs:
// a page with a Mermaid diagram loads Mermaid from there, frontend/src/diagrams.ts), and
// the Trusted Types default policy it makes before the page's scripts: the design editor's frames depend on both.
const FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob: https://cdn.jsdelivr.net; style-src 'unsafe-inline' data:; font-src data:; img-src data: blob:; " +
  "media-src data: blob:; connect-src data: blob:; worker-src data: blob:; frame-src 'none'; form-action 'none'; base-uri 'none'; require-trusted-types-for 'script'"
const TRUSTED = `<script>window.trustedTypes?.createPolicy("default", { createHTML: (s) => s, createScript: (s) => s, createScriptURL: (s) => s })</script>`

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
    const page = await runtime.runPromise(parts.pages!.render({ slot: "page", path, query: Object.fromEntries(url.searchParams), task_id: null, session }))
    if (page._tag === "Redirect") return res.writeHead(302, { location: `/docs/${page.path}` }).end()
    const frame = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">${TRUSTED}<style>:root{${THEME}}html,body{margin:0}</style>${bridge({ host: "preview", plugin: "docs", slot: "page", path, task_id: null })}${page.html}`
    res.setHeader("content-type", "text/html; charset=utf-8")
    res.end(shell(page.title ?? "Docs", frame))
  } catch (e) {
    res.statusCode = 500
    res.end(String(e))
  }
}).listen(PORT, () => console.log(`The docs plugin's pages: ${BOARD}/docs/`))
