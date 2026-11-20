import { DateTime, Effect, Option, Schema } from "effect"
import type { ImageUpload } from "@dire-kiwi/docs-render"
import type { Images } from "./images.ts"
import { ImageRefused } from "./images.ts"
import type { Format, NewImage, NewPage, Repo } from "./repo.ts"
import { RenderError, rendered } from "./render.ts"
import type { RenderLib } from "./render.ts"
import { docBase, docSlug, quoted, spelt } from "./rules.ts"

// `publish_document`, as the hosted site's (src/mcp.rs `publish`): the arguments checked in its order, the pages and
// images checked by the renderer's `validatePublish` (the site's own code), the images kept from the previous version
// for a merge, warnings for images a page shows that the version doesn't have, and only then the slow part (converting
// to AVIF); then one transaction makes the version (and the document, if it's new).

/** Who publishes: the profile its documents belong to, and the task and run that publish (none: the user, in the editor). */
export interface Caller {
  readonly profile: string
  readonly task: string | null
  readonly run: string | null
  /** The task's project's name, for a new document's folder (none: the top level). */
  readonly project: string | null
}

/** `publish_document`'s arguments, their types checked. */
export interface PublishInput {
  readonly slug: string | null
  readonly title: string | null
  readonly message: string | null
  readonly mode: string
  /** Given: used as it is (normalised); null: the task's project's name. */
  readonly folder: string | null
  readonly delete_paths: ReadonlyArray<string>
  /** The document's labels from now on, or null to keep its own. */
  readonly labels: ReadonlyArray<string> | null
  /** As given: `validatePublish` checks them. */
  readonly pages: ReadonlyArray<unknown>
  readonly images: ReadonlyArray<unknown>
}

/** What `publish_document` answers. */
export interface Published {
  readonly slug: string
  readonly folder: string
  readonly labels: ReadonlyArray<string>
  readonly note: string | null
  readonly version: number
  readonly url: string
  readonly version_url: string
  readonly pages: ReadonlyArray<{ readonly path: string; readonly title: string; readonly url: string }>
  readonly images: ReadonlyArray<{ readonly name: string; readonly bytes: number; readonly width: number; readonly height: number }>
  readonly warnings: ReadonlyArray<{ readonly page: string; readonly warning: string }>
}

export interface PublishDeps {
  readonly repo: Repo
  readonly images: Images
  readonly lib: RenderLib
  readonly transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** The board's address, for the URLs it answers with. */
  readonly boardUrl: Effect.Effect<string>
  readonly uuid: Effect.Effect<string>
  /** After the publish's transaction. */
  readonly changed: (profile: string, slug: string) => Effect.Effect<void>
}

const ValidPublish = Schema.Struct({
  pages: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      format: Schema.Literals(["md", "mdx", "html"]),
      title: Schema.String,
      position: Schema.Int,
      source: Schema.String,
      imageSrcs: Schema.Array(Schema.String),
    }),
  ),
  images: Schema.Array(Schema.Struct({ name: Schema.String, label: Schema.String, format: Schema.Literals(["png", "jpeg", "webp", "gif", "avif"]), data: Schema.String })),
  warnings: Schema.Array(Schema.Struct({ page: Schema.String, warning: Schema.String })),
})

const refused = (message: string) => new RenderError({ message })

export const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

/** Which of the image names a page refers to through its `<img src>`s, if any (the renderer's `imageCandidates`). */
const refersTo = (lib: RenderLib, page: string, srcs: ReadonlyArray<string>, names: ReadonlySet<string>): ReadonlySet<string> => {
  const out = new Set<string>()
  for (const src of srcs) {
    const hit = lib.imageCandidates(page, src).find((n) => names.has(n))
    if (hit !== undefined) out.add(hit)
  }
  return out
}

/** A page's relative `<img src>`s, rendered as published (for a merge's pages kept from the previous version). */
const srcsOf = (lib: RenderLib, p: { readonly path: string; readonly format: Format; readonly source: string }): ReadonlyArray<string> => {
  try {
    return lib.render(p.source, p.format, { pagePath: p.path, baseUrl: "/" }).imageSrcs
  } catch {
    return []
  }
}

export const publishFor = Effect.fnUntraced(function* (deps: PublishDeps, caller: Caller, input: PublishInput): Effect.fn.Return<Published, RenderError | ImageRefused> {
  const { repo, lib } = deps
  if (input.mode !== "replace" && input.mode !== "merge") return yield* refused(`mode must be "replace" or "merge", not ${quoted(input.mode)}`)
  const merge = input.mode === "merge"
  if (input.pages.length === 0 && input.delete_paths.length === 0) return yield* refused("pass at least one page")
  const given = input.folder
  // A new document without a folder goes in its project's (or the top level, if that name isn't a folder).
  const folder =
    given === null
      ? caller.project === null
        ? ""
        : Option.getOrElse(Option.liftThrowable(() => lib.normalizeFolder(caller.project ?? ""))(), () => "")
      : yield* rendered(() => lib.normalizeFolder(given))
  const rawLabels = input.labels
  const labels = rawLabels === null ? null : yield* rendered(() => lib.normalizeLabels([...rawLabels]))
  const deleted = new Set(input.delete_paths.flatMap((p) => Option.toArray(Option.liftThrowable(() => lib.normalizePath(p))())))
  // The pages and images go to the renderer as the agent gave them: it checks them, with the hosted server's messages.
  const valid = yield* rendered((): unknown => Reflect.apply(lib.validatePublish, undefined, [input.pages, input.images])).pipe(
    Effect.flatMap((out) => Effect.mapError(Schema.decodeUnknownEffect(ValidPublish)(out), (e) => refused(e.message))),
    // The renderer reads them with serde_json::from_str ("invalid pages: … at line 1 column 9"); the hosted server reads
    // them with the rest of the arguments ("invalid arguments: …", with no position).
    Effect.mapError((e) =>
      /^invalid (pages|images): /.test(e.message) ? refused(`invalid arguments: ${e.message.replace(/^invalid (pages|images): /, "").replace(/ at line \d+ column \d+$/, "")}`) : e,
    ),
  )
  const warnings = [...valid.warnings]
  const uploaded = new Set(valid.images.map((im) => im.name))
  const wanted = input.slug === null ? null : docSlug(input.slug)

  // A merge keeps the previous version's images that the new version's pages refer to.
  const kept: Array<{ readonly name: string; readonly sha256: string }> = []
  const existing = wanted === null ? null : yield* repo.get(caller.profile, wanted)
  const prev = existing === null ? null : yield* repo.version(existing.id, null)
  if (merge && prev !== null) {
    const old = (yield* repo.imageRefs(prev.id)).filter((im) => !uploaded.has(im.name))
    if (old.length > 0) {
      const names = new Set(old.map((im) => im.name))
      const paths = new Set(valid.pages.map((p) => p.path))
      const used = new Set<string>()
      for (const p of valid.pages) for (const n of refersTo(lib, p.path, p.imageSrcs, names)) used.add(n)
      for (const p of yield* repo.pagesFull(prev.id)) {
        if (paths.has(p.path) || deleted.has(p.path)) continue
        for (const n of refersTo(lib, p.path, srcsOf(lib, p), names)) used.add(n)
      }
      kept.push(...old.filter((im) => used.has(im.name)))
    }
  }
  const count = uploaded.size + kept.length
  if (count > lib.imageLimits().maxImages) return yield* refused(lib.imageTooManyError(count))
  const have = new Set([...uploaded, ...kept.map((k) => k.name)])
  for (const p of valid.pages) {
    for (const src of p.imageSrcs) {
      if (!lib.imageCandidates(p.path, src).some((n) => have.has(n))) {
        warnings.push({ page: p.path, warning: `image ${quoted(src)} isn't one of this version's images; pass it in \`images\` or inline it as a data: URI` })
      }
    }
  }
  const converted: ReadonlyArray<NewImage> = yield* deps.images.convert(lib, valid.images as ReadonlyArray<ImageUpload>)

  const pages: ReadonlyArray<NewPage> = valid.pages.map((p) => ({ path: p.path, title: p.title, format: p.format, position: p.position, source: p.source }))
  // A new document's title is its index page's (or its first page's), unless it's given.
  const newTitle = existing !== null ? null : ((pages.find((p) => p.path === "index") ?? pages[0])?.title ?? null)
  const now = yield* nowIso
  const docId = yield* deps.uuid
  const versionId = yield* deps.uuid

  const made = yield* deps.transaction(
    Effect.gen(function* () {
      const found = wanted === null ? null : yield* repo.get(caller.profile, wanted)
      let doc = found
      if (found !== null) {
        const title = input.title ?? newTitle
        if (title !== null) yield* repo.setTitle(found.id, title)
      } else {
        const title = input.title ?? newTitle ?? "Untitled"
        const base = wanted ?? docSlug(title)
        let slug = base
        for (let n = 2; (yield* repo.get(caller.profile, slug)) !== null; n++) slug = `${base}-${n}`
        yield* repo.insertDoc({ id: docId, profile_id: caller.profile, slug, title, folder, now })
        doc = yield* repo.get(caller.profile, slug)
      }
      if (doc === null) return yield* Effect.die(new Error("a document just made isn't there"))
      const before = yield* repo.version(doc.id, null)
      const number = before === null ? 1 : before.number + 1
      yield* repo.insertVersion({ id: versionId, doc: doc.id, number, message: input.message, task_id: caller.task, run_id: caller.run, now })
      for (const page of pages) yield* repo.insertPage(versionId, page)
      if (merge && before !== null) {
        // The previous version's other pages carry over.
        const paths = new Set(pages.map((p) => p.path))
        for (const old of yield* repo.pagesFull(before.id)) {
          if (paths.has(old.path) || deleted.has(old.path)) continue
          yield* repo.insertPage(versionId, old)
        }
      }
      if ((yield* repo.pageCount(versionId)) === 0) return yield* refused("a version needs at least one page")
      for (const im of converted) yield* repo.addImage(caller.profile, versionId, im, now)
      for (const im of kept) yield* repo.nameImage(versionId, im.name, im.sha256)
      if (labels !== null) yield* repo.replaceLabels(doc.id, spelt(lib, yield* repo.knownLabels(caller.profile), labels))
      yield* repo.touch(doc.id, now)
      return { slug: doc.slug, number }
    }),
  )
  yield* deps.changed(caller.profile, made.slug)

  const board = yield* deps.boardUrl
  const url = (slug: string, number: number | null, path: string) => `${board}${docBase(caller.profile, slug, number)}${lib.urlSuffix(path)}`
  const d = yield* repo.get(caller.profile, made.slug)
  const v = d === null ? null : yield* repo.version(d.id, made.number)
  if (d === null || v === null) return yield* Effect.die(new Error("a version just published isn't there"))
  // An existing document stays where it is, so a publish doesn't undo the user's move.
  const note =
    given !== null && d.folder !== folder ? `The document stays in its folder ${quoted(d.folder)}; call move_document only if the user asks to move it.` : null
  return {
    slug: made.slug,
    folder: d.folder,
    labels: d.labels,
    note,
    version: made.number,
    url: url(made.slug, null, "index"),
    version_url: url(made.slug, made.number, "index"),
    pages: (yield* repo.pages(v.id)).map((p) => ({ path: p.path, title: p.title, url: url(made.slug, null, p.path) })),
    images: (yield* repo.images(v.id)).map((im) => ({ name: im.name, bytes: im.bytes, width: im.width, height: im.height })),
    warnings,
  }
})
