import { Effect, Result, Schema } from "effect"
import { Tool } from "effect/ai"
import type { CallContext, PluginTool } from "@huntaway/plugin"
import type { Docs } from "./docs.ts"
import type { Caller } from "./publish.ts"
import type { RenderLib } from "./render.ts"
import { quoted } from "./rules.ts"

// The `docs` MCP server agents on the board get (`mcp__docs__<tool>`): they publish documents to their profile on this
// host exactly as they would to the hosted site. The tools, their schemas, checks, errors and warnings are the hosted
// server's, from the renderer (`toolDefinitions`), but `share_document` (documents on the board aren't shared) and
// organizations (`list_organizations` and the `organization` arguments: the board has none). A tool's
// result is its JSON as text and as `structuredContent`; a failure is its message as a tool error, without anything
// before it, as the hosted server's.

/** The hosted server's tools this one leaves out. */
const LEFT_OUT = new Set(["share_document", "list_organizations"])

/** A tool's input schema without the hosted server's `organization` argument. */
const withoutOrganization = (schema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const properties = schema["properties"]
  if (typeof properties !== "object" || properties === null || !("organization" in properties)) return schema
  const { organization: _, ...rest } = properties as Record<string, unknown>
  return { ...schema, properties: rest }
}

/** What the server tells agents (Claude Code adds it to its system prompt). */
export const INSTRUCTIONS =
  "Docs keeps Markdown documents for the user to read on this Huntaway board: reports, plans, research, write-ups. " +
  "Publish with `publish_document` (one or more pages; nested paths like `plan/phase-1` make a nested menu). Every " +
  'publish creates a new version, so you can revise freely; `mode: "merge"` keeps the other pages of the previous ' +
  "version. If you can start sub-agents, have one write and publish the document: give it what the document should " +
  "say, let it look up components, publish and fix any problems, and have it return the URL. That keeps the component " +
  "reference and the page sources out of your own context. Plain Markdown needs no reference. For components " +
  '(callouts, collapsible sections, form fields), call `list_components` for their names, props and examples, and use format "mdx". ' +
  "Form fields (`<Approval />`, inputs and the like) collect the user's answers: to ask the user questions, publish them " +
  "as form fields and give the user the URL; they answer on the page and send their answers to the task that published " +
  "the document as a message, and `get_feedback` returns them as `responses`. `publish_document` is the check: it rejects a page it can't publish and says " +
  "why, and returns warnings (an unknown component, a bad prop) with the URL; fix them and publish again. Don't install " +
  "or run npm packages, renderers or other tools to check pages. The user can also select text in a document on the board " +
  "and comment on it for you: `get_feedback` has the comments and answers (pass its `cursor` as `since` next time for only " +
  "new ones), and the board sends them to the task that published the document as a message when the user chooses Send. " +
  "The user can also edit a document themselves on the board, which publishes a new version (with no task): before you " +
  "publish a new version of a document they may have edited, read its latest pages (`get_document`, `read_page`) so you " +
  "don't undo their changes. " +
  "Documents belong to your profile on this board. A new " +
  "document goes in a folder named after your task's project unless you give `folder`; a `folder` you give is used as " +
  'it is (`"plans"` is a top-level folder, `"<project>/plans"` one inside the project\'s), and later versions stay ' +
  "wherever the document is. Use `move_document` only when the user asks to move one. Documents can also have labels, " +
  "nested with '/' (\"research/ai\"): pass `labels` to `publish_document` or call `set_document_labels`, and call " +
  "`list_labels` to reuse the labels that already exist rather than inventing near-duplicates. Images: pass them to " +
  "`publish_document` as `images` ({name, data}: base64 PNG, JPEG, WebP, GIF or AVIF, name a relative path like " +
  '"images/chart.png") and refer to them by name (`![Chart](images/chart.png)`), or inline them as data: URIs. Every image ' +
  "is converted to AVIF and must be at most 500 KB after that (downscale or crop one that isn't); only the AVIF is kept, " +
  "not the original, and SVG and remote images aren't shown. Always give the reader the URL returned by `publish_document`."

/** A tool definition as the renderer gives it. */
interface Definition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly annotations?: Readonly<Record<string, unknown>> | undefined
}

/**
 * The tools it offers: the hosted server's, but those it leaves out. The board refuses a call without a required argument
 * or with a blank one, and `move_document`'s `folder` may be "" (the top level), so it isn't marked required there: the
 * tool says so itself when it's missing.
 */
export const definitions = (lib: RenderLib): ReadonlyArray<Definition> =>
  lib
    .toolDefinitions()
    .filter((t) => !LEFT_OUT.has(t.name))
    .map((t) => ({ ...t, inputSchema: withoutOrganization(t.inputSchema) }))
    .map((t) => (t.name === "move_document" ? { ...t, inputSchema: { ...t.inputSchema, required: ["slug"] } } : t))

// ---- arguments, read as the hosted server's serde structs read them ----------------------------------------------------

/** serde's description of a JSON value's type, for "invalid type" errors. */
const jsonKind = (v: unknown): string => {
  if (v === null) return "null"
  if (Array.isArray(v)) return "a sequence"
  if (typeof v === "number") return Number.isInteger(v) ? `integer \`${v}\`` : `floating point \`${v}\``
  if (typeof v === "string") return `string ${quoted(v)}`
  if (typeof v === "boolean") return `boolean \`${v}\``
  return "a map"
}

type Read<A> = Result.Result<A, string>
const bad = (v: unknown, expected: string): Read<never> => Result.fail(`invalid arguments: invalid type: ${jsonKind(v)}, expected ${expected}`)

const list = (v: unknown): Read<ReadonlyArray<string>> => {
  if (!Array.isArray(v)) return bad(v, "a sequence")
  const out: Array<string> = []
  for (const x of v) {
    if (typeof x !== "string") return bad(x, "a string")
    out.push(x)
  }
  return Result.succeed(out)
}

/** An agent's arguments, read field by field. */
export const reader = (a: Readonly<Record<string, unknown>>) => ({
  has: (k: string) => a[k] !== undefined,
  str: (k: string): Read<string> => {
    const v = a[k]
    if (v === undefined) return Result.fail(`invalid arguments: missing field \`${k}\``)
    return typeof v === "string" ? Result.succeed(v) : bad(v, "a string")
  },
  optStr: (k: string): Read<string | null> => {
    const v = a[k]
    if (v === undefined || v === null) return Result.succeed(null)
    return typeof v === "string" ? Result.succeed(v) : bad(v, "a string")
  },
  optInt: (k: string): Read<number | null> => {
    const v = a[k]
    if (v === undefined || v === null) return Result.succeed(null)
    return typeof v === "number" && Number.isInteger(v) ? Result.succeed(v) : bad(v, "i64")
  },
  strList: (k: string): Read<ReadonlyArray<string>> => (a[k] === undefined ? Result.succeed([]) : list(a[k])),
  optStrList: (k: string): Read<ReadonlyArray<string> | null> => (a[k] === undefined || a[k] === null ? Result.succeed(null) : list(a[k])),
  seq: (k: string): Read<ReadonlyArray<unknown>> => {
    const v = a[k]
    if (v === undefined || v === null) return Result.succeed([])
    return Array.isArray(v) ? Result.succeed(v) : bad(v, "a sequence")
  },
})

type Reader = ReturnType<typeof reader>

// ---- the server ------------------------------------------------------------------------------------------------------

const prettyJson = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown, { space: 2 }))
const pretty = (v: unknown): string => Result.getOrElse(prettyJson(v), () => String(v))

/** A tool's answer: its JSON (text and `structuredContent`), or its text as it is. */
export const answer = (out: unknown): unknown =>
  typeof out === "string" ? { content: [{ type: "text", text: out }] } : { content: [{ type: "text", text: pretty(out) }], structuredContent: out }
export const failed = (text: string) => ({ content: [{ type: "text", text }], isError: true })

/** The caller as the documents know it. */
export const callerOf = (c: CallContext): Caller => ({ profile: c.profile.id, task: c.task.id, run: c.run_id, project: c.project?.name ?? null })

const read = <A>(r: Read<A>) => Effect.fromResult(r)

type Handle = (caller: Caller, a: Reader) => Effect.Effect<unknown, { readonly message: string } | string>

/** The docs server's tools with their handlers. */
export const docsTools = (lib: RenderLib, docs: Docs): ReadonlyArray<PluginTool> => {
  const handlers: Readonly<Record<string, Handle>> = {
    list_documents: (c, a) => Effect.flatMap(read(a.optStr("label")), (label) => docs.agentList(c, label)),
    get_document: (c, a) =>
      Effect.gen(function* () {
        return yield* docs.agentGet(c, yield* read(a.str("slug")), yield* read(a.optInt("version")))
      }),
    read_page: (c, a) =>
      Effect.gen(function* () {
        return yield* docs.readPage(c, yield* read(a.str("slug")), yield* read(a.str("path")), yield* read(a.optInt("version")))
      }),
    publish_document: (c, a) =>
      Effect.gen(function* () {
        return yield* docs.publish(c, {
          slug: yield* read(a.optStr("slug")),
          title: yield* read(a.optStr("title")),
          folder: yield* read(a.optStr("folder")),
          labels: yield* read(a.optStrList("labels")),
          message: yield* read(a.optStr("message")),
          pages: yield* read(a.seq("pages")),
          mode: (yield* read(a.optStr("mode"))) ?? "replace",
          delete_paths: yield* read(a.strList("delete_paths")),
          images: yield* read(a.seq("images")),
        })
      }),
    move_document: (c, a) =>
      Effect.gen(function* () {
        return yield* docs.agentMove(c, yield* read(a.str("slug")), yield* read(a.str("folder")))
      }),
    set_document_labels: (c, a) =>
      Effect.gen(function* () {
        const slug = yield* read(a.str("document"))
        if (!a.has("labels")) return yield* read(Result.fail("invalid arguments: missing field `labels`"))
        return yield* docs.setLabels(c, slug, yield* read(a.strList("labels")))
      }),
    list_labels: (c) => docs.agentLabels(c),
    get_feedback: (c, a) =>
      Effect.gen(function* () {
        return yield* docs.feedback(c, yield* read(a.str("slug")), yield* read(a.optInt("version")), yield* read(a.optInt("since")))
      }),
    list_components: () => docs.components,
  }

  return definitions(lib).flatMap((d): ReadonlyArray<PluginTool> => {
    const handle = handlers[d.name]
    if (handle === undefined) return []
    const tool = Tool.dynamic(d.name, { description: d.description, parameters: d.inputSchema, success: Schema.Unknown }).annotate(
      Tool.Readonly,
      d.annotations?.["readOnlyHint"] === true,
    )
    return [
      {
        tool,
        run: (args, call) =>
          handle(callerOf(call), reader(args)).pipe(
            Effect.map(answer),
            Effect.catch((e) => Effect.succeed(failed(typeof e === "string" ? e : e.message))),
          ),
      },
    ]
  })
}
