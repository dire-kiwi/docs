import { Clock, DateTime, Effect, Option, Result, Schema } from "effect"
import { PluginError } from "@huntaway/plugin"
import type { PluginHostShape } from "@huntaway/plugin"
import type { Images } from "./images.ts"
import type { Doc, Repo, VersionRow } from "./repo.ts"
import { renderMessage, rendered } from "./render.ts"
import type { RenderLib } from "./render.ts"
import { chars, commentsMessage, docBase, labelTree, quoted, renamedFolders, spelt } from "./rules.ts"
import { nowIso, publishFor } from "./publish.ts"
import type { Caller, PublishInput } from "./publish.ts"

// Each profile's documents (the board's built-in documents, moved into this plugin): agents publish them through the
// `docs` MCP server as they would to the hosted site, and people read them on the plugin's pages. A document has
// immutable versions, each with its pages (Markdown or MDX), and every publish makes a new one. Slugs are unique per
// profile. A document is filed in a folder when it's created (a '/'-path, "" the top level), has labels ('/'-nested,
// matched whatever their case, spelt as first used in the profile), images (AVIFs kept once per profile), and comments
// the user leaves on a version's pages for the agent. What an agent is told when it can't is a `DocsRefused`, in the
// hosted server's words; what a page is told is a `PluginError`.

/** A refusal an agent is told in the docs server's words (the hosted server's, where it has one). */
export class DocsRefused extends Schema.TaggedError<DocsRefused>()("DocsRefused", { message: Schema.String }) {}

/** The longest quote, comment, and quote's context either side a comment may have, in characters. */
export const MAX_QUOTE_CHARS = 10_000
export const MAX_COMMENT_CHARS = 20_000
export const MAX_CONTEXT_CHARS = 500

/** A version as the docs server's tools show it. */
const versionJson = (v: VersionRow) => ({ number: v.number, message: v.message, task_id: v.task_id, created_at: v.created_at })

/** A task as documents name it. */
export interface Publisher {
  readonly id: string
  readonly key: string
  readonly title: string
}

/** A page of a version, rendered for the board. */
export interface RenderedPage {
  readonly path: string
  readonly title: string
  readonly format: "md" | "mdx"
  readonly html: string | null
  readonly toc: ReadonlyArray<{ readonly depth: number; readonly id: string; readonly text: string }>
  readonly has_h1: boolean
  readonly warnings: ReadonlyArray<string>
  readonly error: string | null
}

export interface NewComment {
  readonly version: number
  readonly page: string
  readonly quote: string
  readonly prefix?: string | undefined
  readonly suffix?: string | undefined
  readonly comment?: string | undefined
}

export interface DocsDeps {
  readonly repo: Repo
  readonly images: Images
  readonly lib: RenderLib
  readonly host: PluginHostShape
  readonly transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly uuid: Effect.Effect<string>
}

/** Text from a request, checked. */
const text = (v: string | undefined, name: string, max: number, required = false) => {
  const s = v ?? ""
  if (required && s.trim() === "") return Effect.fail(PluginError.invalid(`${name} is required`))
  if (chars(s) > max) return Effect.fail(PluginError.invalid(`${name} is longer than ${max} characters`))
  return Effect.succeed(s)
}

const toBase64 = (bytes: Uint8Array): string => {
  let s = ""
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export const makeDocs = (deps: DocsDeps) => {
  const { repo, lib, host } = deps
  const tx = deps.transaction

  const docsChanged = (profile: string, slug: string, deleted = false) =>
    host.emit({ topic: "documents", profile_id: profile, data: { slug, deleted }, reload: true })
  const commentsChanged = (d: Doc) => host.emit({ topic: "comments", profile_id: d.profile_id, data: { slug: d.slug } })

  const url = (profile: string) => (board: string) => (slug: string, number: number | null, path: string) =>
    `${board}${docBase(profile, slug, number)}${lib.urlSuffix(path)}`
  const urls = (profile: string) => Effect.map(host.boardUrl, url(profile))

  const profileOf = Effect.fnUntraced(function* (profile: string) {
    const p = yield* host.profile(profile)
    if (p === null) return yield* PluginError.notFound(`no profile ${profile}`)
    return p
  })
  const docOf = Effect.fnUntraced(function* (profile: string, slug: string) {
    yield* profileOf(profile)
    const d = yield* repo.get(profile, slug)
    if (d === null) return yield* PluginError.notFound(`no document ${quoted(slug)}`)
    return d
  })

  const publisherOf = Effect.fnUntraced(function* (taskId: string | null) {
    const t = taskId === null ? null : yield* host.task(taskId)
    const out: Publisher | null = t === null ? null : { id: t.id, key: t.key, title: t.title }
    return out
  })

  const folderOf = (raw: string) => Effect.mapError(rendered(() => lib.normalizeFolder(raw)), (e) => PluginError.invalid(e.message))
  const labelsOf = (raw: ReadonlyArray<string>) => Effect.mapError(rendered(() => lib.normalizeLabels([...raw])), (e) => PluginError.invalid(e.message))

  /** The task a document's comments go to: the newest version's publisher that's still on the board. */
  const commentsTask = Effect.fnUntraced(function* (d: Doc) {
    for (const v of yield* repo.versions(d.id)) {
      const t = v.task_id === null ? null : yield* host.task(v.task_id)
      if (t !== null) return t
    }
    return null
  })

  const forAgent = Effect.fnUntraced(function* (caller: Caller, slug: string) {
    const d = yield* repo.get(caller.profile, slug)
    if (d === null) return yield* new DocsRefused({ message: `no document ${quoted(slug)}; call list_documents to see what exists` })
    return d
  })
  const versionForAgent = Effect.fnUntraced(function* (d: Doc, number: number | null) {
    const v = yield* repo.version(d.id, number)
    if (v === null) return yield* new DocsRefused({ message: `document ${quoted(d.slug)} has no version ${number ?? 0}` })
    return v
  })
  const refused = (e: { readonly message: string }) => new DocsRefused({ message: e.message })

  return {
    // ---- for the plugin's pages and calls --------------------------------------------------------------------------

    profileOf,
    docOf,
    publisherOf,
    list: Effect.fn("Docs.list")(function* (profile: string, label: string | null) {
      yield* profileOf(profile)
      const wanted = label === null || label.trim() === "" ? null : ((yield* labelsOf([label]))[0] ?? null)
      const all = yield* repo.list(profile)
      return wanted === null ? all : all.filter((d) => d.labels.some((l) => lib.labelMatches(l, wanted)))
    }),
    labels: Effect.fn("Docs.labels")(function* (profile: string) {
      yield* profileOf(profile)
      return labelTree(lib, yield* repo.list(profile))
    }),
    versions: (d: Doc) => repo.versions(d.id),
    /** Moves it, relabels it, or both. */
    update: Effect.fn("Docs.update")(function* (
      profile: string,
      slug: string,
      patch: { readonly folder?: string | undefined; readonly labels?: ReadonlyArray<string> | undefined },
    ) {
      const d = yield* docOf(profile, slug)
      if (patch.folder === undefined && patch.labels === undefined) return yield* PluginError.invalid("give a folder or labels")
      const to = patch.folder === undefined ? null : yield* folderOf(patch.folder)
      const labels = patch.labels === undefined ? null : yield* labelsOf(patch.labels)
      yield* tx(
        Effect.gen(function* () {
          if (to !== null) yield* repo.move(d.id, to)
          if (labels !== null) yield* repo.replaceLabels(d.id, spelt(lib, yield* repo.knownLabels(profile), labels))
        }),
      )
      yield* docsChanged(profile, d.slug)
      return yield* docOf(profile, slug)
    }),
    /** Deletes it with its versions, and the images nothing uses any more. */
    delete: Effect.fn("Docs.delete")(function* (profile: string, slug: string) {
      yield* profileOf(profile)
      const gone = yield* tx(repo.delete(profile, slug))
      if (!gone) return yield* PluginError.notFound(`no document ${quoted(slug)}`)
      yield* docsChanged(profile, slug, true)
    }),
    /** Renames (or moves) a folder: every document in it or in one inside it. */
    renameFolder: Effect.fn("Docs.renameFolder")(function* (profile: string, rawFrom: string, rawTo: string) {
      yield* profileOf(profile)
      const from = yield* folderOf(rawFrom)
      const to = yield* folderOf(rawTo)
      const moved = yield* tx(
        Effect.gen(function* () {
          const out = renamedFolders(yield* repo.list(profile), from, to)
          if ("error" in out) return yield* PluginError.invalid(out.error)
          for (const m of out.moved) yield* repo.move(m.doc.id, m.folder)
          return out.moved.map((m) => m.doc.slug)
        }),
      )
      for (const slug of moved) yield* docsChanged(profile, slug)
      return { moved }
    }),
    /**
     * A version's menu and one of its pages (`path`, else its first), rendered, its images as `data:` URLs (the board
     * shows plugin pages in a frame that reaches no network).
     */
    page: Effect.fn("Docs.page")(function* (d: Doc, number: number | null, rawPath: string) {
      const v = yield* repo.version(d.id, number)
      if (v === null) return yield* PluginError.notFound(`document ${quoted(d.slug)} has no version ${number ?? 0}`)
      const pages = yield* repo.pagesFull(v.id)
      const nav = lib.navTree(pages.map((p) => [p.path, p.title]))
      const path = rawPath === "" ? "index" : yield* Effect.mapError(rendered(() => lib.normalizePath(rawPath)), (e) => PluginError.invalid(e.message))
      const p = pages.find((x) => x.path === path) ?? pages.find((x) => x.path === `${path}/index`) ?? (rawPath === "" ? pages[0] : undefined)
      if (p === undefined) return yield* PluginError.notFound(`version ${v.number} has no page ${quoted(path)}`)
      const images: Record<string, string> = {}
      for (const im of yield* repo.imageRefs(v.id)) {
        const data = yield* repo.imageData(d.profile_id, im.sha256)
        if (data !== null) images[im.name] = `data:image/avif;base64,${toBase64(data)}`
      }
      const base = docBase(d.profile_id, d.slug, number)
      const shown = Result.try({ try: () => lib.render(p.source, p.format, { pagePath: p.path, baseUrl: base, images }), catch: renderMessage })
      const r = Result.getOrNull(shown)
      const page: RenderedPage = {
        path: p.path,
        title: p.title,
        format: p.format,
        html: r?.html ?? null,
        toc: r?.toc ?? [],
        has_h1: r?.hasH1 ?? false,
        warnings: r?.warnings ?? [],
        // Checked when it was published, so only a renderer that changed since would get here.
        error: Result.isFailure(shown) ? shown.failure : null,
      }
      return { version: v, nav, page, pages: pages.map((x) => ({ path: x.path, title: x.title })) }
    }),
    /** The documents a task published, newest version first, each once. */
    ofTask: Effect.fn("Docs.ofTask")(function* (profile: string, task: string) {
      const seen = new Set<string>()
      return (yield* repo.publishedBy(profile, task)).filter((r) => (seen.has(r.slug) ? false : (seen.add(r.slug), true)))
    }),
    counts: repo.counts,

    comments: Effect.fn("Docs.comments")(function* (d: Doc) {
      return { comments: yield* repo.comments(d.id), task: yield* commentsTask(d) }
    }),
    addComment: Effect.fn("Docs.addComment")(function* (profile: string, slug: string, c: NewComment) {
      const d = yield* docOf(profile, slug)
      const v = yield* repo.version(d.id, c.version)
      if (v === null) return yield* PluginError.notFound(`document ${quoted(slug)} has no version ${c.version}`)
      const page = yield* repo.page(v.id, c.page)
      if (page === null) return yield* PluginError.notFound(`version ${c.version} has no page ${quoted(c.page)}`)
      const said = {
        quote: yield* text(c.quote, "quote", MAX_QUOTE_CHARS, true),
        prefix: yield* text(c.prefix, "prefix", MAX_CONTEXT_CHARS),
        suffix: yield* text(c.suffix, "suffix", MAX_CONTEXT_CHARS),
        comment: (yield* text(c.comment, "comment", MAX_COMMENT_CHARS)).trim(),
      }
      const made = yield* tx(repo.addComment(d.id, v.id, page.path, said, yield* nowIso))
      yield* commentsChanged(d)
      return made
    }),
    updateComment: Effect.fn("Docs.updateComment")(function* (profile: string, slug: string, id: number, comment: string) {
      const d = yield* docOf(profile, slug)
      const said = (yield* text(comment, "comment", MAX_COMMENT_CHARS)).trim()
      const out = yield* tx(repo.editComment(d.id, id, said, yield* nowIso))
      if (out === null) return yield* PluginError.notFound(`no comment ${id}`)
      yield* commentsChanged(d)
      return out
    }),
    deleteComment: Effect.fn("Docs.deleteComment")(function* (profile: string, slug: string, id: number) {
      const d = yield* docOf(profile, slug)
      if (!(yield* tx(repo.deleteComment(d.id, id)))) return yield* PluginError.notFound(`no comment ${id}`)
      yield* commentsChanged(d)
    }),
    /** Sends the unsent comments to the task that published the document, as one message, and marks them sent. */
    sendComments: Effect.fn("Docs.sendComments")(function* (profile: string, slug: string) {
      const d = yield* docOf(profile, slug)
      const task = yield* commentsTask(d)
      if (task === null) return yield* PluginError.conflict("no task that published this document is still on the board to send its comments to")
      const unsent = (yield* repo.comments(d.id)).filter((m) => m.sent_at === null)
      if (unsent.length === 0) return yield* PluginError.conflict("every comment has been sent already")
      const at = (yield* urls(profile))
      yield* host.sendToTask(
        task.id,
        commentsMessage(
          d,
          unsent.map((m) => ({ version: m.version, page: m.page, quote: m.quote, comment: m.comment, url: at(d.slug, m.version, m.page) })),
        ),
      )
      yield* tx(repo.markSent(unsent.map((m) => m.id), yield* nowIso))
      yield* commentsChanged(d)
      return { sent: unsent.length, task: { id: task.id, key: task.key, title: task.title } }
    }),

    // ---- the docs server's tools: each as its tool answers, failing with what the agent is told ----------------------

    publish: (caller: Caller, input: PublishInput) =>
      publishFor(
        { repo, images: deps.images, lib, transaction: tx, boardUrl: host.boardUrl, uuid: deps.uuid, changed: (profile, slug) => docsChanged(profile, slug) },
        caller,
        input,
      ).pipe(Effect.mapError(refused)),
    agentList: Effect.fn("Docs.agentList")(function* (caller: Caller, label: string | null) {
      const at = yield* urls(caller.profile)
      const wanted = label === null || label.trim() === "" ? null : ((yield* Effect.mapError(rendered(() => lib.normalizeLabels([label])), refused))[0] ?? null)
      const all = yield* repo.list(caller.profile)
      return {
        documents: all
          .filter((d) => wanted === null || d.labels.some((l) => lib.labelMatches(l, wanted)))
          .map((d) => ({
            slug: d.slug,
            title: d.title,
            folder: d.folder,
            labels: d.labels,
            url: at(d.slug, null, "index"),
            latest_version: d.latest_version,
            pages: d.page_count,
            updated_at: d.updated_at,
          })),
      }
    }),
    agentGet: Effect.fn("Docs.agentGet")(function* (caller: Caller, slug: string, number: number | null) {
      const at = yield* urls(caller.profile)
      const d = yield* forAgent(caller, slug)
      const v = yield* versionForAgent(d, number)
      return {
        slug: d.slug,
        title: d.title,
        folder: d.folder,
        labels: d.labels,
        url: at(d.slug, null, "index"),
        version: versionJson(v),
        latest_version: d.latest_version,
        pages: (yield* repo.pages(v.id)).map((p) => ({ path: p.path, title: p.title, format: p.format, url: at(d.slug, number, p.path) })),
        images: (yield* repo.images(v.id)).map((im) => ({ name: im.name, bytes: im.bytes, width: im.width, height: im.height })),
        versions: (yield* repo.versions(d.id)).slice(0, 50).map(versionJson),
      }
    }),
    readPage: Effect.fn("Docs.readPage")(function* (caller: Caller, slug: string, raw: string, number: number | null) {
      const at = yield* urls(caller.profile)
      const d = yield* forAgent(caller, slug)
      const v = yield* versionForAgent(d, number)
      const path = yield* Effect.mapError(rendered(() => lib.normalizePath(raw)), refused)
      const page = (yield* repo.page(v.id, path)) ?? (yield* repo.page(v.id, `${path}/index`))
      if (page === null) return yield* new DocsRefused({ message: `version ${v.number} has no page ${quoted(path)}` })
      return { path: page.path, title: page.title, format: page.format, version: v.number, url: at(d.slug, v.number, page.path), content: page.source }
    }),
    agentMove: Effect.fn("Docs.agentMove")(function* (caller: Caller, slug: string, raw: string) {
      const at = yield* urls(caller.profile)
      const d = yield* forAgent(caller, slug)
      const folder = yield* Effect.mapError(rendered(() => lib.normalizeFolder(raw)), refused)
      yield* tx(repo.move(d.id, folder))
      yield* docsChanged(caller.profile, d.slug)
      return { slug: d.slug, folder, url: at(d.slug, null, "index") }
    }),
    setLabels: Effect.fn("Docs.setLabels")(function* (caller: Caller, slug: string, raw: ReadonlyArray<string>) {
      const at = yield* urls(caller.profile)
      const d = yield* forAgent(caller, slug)
      const labels = yield* Effect.mapError(rendered(() => lib.normalizeLabels([...raw])), refused)
      yield* tx(Effect.flatMap(repo.knownLabels(caller.profile), (known) => repo.replaceLabels(d.id, spelt(lib, known, labels))))
      yield* docsChanged(caller.profile, d.slug)
      return { slug: d.slug, labels: (yield* forAgent(caller, d.slug)).labels, url: at(d.slug, null, "index") }
    }),
    agentLabels: (caller: Caller) => Effect.map(repo.list(caller.profile), (all) => labelTree(lib, all)),
    feedback: Effect.fn("Docs.feedback")(function* (caller: Caller, slug: string, number: number | null, since: number | null) {
      const d = yield* forAgent(caller, slug)
      const cursor = Math.floor((yield* Clock.currentTimeMillis) / 1000)
      // Times are kept as ISO strings, which compare as the times do.
      const from = since === null ? Option.none() : DateTime.make(since * 1000)
      const after = Option.isNone(from) ? null : DateTime.formatIso(from.value)
      const comments = yield* repo.comments(d.id, { version: number, since: after })
      return {
        document: d.slug,
        latest_version: d.latest_version,
        cursor,
        responses: [],
        selections: comments.map((m) => ({
          id: m.id,
          version: m.version,
          page: m.page,
          quote: m.quote,
          comment: m.comment,
          context_before: m.prefix,
          context_after: m.suffix,
          user: "user",
          created_at: Math.floor(DateTime.toEpochMillis(DateTime.makeUnsafe(m.created_at)) / 1000),
        })),
        hint: "Pass `since: cursor` next time to get only feedback that is new or changed (items may repeat within the same second).",
      }
    }),
    components: Effect.sync(() => lib.componentsReference()),
  }
}

export type Docs = ReturnType<typeof makeDocs>
