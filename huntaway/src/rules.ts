import { Result, Schema } from "effect"
import type { RenderLib } from "./render.ts"

// The rules of documents that read no state: slugs, labels as a document keeps them, renaming folders, the label tree,
// where the board shows a document, and the message that sends comments to an agent. Labels, folders and paths are the
// renderer's (the hosted site's own code); the rest are the hosted site's rules written again, so an agent gets the same
// answer from either.

/** The longest folder, in characters (the renderer's `MAX_FOLDER_CHARS`). */
export const MAX_FOLDER_CHARS = 200

/** How many characters (code points) a string has, as the hosted site counts them. */
export const chars = (s: string): number => Array.from(s).length

const jsonString = Schema.encodeResult(Schema.fromJsonString(Schema.String))
/** A string quoted as JSON writes it (and as Rust's `{:?}` does, for what messages quote), for messages. */
export const quoted = (s: string): string => Result.getOrElse(jsonString(s), () => `"${s}"`)

/** The hosted site's slug for a title or a given slug (its `db::doc_slug`): lowercase ASCII letters and digits, with dashes between. */
export const docSlug = (title: string): string => {
  let s = ""
  for (const ch of title.toLowerCase()) {
    if (/^[a-z0-9]$/.test(ch)) s += ch
    else if (s !== "" && !s.endsWith("-")) s += "-"
    if (s.length >= 60) break
  }
  s = s.replace(/^-+|-+$/g, "")
  return s === "" ? "doc" : s
}

/** Labels' order on a document, as the hosted site gives them: by their lowercase. */
export const byLowercase = (a: string, b: string): number => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()]
  return x < y ? -1 : x > y ? 1 : 0
}

/**
 * `labels` (normalised) spelt as `known` (the profile's labels, oldest first) spell them already, whatever case they're
 * given in, each once: what a document's labels become when they're set. A label's own first spelling counts for the
 * ones after it.
 */
export const spelt = (lib: RenderLib, known: ReadonlyArray<string>, labels: ReadonlyArray<string>): ReadonlyArray<string> => {
  const all = [...known]
  const seen = new Set<string>()
  const out: Array<string> = []
  for (const l of labels) {
    const s = lib.withKnownCase(l, all)
    all.push(s)
    if (seen.has(s.toLowerCase())) continue
    seen.add(s.toLowerCase())
    out.push(s)
  }
  return out
}

/** A label in `list_labels`' tree. */
export interface LabelNode {
  readonly name: string
  readonly path: string
  readonly documents: number
  readonly children: ReadonlyArray<LabelNode>
}

/** What `list_labels` answers: the labels as a tree, how many documents there are, and how many have no label. */
export interface LabelTree {
  readonly labels: ReadonlyArray<LabelNode>
  readonly documents: number
  readonly unlabelled: number
}

/** The profile's labels as a tree from its documents' labels (the renderer's `labelTree`, as `list_labels` returns it). */
export const labelTree = (lib: RenderLib, docs: ReadonlyArray<{ readonly labels: ReadonlyArray<string> }>): LabelTree => {
  const strip = (n: ReturnType<RenderLib["labelTree"]>[number]): LabelNode => ({
    name: n.name,
    path: n.path,
    documents: n.documents,
    children: n.children.map(strip),
  })
  return {
    labels: lib.labelTree(docs.map((d) => [...d.labels])).map(strip),
    documents: docs.length,
    unlabelled: docs.filter((d) => d.labels.length === 0).length,
  }
}

/**
 * The folders documents in `from` (or in a folder inside it) move to when it's renamed `to` (`""`: the top level), as
 * the hosted site's `rename_folder` does (`docs2` isn't inside `docs`); or why it can't.
 */
export const renamedFolders = <D extends { readonly folder: string }>(
  docs: ReadonlyArray<D>,
  from: string,
  to: string,
): { readonly moved: ReadonlyArray<{ readonly doc: D; readonly folder: string }> } | { readonly error: string } => {
  if (from === "") return { error: "choose a folder to rename" }
  const moved = docs
    .filter((d) => d.folder === from || d.folder.startsWith(`${from}/`))
    .map((doc) => ({ doc, folder: `${to}${doc.folder.slice(from.length)}`.replace(/^\/+/, "") }))
  const long = moved.find((m) => chars(m.folder) > MAX_FOLDER_CHARS)
  if (long !== undefined) return { error: `${quoted(long.folder)} would be longer than ${MAX_FOLDER_CHARS} characters` }
  return { moved }
}

/** A quote as a Markdown block quote, cut short past `max` characters. */
export const blockQuote = (quote: string, max = 1000): string => {
  const all = Array.from(quote)
  const q = all.length > max ? `${all.slice(0, max).join("")}…` : quote
  return q
    .split("\n")
    .map((l) => `> ${l}`.trimEnd())
    .join("\n")
}

/** A comment as the message that sends it names it. */
export interface SentComment {
  readonly version: number
  readonly page: string
  readonly quote: string
  readonly comment: string
  /** The board's URL of the page it's on, in its version. */
  readonly url: string
}

/** The message that sends a document's `comments` to the agent that published it. */
export const commentsMessage = (doc: { readonly title: string; readonly slug: string }, comments: ReadonlyArray<SentComment>): string => {
  const n = comments.length
  const parts = [`The user left ${n === 1 ? "a comment" : `${n} comments`} on the document "${doc.title}" (slug \`${doc.slug}\`):`]
  comments.forEach((m, i) => {
    parts.push(`${i + 1}. On version ${m.version}, page \`${m.page}\` (${m.url}):\n\n${blockQuote(m.quote)}\n\n${m.comment || "(No comment: just the quote.)"}`)
  })
  parts.push(`The docs server's \`get_feedback\` (slug "${doc.slug}") has them too.`)
  return parts.join("\n\n")
}

/**
 * Where a document is under the plugin's pages (its latest version, or version `version`), ending in `/`: page URLs
 * follow it. The board shows the plugin's pages at `/docs/<path>`, so these are the paths its built-in documents had.
 */
export const docPath = (profile: string, slug: string, version: number | null): string => {
  const d = `${encodeURIComponent(profile)}/d/${encodeURIComponent(slug)}/`
  return version === null ? d : `${d}-/v/${version}/`
}

/** `docPath` from the board's root: what rendered pages' links are relative to. */
export const docBase = (profile: string, slug: string, version: number | null): string => `/docs/${docPath(profile, slug, version)}`
