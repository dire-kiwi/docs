import { Effect, Option } from "effect"
import { Page, PluginError } from "@huntaway/plugin"
import type { PageRequest, PageResult, PluginHostShape } from "@huntaway/plugin"
import type { Docs } from "../docs.ts"
import type { Doc, VersionRow } from "../repo.ts"
import type { Hosted } from "../hosted.ts"
import type { RenderLib } from "../render.ts"
import { docPage } from "./doc.ts"
import { homePage } from "./home.ts"
import { docBase, docPath } from "../rules.ts"
import { at, html, json, raw } from "./html.ts"
import type { Raw } from "./html.ts"
import { settingsPanel, taskPanel } from "./small.ts"
import { READER_VARS, STYLES } from "./styles.ts"

// The plugin's pages, at `/docs/<path>` on the board (the paths its built-in documents had):
//
//   ""                                   the first profile's documents (a redirect)
//   <profile>                            a profile's documents by folder
//   <profile>/labels[/<label>]           …by label, or those with one label
//   <profile>/d/<slug>/[<page>]          a document's latest version, at a page; a mockup's page is the design editor,
//                                        with every mockup of the version (and with ?details, the document's page)
//   <profile>/d/<slug>/-/v/<n>/[<page>]  version n
//   <profile>/d/<slug>/-/edit/[<page>]   the editor, on the latest version, open at a page
//   <profile>/new[?folder=<folder>]      the editor, for a new document
//
// and its task panel and Settings section.

/** What the editor opens with (frontend/src/editor.ts's `EditorData`). */
interface EditorData {
  readonly isNew: boolean
  readonly title: string
  readonly folder: string
  readonly baseVersion: number | null
  readonly pages: ReadonlyArray<{ readonly path: string; readonly title: string; readonly format: "md" | "mdx" | "html"; readonly content: string }>
  readonly open: string
  readonly images: ReadonlyArray<string>
  readonly cancelUrl: string
}

export interface Assets {
  /** The renderer's reader styles. */
  readonly readerCss: string
  /** The page script (client/page.ts, bundled). */
  readonly script: string
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

export const makePages = (deps: { readonly docs: Docs; readonly hosted: Hosted; readonly lib: RenderLib; readonly host: PluginHostShape; readonly assets: Assets }) => {
  const { docs, hosted, lib, host, assets } = deps

  const shell = (body: Raw, state: unknown, title: string | null): PageResult =>
    Page.html(
      `<style>${assets.readerCss}\n${READER_VARS}\n${STYLES}</style>\n${body.html}\n<script>window.DOCS=${json(state)}</script>\n<script>${assets.script}</script>`,
      { title: title ?? undefined },
    )

  const withTasks = Effect.fnUntraced(function* (list: Effect.Success<ReturnType<Docs["list"]>>) {
    return yield* Effect.forEach(list, (d) =>
      Effect.gen(function* () {
        const latest = (yield* docs.versions(d))[0]
        return { ...d, task: yield* docs.publisherOf(latest?.task_id ?? null) }
      }),
    )
  })

  const home = Effect.fnUntraced(function* (profile: string, view: "folders" | "labels", label: string | null) {
    const p = yield* docs.profileOf(profile)
    const all = yield* docs.list(p.id, null)
    const data = {
      profile: p,
      profiles: yield* host.profiles,
      view,
      label: label === null || label === "" ? null : label,
      docs: yield* withTasks(all),
      labels: yield* docs.labels(p.id),
      site: yield* hosted.status(p.id),
    }
    return shell(homePage(data), { page: "home", profile: p.id }, `Docs · ${p.name}`)
  })

  /** A mockup's page: the design editor (frontend/src/design/design.ts, built by the page script from the state). */
  const design = Effect.fnUntraced(function* (d: Doc, number: number | null, version: VersionRow, open: { readonly path: string; readonly title: string }) {
    const profile = d.profile_id
    const { mockups, others } = yield* docs.mockups(d, version)
    const all = yield* docs.comments(d)
    const shown = new Set(mockups.map((m) => m.path))
    const latest = version.number === d.latest_version
    const pageUrl = (n: number | null, path: string) => at(docPath(profile, d.slug, n) + lib.urlSuffix(path))
    const data = {
      title: d.title,
      version: version.number,
      latestVersion: d.latest_version,
      open: open.path,
      pages: mockups,
      others: others.map((o) => ({ title: o.title, url: pageUrl(number, o.path) })),
      comments: all.comments
        .filter((c) => c.version === version.number && shown.has(c.page))
        .map((c) => ({ id: c.id, page: c.page, quote: c.quote, anchor: c.anchor, comment: c.comment, user: "You", mine: true, created_at: c.created_at, sent: c.sent_at !== null })),
      // Anyone on the board may change a document; only its latest version takes a new one.
      canEdit: latest,
      canComment: true,
      links: {
        home: at(encodeURIComponent(profile)),
        latest: latest ? null : pageUrl(null, open.path),
        versions: null,
        source: latest ? at(`${docPath(profile, d.slug, null)}-/edit/${lib.urlSuffix(open.path)}`) : null,
        details: `${pageUrl(number, open.path)}?details=1`,
      },
    }
    const state = {
      page: "design",
      profile,
      slug: d.slug,
      version: version.number,
      design: data,
      draft: latest ? yield* docs.draft(profile, d.slug, true) : null,
      task: all.task === null ? null : { id: all.task.id, key: all.task.key, title: all.task.title },
    }
    return shell(html`<div id="design"></div>`, state, `${open.title} · ${d.title}`)
  })

  const doc = Effect.fnUntraced(function* (profile: string, slug: string, number: number | null, path: string, details: boolean) {
    const d = yield* docs.docOf(profile, slug)
    const shown = yield* docs.page(d, number, path)
    if (shown.page.format === "html" && !details) return yield* design(d, number, shown.version, shown.page)
    const versions = yield* Effect.forEach(yield* docs.versions(d), (v) => Effect.map(docs.publisherOf(v.task_id), (task) => ({ ...v, task })))
    const comments = yield* docs.comments(d)
    const data = {
      doc: d,
      number,
      version: shown.version,
      versions,
      nav: shown.nav,
      page: shown.page,
      comments: comments.comments,
      commentsTask: comments.task === null ? null : { id: comments.task.id, key: comments.task.key, title: comments.task.title },
      published: yield* hosted.published(profile, d),
      site: yield* hosted.status(profile),
      urlSuffix: (p: string) => lib.urlSuffix(p),
    }
    const state = {
      page: "doc",
      profile,
      slug: d.slug,
      version: shown.version.number,
      path: shown.page.path,
      unsent: comments.comments.filter((c) => c.sent_at === null).length,
      unsent_answers: yield* docs.unsentAnswers(d),
      task: data.commentsTask,
    }
    return shell(docPage(data), state, `${shown.page.path === "index" ? "" : `${shown.page.title} · `}${d.title}`)
  })

  /** The editor (frontend/src/editor.ts, built by the page script from the state). */
  const editor = (profile: string, title: string, slug: string | null, data: EditorData) =>
    Effect.map(docs.draft(profile, slug), (draft) => shell(html`<div id="editor"></div>`, { page: "edit", profile, slug, editor: data, draft }, title))

  const edit = Effect.fnUntraced(function* (profile: string, slug: string, path: string) {
    const d = yield* docs.docOf(profile, slug)
    const e = yield* docs.editorData(d, path)
    return yield* editor(profile, `Edit · ${d.title}`, d.slug, {
      isNew: false,
      title: d.title,
      folder: d.folder,
      baseVersion: e.version,
      pages: e.pages,
      open: e.open,
      images: e.images,
      cancelUrl: docBase(profile, d.slug, null) + lib.urlSuffix(e.open),
    })
  })

  const create = Effect.fnUntraced(function* (profile: string, folder: string) {
    const p = yield* docs.profileOf(profile)
    return yield* editor(p.id, `New document · ${p.name}`, null, {
      isNew: true,
      title: "",
      folder: Option.getOrElse(Option.liftThrowable(() => lib.normalizeFolder(folder))(), () => ""),
      baseVersion: null,
      pages: [{ path: "index", title: "", format: "md", content: "" }],
      open: "index",
      images: [],
      cancelUrl: at(encodeURIComponent(p.id)),
    })
  })

  const page = Effect.fnUntraced(function* (path: string, query: Readonly<Record<string, string>>) {
    const parts = path.split("/").map(decode)
    const [profile, kind, ...rest] = parts
    if (profile === undefined || profile === "") {
      const first = (yield* host.profiles)[0]
      if (first === undefined) return shell(raw(`<div class="wrap"><p class="muted">No profiles.</p></div>`), {}, "Docs")
      return Page.redirect(encodeURIComponent(first.id))
    }
    if (kind === undefined || kind === "") return yield* home(profile, "folders", null)
    if (kind === "labels") return yield* home(profile, "labels", rest.filter((s) => s !== "").join("/"))
    if (kind === "new") return yield* create(profile, query.folder ?? "")
    if (kind === "d" && rest[0] !== undefined && rest[0] !== "") {
      const slug = rest[0]
      if (rest[1] === "-" && rest[2] === "v") {
        const n = Number(rest[3])
        if (!Number.isInteger(n) || n < 1) return yield* PluginError.notFound(`no version ${rest[3] ?? ""}`)
        return yield* doc(profile, slug, n, rest.slice(4).join("/"), "details" in query)
      }
      if (rest[1] === "-" && rest[2] === "edit") return yield* edit(profile, slug, rest.slice(3).join("/"))
      return yield* doc(profile, slug, null, rest.slice(1).join("/"), "details" in query)
    }
    return yield* PluginError.notFound(`no page ${path}`)
  })

  const task = Effect.fnUntraced(function* (taskId: string | null) {
    const t = taskId === null ? null : yield* host.task(taskId)
    if (t === null) return Page.empty
    const mine = yield* docs.ofTask(t.profile_id, t.id)
    return mine.length === 0 ? Page.empty : shell(taskPanel(t.profile_id, mine), { page: "task" }, null)
  })

  const settings = Effect.gen(function* () {
    const counts = yield* docs.counts
    const rows = yield* Effect.forEach(yield* host.profiles, (profile) =>
      Effect.map(hosted.status(profile.id), (site) => ({ profile, documents: counts.get(profile.id) ?? 0, site })),
    )
    return shell(settingsPanel(rows), { page: "settings" }, null)
  })

  return {
    nav: { title: "Docs" },
    settings: { title: "Docs" },
    task: true,
    render: (request: PageRequest) =>
      request.slot === "task" ? task(request.task_id) : request.slot === "settings" ? settings : page(request.path.replace(/^\/+/, ""), request.query),
  }
}
