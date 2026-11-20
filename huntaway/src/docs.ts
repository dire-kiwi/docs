import { createHash, randomBytes } from "node:crypto"
import { Clock, DateTime, Effect, Option, Result, Schema } from "effect"
import { PluginError } from "@huntaway/plugin"
import type { PluginHostShape } from "@huntaway/plugin"
import type { Images } from "./images.ts"
import { designDraft } from "./repo.ts"
import type { Answer, Doc, DocPage, Format, Repo, VersionRow } from "./repo.ts"
import { renderMessage, rendered } from "./render.ts"
import type { RenderLib } from "./render.ts"
import { chars, docBase, feedbackMessage, labelTree, quoted, renamedFolders, spelt } from "./rules.ts"
import { nowIso, publishFor } from "./publish.ts"
import type { Caller, PublishInput } from "./publish.ts"

// Each profile's documents (the board's built-in documents, moved into this plugin): agents publish them through the
// `docs` MCP server as they would to the hosted site, and people read them on the plugin's pages. A document has
// immutable versions, each with its pages (Markdown or MDX), and every publish makes a new one. Slugs are unique per
// profile. A document is filed in a folder when it's created (a '/'-path, "" the top level), has labels ('/'-nested,
// matched whatever their case, spelt as first used in the profile), images (AVIFs kept once per profile), and comments
// and answers to form fields the user leaves on a version's pages for the agent. What an agent is told when it can't is a `DocsRefused`, in the
// hosted server's words; what a page is told is a `PluginError`.

/** A refusal an agent is told in the docs server's words (the hosted server's, where it has one). */
export class DocsRefused extends Schema.TaggedError<DocsRefused>()("DocsRefused", { message: Schema.String }) {}

/** Why an image file sent to an upload URL isn't taken: the answer's HTTP status, and what it says (the hosted site's words). */
export class UploadRefused extends Schema.TaggedError<UploadRefused>()("UploadRefused", { status: Schema.Int, message: Schema.String }) {}

/** An upload URL's token as it is kept: its SHA-256, so the database doesn't hold what uploads. */
const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex")

/** The longest quote, comment, and quote's context either side a comment may have, in characters. */
export const MAX_QUOTE_CHARS = 10_000
export const MAX_COMMENT_CHARS = 20_000
export const MAX_CONTEXT_CHARS = 500
/** The longest selector a comment on a mockup's element is anchored with. */
export const MAX_ANCHOR_CHARS = 2000
/** The biggest draft the editor keeps, as JSON (images it uploaded are in it, as base64). */
export const MAX_DRAFT_BYTES = 50_000_000
/** The longest answer, as JSON, in bytes (the hosted site's limit). */
export const MAX_ANSWER_BYTES = 100_000

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
  /** `html` is a mockup: it has no reader HTML, and the design editor shows it (`Docs.mockups`). */
  readonly format: Format
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
  /** For a comment on a mockup's element: a CSS selector for it. */
  readonly anchor?: string | undefined
  readonly comment?: string | undefined
}

/** A mockup as the design editor shows it (frontend/src/design/design.ts's `DesignPage`). */
export interface Mockup {
  readonly path: string
  readonly title: string
  readonly content: string
  /** What its `src`s and `url()`s name among the version's images, as written → each image as a `data:` URL. */
  readonly images: Readonly<Record<string, string>>
}

export interface NewAnswer {
  readonly version: number
  readonly page: string
  readonly field: string
  readonly value: unknown
}

/** A page the editor previews. */
export interface EditorPreview {
  readonly path: string
  readonly format: string
  readonly content: string
}

/** What the editor saves: every page of the document, and images uploaded in it (checked by `publish_document`'s rules). */
export interface EditorSave {
  /** The document, or null for a new one. */
  readonly slug: string | null
  /** The version the editor opened. */
  readonly base_version: number | null
  readonly title: string
  /** A new document's folder. */
  readonly folder: string | null
  readonly message: string | null
  readonly pages: ReadonlyArray<unknown>
  readonly images: ReadonlyArray<unknown>
  /** From the design editor: only the mockups it changed, so the document's other pages are kept. */
  readonly design?: boolean | undefined
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
  const answersChanged = (d: Doc) => host.emit({ topic: "answers", profile_id: d.profile_id, data: { slug: d.slug } })

  /** A page's form fields, by name, with their labels (an unrenderable page has none). */
  const fieldsOf = (p: DocPage) =>
    new Map(
      Result.getOrElse(
        Result.try(() => lib.render(p.source, p.format, { pagePath: p.path, baseUrl: "/" }).fields),
        () => [],
      ).map((f) => [f.name, f]),
    )
  /**
   * `answers` with their fields' labels (null for a field the page doesn't have), in the order the fields are on their
   * pages.
   */
  const labelled = Effect.fnUntraced(function* (d: Doc, answers: ReadonlyArray<Answer>) {
    const pages = new Map<string, ReadonlyArray<string>>()
    const labels = new Map<string, string>()
    for (const a of answers) {
      const key = `${a.version}\n${a.page}`
      if (pages.has(key)) continue
      const v = yield* repo.version(d.id, a.version)
      const p = v === null ? null : yield* repo.page(v.id, a.page)
      const fields = p === null ? [] : [...fieldsOf(p).values()]
      pages.set(key, fields.map((f) => f.name))
      for (const f of fields) labels.set(`${key}\n${f.name}`, f.label)
    }
    const position = (a: Answer) => (pages.get(`${a.version}\n${a.page}`) ?? []).indexOf(a.field) >>> 0
    return answers
      .map((a) => ({ ...a, label: labels.get(`${a.version}\n${a.page}\n${a.field}`) ?? null }))
      .toSorted((x, y) => x.version - y.version || (x.page < y.page ? -1 : x.page > y.page ? 1 : 0) || position(x) - position(y))
  })
  const valueOf = (a: Answer): unknown => {
    try {
      return JSON.parse(a.value) as unknown
    } catch {
      return null
    }
  }

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

  /**
   * The images of version `versionId` that page `p` shows, as `data:` URLs by name: only those, as a version may have 200
   * of up to 500 KB each.
   */
  const shownImages = Effect.fnUntraced(function* (d: Doc, versionId: string, p: { readonly path: string; readonly format: Format; readonly source: string }, base: string) {
    const images: Record<string, string> = {}
    const refs = yield* repo.imageRefs(versionId)
    if (refs.length === 0) return images
    const srcs = Result.getOrElse(
      Result.try(() => lib.render(p.source, p.format, { pagePath: p.path, baseUrl: base }).imageSrcs),
      () => [],
    )
    const byName = new Map(refs.map((im) => [im.name, im.sha256]))
    for (const src of srcs) {
      const name = lib.imageCandidates(p.path, src).find((n) => byName.has(n))
      const sha = name === undefined ? undefined : byName.get(name)
      if (name === undefined || sha === undefined || name in images) continue
      const data = yield* repo.imageData(d.profile_id, sha)
      if (data !== null) images[name] = `data:image/avif;base64,${toBase64(data)}`
    }
    return images
  })

  /** Where a document's draft is kept: the document editor's under its slug ('' for a new document), the design editor's beside it. */
  const draftKey = (slug: string | null, design: boolean) => (design ? designDraft(slug ?? "") : (slug ?? ""))

  /**
   * What a mockup refers to among version `versionId`'s images, as it writes each reference, as `data:` URLs (the
   * board's frames reach no network).
   */
  const mockupImages = Effect.fnUntraced(function* (d: Doc, versionId: string, p: DocPage, cache: Map<string, string | null>) {
    const images: Record<string, string> = {}
    const refs = yield* repo.imageRefs(versionId)
    if (refs.length === 0) return images
    const byName = new Map(refs.map((im) => [im.name, im.sha256]))
    const srcs = Result.getOrElse(
      Result.try(() => lib.render(p.source, p.format, { pagePath: p.path, baseUrl: "/" }).imageSrcs),
      () => [],
    )
    for (const src of srcs) {
      const sha = lib
        .imageCandidates(p.path, src)
        .map((n) => byName.get(n))
        .find((s) => s !== undefined)
      if (sha === undefined) continue
      if (!cache.has(sha)) {
        const data = yield* repo.imageData(d.profile_id, sha)
        cache.set(sha, data === null ? null : `data:image/avif;base64,${toBase64(data)}`)
      }
      const url = cache.get(sha)
      if (url != null) images[src] = url
    }
    return images
  })

  /** A page path from the editor, or `index`. */
  const editorPath = (raw: string) => Option.getOrElse(Option.liftThrowable(() => lib.normalizePath(raw))(), () => "index")

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
      const base = docBase(d.profile_id, d.slug, number)
      const images = yield* shownImages(d, v.id, p, base)
      const answers = Object.fromEntries((yield* repo.pageAnswers(v.id, p.path)).map((a) => [a.field, valueOf(a)]))
      const shown = Result.try({ try: () => lib.render(p.source, p.format, { pagePath: p.path, baseUrl: base, images, answers }), catch: renderMessage })
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
    /** The mockups of a version (its pages whose format is `html`), for the design editor, and its other pages. */
    mockups: Effect.fn("Docs.mockups")(function* (d: Doc, v: VersionRow) {
      const pages = yield* repo.pagesFull(v.id)
      const cache = new Map<string, string | null>()
      const mockups: Array<Mockup> = []
      for (const p of pages) {
        if (p.format === "html") mockups.push({ path: p.path, title: p.title, content: p.source, images: yield* mockupImages(d, v.id, p, cache) })
      }
      return { mockups, others: pages.filter((p) => p.format !== "html").map((p) => ({ path: p.path, title: p.title })) }
    }),
    /** What the editor opens a document with: its latest version's pages, their sources, and its images' names. */
    editorData: Effect.fn("Docs.editorData")(function* (d: Doc, rawPath: string) {
      const v = yield* repo.version(d.id, null)
      if (v === null) return yield* PluginError.notFound(`document ${quoted(d.slug)} has no versions`)
      const pages = yield* repo.pagesFull(v.id)
      const path = editorPath(rawPath)
      const open = (pages.find((p) => p.path === path) ?? pages.find((p) => p.path === `${path}/index`) ?? pages[0])?.path ?? "index"
      return {
        version: v.number,
        open,
        pages: pages.map((p) => ({ path: p.path, title: p.title, format: p.format, content: p.source })),
        images: (yield* repo.imageRefs(v.id)).map((im) => im.name),
      }
    }),
    /** The editor's draft of a document (or, `slug` null, of a new one), as it gave it; null if there's none. */
    draft: Effect.fn("Docs.draft")(function* (profile: string, slug: string | null, design = false) {
      const data = yield* repo.draft(profile, draftKey(slug, design))
      if (data === null) return null
      try {
        return JSON.parse(data) as unknown
      } catch {
        return null
      }
    }),
    /** Keeps the editor's draft (any JSON, at most `MAX_DRAFT_BYTES`), or with `draft` null, drops it. */
    keepDraft: Effect.fn("Docs.keepDraft")(function* (profile: string, slug: string | null, draft: unknown, design = false) {
      yield* profileOf(profile)
      if (slug !== null) yield* docOf(profile, slug)
      if (draft === null) return yield* repo.dropDraft(profile, draftKey(slug, design))
      const data = JSON.stringify(draft)
      if (data.length > MAX_DRAFT_BYTES) return yield* PluginError.invalid("the draft is too big to keep")
      yield* repo.putDraft(profile, draftKey(slug, design), data, yield* nowIso)
    }),
    /** A page as it would render, for the editor's preview, with the images of the document's latest version. */
    preview: Effect.fn("Docs.preview")(function* (profile: string, slug: string | null, input: EditorPreview) {
      yield* profileOf(profile)
      const d = slug === null ? null : yield* repo.get(profile, slug)
      const v = d === null ? null : yield* repo.version(d.id, null)
      const format: Format = input.format === "mdx" ? "mdx" : input.format === "html" ? "html" : "md"
      const p = { path: editorPath(input.path), format, source: input.content }
      const base = d === null ? `/docs/${encodeURIComponent(profile)}/` : docBase(profile, d.slug, null)
      const images = d === null || v === null ? {} : yield* shownImages(d, v.id, p, base)
      const shown = Result.try({ try: () => lib.render(p.source, format, { pagePath: p.path, baseUrl: base, images }), catch: renderMessage })
      if (Result.isFailure(shown)) return { html: null, has_h1: false, warnings: [], error: `This page isn't valid ${format}: ${shown.failure}` }
      return { html: shown.success.html, has_h1: shown.success.hasH1, warnings: shown.success.warnings, error: null }
    }),
    /**
     * The editor's pages as a new version of a document (`slug`), or a new document. Pages it had that the editor
     * doesn't are deleted; images the pages still use are kept. If a version was published after `base_version`, it
     * publishes nothing and says which is the latest.
     */
    save: Effect.fn("Docs.save")(function* (profile: string, input: EditorSave) {
      yield* profileOf(profile)
      const title = input.title.trim()
      if (title === "") return yield* PluginError.invalid("give the document a title")
      if (input.pages.length === 0) return yield* PluginError.invalid("a document needs at least one page")
      const caller: Caller = { profile, task: null, run: null, project: null }
      const common = { title: chars(title) > 200 ? [...title].slice(0, 200).join("") : title, message: input.message, labels: null, pages: input.pages, images: input.images }
      let input2: PublishInput
      if (input.slug !== null) {
        const d = yield* docOf(profile, input.slug)
        if (input.base_version !== null && input.base_version !== d.latest_version) {
          return { conflict: d.latest_version, message: `Version ${d.latest_version} was published while you were editing.` }
        }
        const v = yield* repo.version(d.id, null)
        const kept = new Set(
          input.pages.flatMap((p) => {
            const path = typeof p === "object" && p !== null && "path" in p && typeof p.path === "string" ? p.path : null
            return path === null ? [] : Option.toArray(Option.liftThrowable(() => lib.normalizePath(path))())
          }),
        )
        const gone = v === null || input.design === true ? [] : (yield* repo.pages(v.id)).map((p) => p.path).filter((p) => !kept.has(p))
        // A merge with every page, so the images the pages still use carry over.
        input2 = { ...common, slug: d.slug, mode: "merge", folder: null, delete_paths: gone }
      } else {
        input2 = { ...common, slug: null, mode: "replace", folder: input.folder ?? "", delete_paths: [] }
      }
      // The editor goes to the document once it's saved: the board doesn't reload its pages for this change (which would
      // reload the editor first). Its draft is saved now.
      const changed = (profile: string, slug: string) =>
        Effect.andThen(repo.dropDraft(profile, draftKey(input.slug === null ? null : slug, input.design === true)), host.emit({ topic: "documents", profile_id: profile, data: { slug, deleted: false } }))
      const out = yield* publishFor(
        { repo, images: deps.images, lib, transaction: tx, boardUrl: host.boardUrl, uuid: deps.uuid, changed },
        caller,
        input2,
      ).pipe(Effect.mapError((e) => PluginError.invalid(e.message)))
      return { slug: out.slug, version: out.version, url: docBase(profile, out.slug, null), warnings: out.warnings }
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
        anchor: (yield* text(c.anchor, "anchor", MAX_ANCHOR_CHARS)).trim(),
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
    /** How many of a document's answers haven't been sent to its task. */
    unsentAnswers: (d: Doc) => Effect.map(repo.answers(d.id), (all) => all.filter((a) => a.sent_at === null).length),
    /** Keeps the user's answer to a form field on a version's page; how many of the document's answers are unsent then. */
    saveAnswer: Effect.fn("Docs.saveAnswer")(function* (profile: string, slug: string, a: NewAnswer) {
      const d = yield* docOf(profile, slug)
      const v = yield* repo.version(d.id, a.version)
      if (v === null) return yield* PluginError.notFound(`document ${quoted(slug)} has no version ${a.version}`)
      const page = yield* repo.page(v.id, a.page)
      if (page === null) return yield* PluginError.notFound(`version ${a.version} has no page ${quoted(a.page)}`)
      if (!fieldsOf(page).has(a.field)) return yield* PluginError.invalid(`page has no field ${quoted(a.field)}`)
      const json = JSON.stringify(a.value ?? null)
      if (new TextEncoder().encode(json).length > MAX_ANSWER_BYTES) return yield* PluginError.invalid("answer is too long")
      const now = yield* nowIso
      yield* tx(repo.saveAnswer(v.id, page.path, a.field, json, now))
      yield* answersChanged(d)
      return { saved_at: now, unsent_answers: (yield* repo.answers(d.id)).filter((x) => x.sent_at === null).length }
    }),
    /**
     * Sends the unsent comments and answers to the task that published the document, as one message, and marks them
     * sent.
     */
    sendFeedback: Effect.fn("Docs.sendFeedback")(function* (profile: string, slug: string) {
      const d = yield* docOf(profile, slug)
      const task = yield* commentsTask(d)
      if (task === null) return yield* PluginError.conflict("no task that published this document is still on the board to send its feedback to")
      const comments = (yield* repo.comments(d.id)).filter((m) => m.sent_at === null)
      const answers = (yield* repo.answers(d.id)).filter((a) => a.sent_at === null)
      if (comments.length === 0 && answers.length === 0) return yield* PluginError.conflict("every comment and answer has been sent already")
      const at = yield* urls(profile)
      yield* host.sendToTask(
        task.id,
        feedbackMessage(
          d,
          comments.map((m) => ({ version: m.version, page: m.page, quote: m.quote, comment: m.comment, element: m.anchor === "" ? undefined : m.anchor, url: at(d.slug, m.version, m.page) })),
          (yield* labelled(d, answers)).map((a) => ({ ...a, value: valueOf(a), url: at(d.slug, a.version, a.page) })),
        ),
      )
      const now = yield* nowIso
      yield* tx(Effect.andThen(repo.markSent(comments.map((m) => m.id), now), repo.markAnswersSent(d.id, answers, now)))
      if (comments.length > 0) yield* commentsChanged(d)
      if (answers.length > 0) yield* answersChanged(d)
      return { comments: comments.length, answers: answers.length, task: { id: task.id, key: task.key, title: task.title } }
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
      const answers = yield* labelled(d, yield* repo.answers(d.id, { version: number, since: after }))
      const seconds = (iso: string) => Math.floor(DateTime.toEpochMillis(DateTime.makeUnsafe(iso)) / 1000)
      return {
        document: d.slug,
        latest_version: d.latest_version,
        cursor,
        responses: answers.map((a) => ({
          version: a.version,
          page: a.page,
          field: a.field,
          label: a.label,
          value: valueOf(a),
          user: "user",
          updated_at: seconds(a.updated_at),
        })),
        selections: comments.map((m) => ({
          id: m.id,
          version: m.version,
          page: m.page,
          quote: m.quote,
          comment: m.comment,
          context_before: m.prefix,
          context_after: m.suffix,
          element: m.anchor === "" ? null : m.anchor,
          user: "user",
          created_at: seconds(m.created_at),
        })),
        hint: "Pass `since: cursor` next time to get only feedback that is new or changed (items may repeat within the same second).",
      }
    }),
    components: Effect.sync(() => lib.componentsReference()),

    // ---- images uploaded on their own (DOC-22): over HTTP, so their bytes don't go through a tool call ----------------

    /**
     * `create_upload_url`: a URL the caller's profile's agents send image files to (the plugin's `/uploads/:token`
     * route), for an hour. The token is random and only its hash is kept. Uploads that expired go now.
     */
    uploadUrl: Effect.fn("Docs.uploadUrl")(function* (caller: Caller) {
      const now = yield* Clock.currentTimeMillis
      const limits = lib.imageLimits()
      yield* tx(repo.purgeUploads(now))
      const token = randomBytes(32).toString("base64url")
      yield* repo.addUploadUrl(tokenHash(token), caller.profile, now + limits.uploadUrlSeconds * 1000)
      const url = `${yield* host.boardUrl}/plugins/${host.plugin}/uploads/${token}`
      return {
        upload_url: url,
        expires_in: limits.uploadUrlSeconds,
        curl: `curl -sS --data-binary @FILE "${url}"`,
        then: 'Each upload answers { "id": ... }: pass { "name": "images/<name>.png", "upload": "<id>" } in publish_document\'s `images`, within a day.',
      }
    }),
    /** Whose uploads an upload URL's token takes, while it lasts: asked before anything of the request is read. */
    uploader: Effect.fn("Docs.uploader")(function* (token: string) {
      const profile = yield* repo.uploadUrlProfile(tokenHash(token), yield* Clock.currentTimeMillis)
      if (profile === null) return yield* new UploadRefused({ status: 404, message: lib.uploadErrors().url })
      return profile
    }),
    /**
     * An image file sent to an upload URL: checked and converted to AVIF as a publish's images are, and kept for the
     * URL's profile to publish, under a random UUID, for a day.
     */
    upload: Effect.fn("Docs.upload")(function* (profile: string, bytes: Uint8Array) {
      const now = yield* Clock.currentTimeMillis
      const limits = lib.imageLimits()
      if (bytes.length === 0) return yield* new UploadRefused({ status: 400, message: lib.uploadErrors().body })
      const no = (e: { readonly message: string }) => new UploadRefused({ status: 400, message: e.message })
      const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString("base64")
      const checked = yield* Effect.mapError(rendered(() => lib.validateUpload(data)), no)
      const image = yield* Effect.mapError(deps.images.convertBytes(lib, { name: "", label: checked.label, format: checked.format }, bytes), no)
      const id = yield* deps.uuid
      const at = yield* nowIso
      yield* tx(
        Effect.gen(function* () {
          if ((yield* repo.waitingUploads(profile, now)) >= limits.maxWaitingUploads) {
            return yield* new UploadRefused({ status: 429, message: lib.uploadErrors().tooMany })
          }
          yield* repo.addUpload(id, profile, image, at, now + limits.uploadKeptSeconds * 1000)
        }),
      )
      return { id, bytes: image.data.length, expires_in: limits.uploadKeptSeconds }
    }),
  }
}

export type Docs = ReturnType<typeof makeDocs>
