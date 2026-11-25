import { Effect, Schema } from "effect"
import { pluginCall } from "@huntaway/plugin"
import type { PluginCall } from "@huntaway/plugin"
import type { Docs } from "./docs.ts"
import { Comment } from "./repo.ts"
import type { Hosted } from "./hosted.ts"

// What the plugin's pages call (`huntaway.call(method, payload)` in their frames, over the board's `plugins.call`):
// changing documents (and editing them: previews, drafts and saving a version), comments and answers, and the profile's connection to a hosted docs site. All but `doc.preview` and `site.status` need `operate`.

const Where = { profile: Schema.String, slug: Schema.String }
const Ok = Schema.Struct({ ok: Schema.Boolean })
const ok = { ok: true }
const Anything = Schema.Unknown

/** Labels as the page's field gives them: comma-separated. */
const labelsOf = (raw: string) =>
  raw
    .split(",")
    .map((l) => l.trim())
    .filter((l) => l !== "")

export const makeCalls = (docs: Docs, hosted: Hosted): Readonly<Record<string, PluginCall>> => ({
  "doc.labels": pluginCall({
    scope: "operate",
    payload: Schema.Struct({ ...Where, labels: Schema.String }),
    success: Ok,
    handle: ({ profile, slug, labels }) => Effect.as(docs.update(profile, slug, { labels: labelsOf(labels) }), ok),
  }),
  "doc.move": pluginCall({
    scope: "operate",
    payload: Schema.Struct({ ...Where, folder: Schema.String }),
    success: Ok,
    handle: ({ profile, slug, folder }) => Effect.as(docs.update(profile, slug, { folder }), ok),
  }),
  "doc.delete": pluginCall({
    scope: "operate",
    payload: Schema.Struct(Where),
    success: Ok,
    handle: ({ profile, slug }) => Effect.as(docs.delete(profile, slug), ok),
  }),
  "folder.rename": pluginCall({
    scope: "operate",
    payload: Schema.Struct({ profile: Schema.String, from: Schema.String, to: Schema.String }),
    success: Schema.Struct({ moved: Schema.Array(Schema.String) }),
    handle: ({ profile, from, to }) => docs.renameFolder(profile, from, to),
  }),
  "doc.preview": pluginCall({
    scope: "read",
    payload: Schema.Struct({ profile: Schema.String, slug: Schema.NullOr(Schema.String), path: Schema.String, format: Schema.String, content: Schema.String }),
    success: Anything,
    handle: ({ profile, slug, ...page }) => docs.preview(profile, slug, page),
  }),
  "doc.save": pluginCall({
    scope: "operate",
    payload: Schema.Struct({
      profile: Schema.String,
      slug: Schema.NullOr(Schema.String),
      base_version: Schema.NullOr(Schema.Int),
      title: Schema.String,
      folder: Schema.NullOr(Schema.String),
      message: Schema.NullOr(Schema.String),
      pages: Schema.Array(Schema.Unknown),
      images: Schema.Array(Schema.Unknown),
      // From the design editor: only the mockups it changed (the other pages are kept).
      design: Schema.optionalKey(Schema.Boolean),
    }),
    success: Anything,
    handle: ({ profile, ...input }) => docs.save(profile, input),
  }),
  "draft.keep": pluginCall({
    scope: "operate",
    payload: Schema.Struct({ profile: Schema.String, slug: Schema.NullOr(Schema.String), draft: Schema.Unknown, design: Schema.optionalKey(Schema.Boolean) }),
    success: Ok,
    handle: ({ profile, slug, draft, design }) => Effect.as(docs.keepDraft(profile, slug, draft ?? null, design === true), ok),
  }),
  "comment.add": pluginCall({
    scope: "operate",
    payload: Schema.Struct({
      ...Where,
      version: Schema.Int,
      page: Schema.String,
      quote: Schema.String,
      prefix: Schema.String,
      suffix: Schema.String,
      // On a mockup: a CSS selector for the element the comment is on.
      anchor: Schema.optionalKey(Schema.String),
      comment: Schema.String,
    }),
    success: Comment,
    handle: ({ profile, slug, ...c }) => docs.addComment(profile, slug, c),
  }),
  "comment.update": pluginCall({
    scope: "operate",
    payload: Schema.Struct({ ...Where, id: Schema.Int, comment: Schema.String }),
    success: Comment,
    handle: ({ profile, slug, id, comment }) => docs.updateComment(profile, slug, id, comment),
  }),
  "comment.delete": pluginCall({
    scope: "operate",
    payload: Schema.Struct({ ...Where, id: Schema.Int }),
    success: Ok,
    handle: ({ profile, slug, id }) => Effect.as(docs.deleteComment(profile, slug, id), ok),
  }),
  "answer.save": pluginCall({
    scope: "operate",
    payload: Schema.Struct({ ...Where, version: Schema.Int, page: Schema.String, field: Schema.String, value: Schema.Unknown }),
    success: Schema.Struct({ saved_at: Schema.String, unsent_answers: Schema.Int }),
    handle: ({ profile, slug, ...a }) => docs.saveAnswer(profile, slug, a),
  }),
  "feedback.send": pluginCall({
    scope: "operate",
    payload: Schema.Struct(Where),
    success: Schema.Struct({
      comments: Schema.Int,
      answers: Schema.Int,
      task: Schema.Struct({ id: Schema.String, key: Schema.String, title: Schema.String }),
    }),
    handle: ({ profile, slug }) => docs.sendFeedback(profile, slug),
  }),
  "site.status": pluginCall({
    scope: "read",
    payload: Schema.Struct({ profile: Schema.String }),
    success: Anything,
    handle: ({ profile }) => Effect.andThen(docs.profileOf(profile), hosted.status(profile)),
  }),
  "site.start": pluginCall({
    scope: "operate",
    payload: Schema.Struct({ profile: Schema.String, site: Schema.String }),
    success: Anything,
    handle: ({ profile, site }) => Effect.andThen(docs.profileOf(profile), hosted.startDevice(profile, site)),
  }),
  "site.cancel": pluginCall({
    scope: "operate",
    payload: Schema.Struct({ profile: Schema.String }),
    success: Anything,
    handle: ({ profile }) => hosted.cancelDevice(profile),
  }),
  "site.token": pluginCall({
    scope: "operate",
    payload: Schema.Struct({ profile: Schema.String, site: Schema.String, token: Schema.String }),
    success: Anything,
    handle: ({ profile, site, token }) => Effect.andThen(docs.profileOf(profile), hosted.connectToken(profile, site, token)),
  }),
  "site.disconnect": pluginCall({
    scope: "operate",
    payload: Schema.Struct({ profile: Schema.String }),
    success: Anything,
    handle: ({ profile }) => hosted.disconnect(profile),
  }),
  "site.publish": pluginCall({
    scope: "operate",
    payload: Schema.Struct({ ...Where, version: Schema.Int, remote_slug: Schema.String, confirmed: Schema.optionalKey(Schema.Boolean) }),
    success: Anything,
    handle: ({ profile, slug, version, remote_slug, confirmed }) =>
      Effect.flatMap(docs.docOf(profile, slug), (d) => hosted.publish(profile, d, version, { slug: remote_slug, ask: confirmed !== true })),
  }),
})
