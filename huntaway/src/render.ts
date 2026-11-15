import { Effect, Schema } from "effect"
import type * as Lib from "@dire-kiwi/docs-render"

// The hosted site's renderer as WebAssembly (`@dire-kiwi/docs-render`, built from crates/docs-render-wasm): Markdown and
// MDX to sanitized HTML, page paths, folders, labels and menus, the checks `publish_document` runs, the components'
// reference and the hosted MCP server's tool definitions. The same Rust code the site runs, so a page renders, and a
// publish is accepted or refused, here exactly as there.

/** The renderer's functions. */
export type RenderLib = typeof Lib

/** What the renderer refused, in its own words (it throws its messages as strings: the hosted server's). */
export class RenderError extends Schema.TaggedError<RenderError>()("RenderError", { message: Schema.String }) {}

/** A thrown value as the renderer's message. */
export const renderMessage = (e: unknown): string => (typeof e === "string" ? e : e instanceof Error ? e.message : String(e))

/** One of the renderer's calls, its throw as a `RenderError`. */
export const rendered = <A>(f: () => A): Effect.Effect<A, RenderError> => Effect.try({ try: f, catch: (e) => new RenderError({ message: renderMessage(e) }) })

/** The renderer, loaded (about 1.7 MB of WebAssembly) the first time something needs it. */
export const loadRenderer: Effect.Effect<Effect.Effect<RenderLib>> = Effect.cached(Effect.promise(() => import("@dire-kiwi/docs-render")))
