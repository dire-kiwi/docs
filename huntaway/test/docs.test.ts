import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import sharp from "sharp"
import { loadRenderer } from "../src/render.ts"
import { definitions } from "../src/tools.ts"
import { BOARD, call, OTHER, TASK, withHarness } from "./harness.ts"

// The docs plugin's MCP server, as an agent on the board uses it: the hosted server's tools, arguments, checks,
// answers and messages, over the plugin's own database.

const png = (width: number, height: number) =>
  Effect.promise(() =>
    sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } })
      .png()
      .toBuffer()
      .then((b) => b.toString("base64")),
  )

const plan = {
  title: "The plan",
  message: "First draft",
  pages: [
    { path: "index", content: "# The plan\n\nSee [phase 1](plan/phase-1.md)." },
    { path: "plan/phase-1", content: "# Phase 1\n\nBack to [the overview](../index.md)." },
  ],
}

describe("publish_document", () => {
  it.effect("makes a document in its project's folder, with its pages, and answers with the board's URLs", () =>
    withHarness({}, (h) =>
      Effect.gen(function* () {
        const out = yield* h.ok("publish_document", plan)
        assert.strictEqual(out.slug, "the-plan")
        assert.strictEqual(out.folder, "Docs")
        assert.strictEqual(out.version, 1)
        assert.strictEqual(out.url, `${BOARD}/docs/p1/d/the-plan/`)
        assert.strictEqual(out.version_url, `${BOARD}/docs/p1/d/the-plan/-/v/1/`)
        assert.deepStrictEqual(
          out.pages.map((p: { path: string; url: string }) => [p.path, p.url]),
          [
            ["index", `${BOARD}/docs/p1/d/the-plan/`],
            ["plan/phase-1", `${BOARD}/docs/p1/d/the-plan/plan/phase-1`],
          ],
        )
        assert.deepStrictEqual(out.warnings, [])
        assert.strictEqual(out.note, null)
        // The board is told, and its pages show it again.
        assert.deepStrictEqual(h.events.at(-1), { topic: "documents", profile_id: "p1", data: { slug: "the-plan", deleted: false }, reload: true })
      }),
    ),
  )

  it.effect("adds versions, merges pages and keeps a document where the user moved it", () =>
    withHarness({}, (h) =>
      Effect.gen(function* () {
        yield* h.ok("publish_document", plan)
        yield* h.ok("move_document", { slug: "the-plan", folder: "" })
        const merged = yield* h.ok("publish_document", {
          slug: "the-plan",
          mode: "merge",
          folder: "Docs/plans",
          pages: [{ path: "plan/phase-2", content: "# Phase 2" }],
        })
        assert.strictEqual(merged.version, 2)
        assert.strictEqual(merged.folder, "")
        assert.strictEqual(merged.note, 'The document stays in its folder ""; call move_document only if the user asks to move it.')
        assert.deepStrictEqual(
          merged.pages.map((p: { path: string }) => p.path),
          // By position (each page's in its own publish), then path.
          ["index", "plan/phase-2", "plan/phase-1"],
        )
        const got = yield* h.ok("get_document", { slug: "the-plan" })
        assert.strictEqual(got.latest_version, 2)
        assert.deepStrictEqual(
          got.versions.map((v: { number: number; message: string | null; task_id: string }) => [v.number, v.message, v.task_id]),
          [
            [2, null, "t1"],
            [1, "First draft", "t1"],
          ],
        )
        const old = yield* h.ok("read_page", { slug: "the-plan", path: "plan/phase-1", version: 1 })
        assert.strictEqual(old.content, "# Phase 1\n\nBack to [the overview](../index.md).")
        assert.strictEqual(old.url, `${BOARD}/docs/p1/d/the-plan/-/v/1/plan/phase-1`)
        const replaced = yield* h.ok("publish_document", { slug: "the-plan", pages: [{ path: "index", content: "# Only" }] })
        assert.deepStrictEqual(
          replaced.pages.map((p: { path: string }) => p.path),
          ["index"],
        )
      }),
    ),
  )

  it.effect("refuses what the hosted server refuses, in its words", () =>
    withHarness({}, (h) =>
      Effect.gen(function* () {
        assert.strictEqual(yield* h.refused("publish_document", { pages: [] }), "pass at least one page")
        assert.strictEqual(yield* h.refused("publish_document", { pages: [{ path: "index", content: "x" }], mode: "append" }), 'mode must be "replace" or "merge", not "append"')
        assert.strictEqual(yield* h.refused("publish_document", { pages: "index" }), 'invalid arguments: invalid type: string "index", expected a sequence')
        assert.match(yield* h.refused("publish_document", { pages: [{ path: "index", content: "<Callout>" }], format: "mdx" }), /page "index" is not valid mdx/)
        assert.match(
          yield* h.refused("publish_document", {
            pages: [
              { path: "a", content: "x" },
              { path: "./a.md", content: "y" },
            ],
          }),
          /page "a" is listed twice/,
        )
        assert.strictEqual(yield* h.refused("get_document", { slug: "nope" }), 'no document "nope"; call list_documents to see what exists')
        assert.strictEqual(yield* h.refused("get_document", {}), "invalid arguments: missing field `slug`")
        assert.strictEqual(yield* h.refused("move_document", { slug: "nope" }), "invalid arguments: missing field `folder`")
      }),
    ),
  )

  it.effect("warns of an unknown component and an image the version doesn't have", () =>
    withHarness({}, (h) =>
      Effect.gen(function* () {
        const out = yield* h.ok("publish_document", { pages: [{ path: "index.mdx", content: "# Hi\n\n<Nope />\n\n![x](images/missing.png)" }] })
        assert.deepStrictEqual(
          out.warnings.map((w: { page: string }) => w.page),
          ["index", "index"],
        )
        assert.match(out.warnings[1].warning, /image "images\/missing.png" isn't one of this version's images/)
      }),
    ),
  )
})

describe("images", () => {
  it.effect("are converted to AVIF, kept once, shown on the board as data: URLs, and kept by a merge that still shows them", () =>
    withHarness({}, (h) =>
      Effect.gen(function* () {
        const data = yield* png(40, 30)
        const out = yield* h.ok("publish_document", {
          slug: "pics",
          pages: [
            { path: "index", content: "# Pics\n\n![Chart](images/chart.png)\n\n![Inline](data:image/png;base64," + data + ")" },
            { path: "other", content: "# Other" },
          ],
          images: [{ name: "./images/chart.png", data }],
        })
        assert.deepStrictEqual(
          out.images.map((im: { name: string; width: number; height: number }) => [im.name.replace(/[0-9a-f]{16}/, "<hash>"), im.width, im.height]),
          [
            ["images/chart.png", 40, 30],
            ["images/inline-<hash>.avif", 40, 30],
          ],
        )
        const source = (yield* h.ok("read_page", { slug: "pics", path: "index" })).content as string
        assert.match(source, /!\[Inline\]\(images\/inline-[0-9a-f]{16}\.avif\)/)
        // The same bytes, once.
        const stored = yield* h.sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM doc_images`
        assert.strictEqual(stored[0]?.n, 1)
        const page = yield* h.page("p1/d/pics/")
        assert.match(page.html, /<img src="data:image\/avif;base64,/)
        // A page carries only the images it shows.
        assert.notInclude((yield* h.page("p1/d/pics/other")).html, "data:image/avif")
        // A merge that changes another page keeps them; one that drops the page that shows them doesn't.
        const merged = yield* h.ok("publish_document", { slug: "pics", mode: "merge", pages: [{ path: "other", content: "# Other 2" }] })
        assert.strictEqual(merged.images.length, 2)
        const dropped = yield* h.ok("publish_document", { slug: "pics", mode: "merge", delete_paths: ["index"], pages: [] })
        assert.strictEqual(dropped.images.length, 0)
      }),
    ),
  )

  it.effect("refuses SVG, bad base64 and an image too big as AVIF", () =>
    withHarness({}, (h) =>
      Effect.gen(function* () {
        const page = [{ path: "index", content: "# x" }]
        assert.strictEqual(
          yield* h.refused("publish_document", { pages: page, images: [{ name: "a.svg", data: Buffer.from("<svg></svg>").toString("base64") }] }),
          'image "a.svg" is SVG, which isn\'t supported: images must be PNG, JPEG, WebP, GIF or AVIF',
        )
        assert.strictEqual(yield* h.refused("publish_document", { pages: page, images: [{ name: "a.png", data: "!!" }] }), 'image "a.png" isn\'t valid base64')
        // Noise doesn't compress: 1200x1200 of it is well over 500 KB as AVIF.
        const noise = Buffer.alloc(1200 * 1200 * 3)
        for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 256)
        const big = (yield* Effect.promise(() => sharp(noise, { raw: { width: 1200, height: 1200, channels: 3 } }).png().toBuffer())).toString("base64")
        assert.match(yield* h.refused("publish_document", { pages: page, images: [{ name: "big.png", data: big }] }), /^image "big.png" is \d+ bytes after conversion to AVIF, over the limit of 512000 bytes/)
      }),
    ),
  )
})

describe("labels and lists", () => {
  it.effect("label documents as the hosted site does, and list them by label", () =>
    withHarness({}, (h) =>
      Effect.gen(function* () {
        yield* h.ok("publish_document", { ...plan, labels: ["Research / AI", "plans"] })
        yield* h.ok("publish_document", { title: "Notes", pages: [{ path: "index", content: "# Notes" }] })
        const set = yield* h.ok("set_document_labels", { document: "notes", labels: ["research/ml", "PLANS"] })
        // Spelt as the profile spells them already.
        assert.deepStrictEqual(set.labels, ["plans", "Research/ml"])
        const listed = yield* h.ok("list_documents", { label: "research" })
        assert.deepStrictEqual(
          listed.documents.map((d: { slug: string }) => d.slug).toSorted(),
          ["notes", "the-plan"],
        )
        const tree = yield* h.ok("list_labels", {})
        assert.deepStrictEqual(tree, {
          labels: [
            { name: "plans", path: "plans", documents: 2, children: [] },
            {
              name: "Research",
              path: "Research",
              documents: 2,
              children: [
                { name: "AI", path: "Research/AI", documents: 1, children: [] },
                { name: "ml", path: "Research/ml", documents: 1, children: [] },
              ],
            },
          ],
          documents: 2,
          unlabelled: 0,
        })
        assert.strictEqual(yield* h.refused("set_document_labels", { document: "notes", labels: [""] }), 'invalid label "": a label can\'t be empty')
      }),
    ),
  )

  it.effect("list_components is the renderer's reference, and share_document and organizations aren't offered", () =>
    withHarness({}, (h) =>
      Effect.gen(function* () {
        assert.match((yield* h.tool("list_components", {})).text, /Callout/)
        const names = h.parts.mcp?.tools.map((t) => t.tool.name)
        assert.deepStrictEqual(names, [
          "list_documents",
          "get_document",
          "read_page",
          "publish_document",
          "move_document",
          "set_document_labels",
          "list_labels",
          "get_feedback",
          "list_components",
        ])
        for (const d of definitions(yield* yield* loadRenderer)) {
          assert.notProperty(d.inputSchema["properties"] ?? {}, "organization", d.name)
        }
        assert.strictEqual(h.parts.mcp?.preApproved, true)
      }),
    ),
  )
})

describe("comments", () => {
  it.effect("are left on a version's page, read with get_feedback, and sent to the task that published it", () =>
    withHarness({}, (h) =>
      Effect.gen(function* () {
        yield* h.ok("publish_document", plan)
        yield* h.ok("publish_document", { slug: "the-plan", mode: "merge", pages: [{ path: "plan/phase-2", content: "# Phase 2" }] }, call(OTHER, 2))
        const where = { profile: "p1", slug: "the-plan" }
        const c = yield* h.call("comment.add", { ...where, version: 1, page: "index", quote: "phase 1", prefix: "See ", suffix: ".", comment: " Too vague " })
        assert.strictEqual(c.comment, "Too vague")
        assert.strictEqual(c.version, 1)
        yield* h.call("comment.add", { ...where, version: 1, page: "index", quote: "The plan", prefix: "", suffix: "", comment: "" })
        const fb = yield* h.ok("get_feedback", { slug: "the-plan" })
        assert.deepStrictEqual(
          fb.selections.map((s: { quote: string; comment: string; context_before: string }) => [s.quote, s.comment, s.context_before]),
          [
            ["phase 1", "Too vague", "See "],
            ["The plan", "", ""],
          ],
        )
        assert.deepStrictEqual(fb.responses, [])
        const later = yield* h.ok("get_feedback", { slug: "the-plan", since: fb.cursor + 10 })
        assert.deepStrictEqual(later.selections, [])

        // To the newest version's task: DOC-2.
        const sent = yield* h.call("feedback.send", where)
        assert.deepStrictEqual(sent, { comments: 2, answers: 0, task: { id: "t2", key: "DOC-2", title: "Something else" } })
        assert.strictEqual(h.sent.length, 1)
        assert.strictEqual(h.sent[0]?.task, "t2")
        assert.include(h.sent[0]?.text ?? "", 'The user left 2 comments on the document "The plan" (slug `the-plan`):')
        assert.include(h.sent[0]?.text ?? "", `1. On version 1, page \`index\` (${BOARD}/docs/p1/d/the-plan/-/v/1/):\n\n> phase 1\n\nToo vague`)
        assert.include(h.sent[0]?.text ?? "", "(No comment: just the quote.)")
        const again = yield* Effect.flip(h.call("feedback.send", where))
        assert.strictEqual(again.message, "every comment and answer has been sent already")

        // Editing one makes it unsent; deleting one is gone.
        const edited = yield* h.call("comment.update", { ...where, id: c.id, comment: "Clearer now?" })
        assert.strictEqual(edited.sent_at, null)
        yield* h.call("comment.delete", { ...where, id: c.id })
        assert.strictEqual((yield* h.ok("get_feedback", { slug: "the-plan" })).selections.length, 1)
        const missing = yield* Effect.flip(h.call("comment.add", { ...where, version: 1, page: "nope", quote: "x", prefix: "", suffix: "", comment: "" }))
        assert.strictEqual(missing.reason, "not_found")
      }),
    ),
  )
})

describe("answers", () => {
  const form = {
    title: "Questions",
    pages: [
      {
        path: "index",
        format: "mdx",
        content: '# Questions\n\n<Select name="db" label="Which database?" options={["SQLite", "Postgres"]} />\n\n<TextArea name="notes" label="Anything else?" />\n\n<Approval />',
      },
    ],
  }
  it.effect("are saved for a version's page, shown in it, read with get_feedback, and sent to the task", () =>
    withHarness({}, (h) =>
      Effect.gen(function* () {
        yield* h.ok("publish_document", form)
        const where = { profile: "p1", slug: "questions", version: 1, page: "index" }
        const first = yield* h.call("answer.save", { ...where, field: "notes", value: "Keep it small" })
        assert.strictEqual(first.unsent_answers, 1)
        yield* h.call("answer.save", { ...where, field: "db", value: "SQLite" })
        // A newer answer replaces the older one.
        const third = yield* h.call("answer.save", { ...where, field: "db", value: "Postgres" })
        assert.strictEqual(third.unsent_answers, 2)
        assert.isTrue(h.events.some((e) => e.topic === "answers"))

        // The page shows them, and tells its script how many are unsent.
        const page = yield* h.page("p1/d/questions/")
        assert.match(page.html, /<option value="Postgres" selected/)
        assert.include(page.html, "Keep it small</textarea>")
        assert.include(page.html, '"unsent_answers":2')

        const fb = yield* h.ok("get_feedback", { slug: "questions" })
        assert.deepStrictEqual(
          fb.responses.map((r: { field: string; label: string; value: unknown; version: number; page: string }) => [r.version, r.page, r.field, r.label, r.value]),
          [
            [1, "index", "db", "Which database?", "Postgres"],
            [1, "index", "notes", "Anything else?", "Keep it small"],
          ],
        )

        // Sent in the order the fields are on the page.
        const sent = yield* h.call("feedback.send", { profile: "p1", slug: "questions" })
        assert.deepStrictEqual(sent, { comments: 0, answers: 2, task: { id: "t1", key: "DOC-1", title: "Write the plan" } })
        const text = h.sent[0]?.text ?? ""
        assert.include(text, 'The user answered 2 questions on the document "Questions" (slug `questions`):')
        assert.include(
          text,
          `On version 1, page \`index\` (${BOARD}/docs/p1/d/questions/-/v/1/):\n\n- Which database? (\`db\`): "Postgres"\n- Anything else? (\`notes\`): "Keep it small"`,
        )
        assert.strictEqual((yield* h.page("p1/d/questions/")).html.includes('"unsent_answers":0'), true)

        // Changing an answer makes it unsent again; with a comment, both go in one message.
        const changed = yield* h.call("answer.save", { ...where, field: "approval", value: { decision: "approve", comment: "Go" } })
        assert.strictEqual(changed.unsent_answers, 1)
        yield* h.call("comment.add", { profile: "p1", slug: "questions", version: 1, page: "index", quote: "Questions", prefix: "", suffix: "", comment: "Nice" })
        assert.deepStrictEqual(yield* h.call("feedback.send", { profile: "p1", slug: "questions" }), {
          comments: 1,
          answers: 1,
          task: { id: "t1", key: "DOC-1", title: "Write the plan" },
        })
        const both = h.sent[1]?.text ?? ""
        assert.include(both, "The user left a comment and answered a question on the document")
        assert.include(both, '- Do you approve this? (`approval`): {"decision":"approve","comment":"Go"}')

        // Only the page's fields, and not too much.
        const unknown = yield* Effect.flip(h.call("answer.save", { ...where, field: "nope", value: "x" }))
        assert.strictEqual(unknown.message, 'page has no field "nope"')
        const long = yield* Effect.flip(h.call("answer.save", { ...where, field: "notes", value: "x".repeat(100_001) }))
        assert.strictEqual(long.message, "answer is too long")
        const noPage = yield* Effect.flip(h.call("answer.save", { ...where, page: "nope", field: "db", value: "x" }))
        assert.strictEqual(noPage.reason, "not_found")
      }),
    ),
  )
})

describe("the board's documents", () => {
  it.effect("are copied from the board the first time the plugin runs", () =>
    withHarness(
      {
        board: {
          docs: [{ id: "d1", profile_id: "p1", slug: "old", title: "Old doc", folder: "Archive", created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-02T00:00:00.000Z" }],
          doc_versions: [{ id: "v1", doc_id: "d1", number: 1, message: "first", task_id: "t1", run_id: null, created_at: "2026-11-01T00:00:00.000Z" }],
          doc_pages: [{ version_id: "v1", path: "index", title: "Old doc", format: "md", source: "# Old doc\n\nKept.", position: 0 }],
          doc_labels: [{ doc_id: "d1", label: "history" }],
          doc_comments: [
            {
              id: 7,
              version_id: "v1",
              page_path: "index",
              quote: "Kept",
              prefix: "",
              suffix: ".",
              comment: "Good",
              created_at: "2026-11-03T00:00:00.000Z",
              updated_at: "2026-11-03T00:00:00.000Z",
              sent_at: null,
              some_new_column: "ignored",
            },
          ],
          docs_site_connections: [],
        },
      },
      (h) =>
        Effect.gen(function* () {
          const listed = yield* h.ok("list_documents", {})
          assert.deepStrictEqual(listed.documents, [
            {
              slug: "old",
              title: "Old doc",
              folder: "Archive",
              labels: ["history"],
              url: `${BOARD}/docs/p1/d/old/`,
              latest_version: 1,
              pages: 1,
              updated_at: "2026-11-02T00:00:00.000Z",
            },
          ])
          assert.strictEqual((yield* h.ok("get_feedback", { slug: "old" })).selections[0].comment, "Good")
          // New comments don't take a copied one's id.
          const c = yield* h.call("comment.add", { profile: "p1", slug: "old", version: 1, page: "index", quote: "Old", prefix: "", suffix: "", comment: "" })
          assert.strictEqual(c.id, 8)
        }),
    ),
  )
})

describe("pages", () => {
  it.effect("show a profile's documents by folder and label, and a document with its menu, versions and comments", () =>
    withHarness({}, (h) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* h.page(""), { _tag: "Redirect", path: "p1" })
        yield* h.ok("publish_document", { ...plan, labels: ["plans"] })
        yield* h.ok("publish_document", { title: "<script>alert(1)</script>", folder: "", pages: [{ path: "index", content: "# Hi" }] })

        const home = yield* h.page("p1")
        assert.strictEqual(home.title, "Docs · Ivan")
        assert.include(home.html, 'href="/docs/p1/d/the-plan/"')
        assert.include(home.html, '<span class="folder-name">Docs</span>')
        assert.include(home.html, '<a class="small" href="/t/t1">DOC-1</a>')
        assert.include(home.html, "&lt;script&gt;alert(1)&lt;/script&gt;")
        assert.notInclude(home.html, "<script>alert(1)")
        assert.include(home.html, "Connect to hosted docs")
        const labels = yield* h.page("p1/labels/plans")
        assert.include(labels.html, "the-plan")
        assert.notInclude(labels.html, "script-alert")

        yield* h.call("comment.add", { profile: "p1", slug: "the-plan", version: 1, page: "plan/phase-1", quote: "Phase 1", prefix: "", suffix: "", comment: "Hm" })
        const doc = yield* h.page("p1/d/the-plan/plan/phase-1")
        assert.strictEqual(doc.title, "Phase 1 · The plan")
        // Links between pages are the board's paths.
        assert.include(doc.html, 'href="/docs/p1/d/the-plan/"')
        assert.include(doc.html, 'class="comment-bubble" data-id="1" data-quote="Phase 1"')
        assert.include(doc.html, '"unsent":1')
        assert.include(doc.html, '"task":{"id":"t1","key":"DOC-1","title":"Write the plan"}')
        assert.include(doc.html, '"path":"plan/phase-1"')
        // The reader's styles and the page script are in it.
        assert.include(doc.html, "@scope (.docs-render)")
        assert.include(doc.html, "comment-popup")

        yield* h.ok("publish_document", { slug: "the-plan", pages: [{ path: "index", content: "# v2" }] })
        const old = yield* h.page("p1/d/the-plan/-/v/1/plan/phase-1")
        assert.include(old.html, "This is version 1.")
        const gone = yield* Effect.flip(h.page("p1/d/the-plan/plan/phase-1"))
        assert.strictEqual(gone.message, 'version 2 has no page "plan/phase-1"')
        assert.strictEqual((yield* Effect.flip(h.page("p1/d/nope/"))).reason, "not_found")
        assert.strictEqual((yield* Effect.flip(h.page("p9"))).reason, "not_found")
      }),
    ),
  )

  it.effect("show a task the documents it published, and nothing for one that published none", () =>
    withHarness({}, (h) =>
      Effect.gen(function* () {
        yield* h.ok("publish_document", plan)
        yield* h.ok("publish_document", { slug: "the-plan", pages: [{ path: "index", content: "# 2" }] })
        const panel = yield* h.task(TASK.id)
        assert.include(panel.html, "The plan")
        assert.include(panel.html, "v2")
        assert.deepStrictEqual(yield* h.task(OTHER.id), { _tag: "Html", title: null, html: "", empty: true })
        const settings = yield* h.settings
        assert.include(settings.html, "1 document")
      }),
    ),
  )

  it.effect("move, relabel, rename folders and delete documents for the user", () =>
    withHarness({}, (h) =>
      Effect.gen(function* () {
        yield* h.ok("publish_document", plan)
        yield* h.call("doc.labels", { profile: "p1", slug: "the-plan", labels: "a, b/c ,," })
        yield* h.call("doc.move", { profile: "p1", slug: "the-plan", folder: " Docs//plans/ " })
        let got = yield* h.ok("get_document", { slug: "the-plan" })
        assert.deepStrictEqual([got.folder, got.labels], ["Docs/plans", ["a", "b/c"]])
        assert.deepStrictEqual(yield* h.call("folder.rename", { profile: "p1", from: "Docs", to: "Work/Docs" }), { moved: ["the-plan"] })
        got = yield* h.ok("get_document", { slug: "the-plan" })
        assert.strictEqual(got.folder, "Work/Docs/plans")
        assert.strictEqual((yield* Effect.flip(h.call("doc.move", { profile: "p1", slug: "the-plan", folder: "../x" }))).reason, "invalid")
        yield* h.call("doc.delete", { profile: "p1", slug: "the-plan" })
        assert.deepStrictEqual((yield* h.ok("list_documents", {})).documents, [])
        assert.deepStrictEqual(h.events.at(-1), { topic: "documents", profile_id: "p1", data: { slug: "the-plan", deleted: true }, reload: true })
      }),
    ),
  )
})

/** The state a page gives its script (`window.DOCS`). */
const stateOf = (html: string): any => {
  const m = /<script>window\.DOCS=(.*?)<\/script>/s.exec(html)
  if (m === null) throw new Error("no state in the page")
  return JSON.parse(m[1] ?? "null")
}

describe("the editor", () => {
  it.effect("edits a document's pages and saves them as a new version, keeping the images they use", () =>
    withHarness({}, (h) =>
      Effect.gen(function* () {
        const chart = yield* png(30, 20)
        yield* h.ok("publish_document", {
          ...plan,
          pages: [...plan.pages, { path: "old", content: "# Old\n\n![chart](images/chart.png)" }, { path: "pics", content: "![chart](images/chart.png)" }],
          images: [{ name: "images/chart.png", data: chart }],
        })
        // The document's page links to the editor, which opens at that page with every page's source.
        const doc = (yield* h.page("p1/d/the-plan/plan/phase-1")).html
        assert.include(doc, `href="/docs/p1/d/the-plan/-/edit/plan/phase-1"`)
        const editor = stateOf((yield* h.page("p1/d/the-plan/-/edit/plan/phase-1")).html)
        assert.strictEqual(editor.page, "edit")
        assert.strictEqual(editor.slug, "the-plan")
        assert.strictEqual(editor.editor.open, "plan/phase-1")
        assert.strictEqual(editor.editor.baseVersion, 1)
        assert.deepStrictEqual(editor.editor.images, ["images/chart.png"])
        assert.deepStrictEqual(
          editor.editor.pages.map((p: { path: string }) => p.path),
          ["index", "plan/phase-1", "old", "pics"],
        )
        assert.strictEqual(editor.editor.cancelUrl, "/docs/p1/d/the-plan/plan/phase-1")
        assert.strictEqual(stateOf((yield* h.page("p1/d/the-plan/-/edit/")).html).editor.open, "index")

        // The preview renders a page as it would be, with the document's images, storing nothing.
        const where = { profile: "p1", slug: "the-plan" }
        const shown = yield* h.call("doc.preview", { ...where, path: "pics", format: "mdx", content: "# Pics\n\n![c](images/chart.png)\n\n<Callout>Hi</Callout>" })
        assert.strictEqual(shown.has_h1, true)
        assert.include(shown.html, "data:image/avif;base64,")
        assert.include(shown.html, "callout")
        const broken = yield* h.call("doc.preview", { ...where, path: "x", format: "mdx", content: "<Callout>\n\nunclosed" })
        assert.strictEqual(broken.html, null)
        assert.include(broken.error, "isn't valid mdx")

        // Saving: pages reordered and renamed, one removed, one new with an uploaded image.
        const photo = yield* png(10, 10)
        const save = {
          ...where,
          base_version: 1,
          title: "The new plan",
          folder: null,
          message: "By hand",
          pages: [
            { path: "plan/phase-1", title: "Phase one", format: "md", content: "# Phase 1\n\nRewritten." },
            { path: "index", title: null, format: "md", content: "# The plan" },
            { path: "pics", title: null, format: "md", content: "![chart](images/chart.png)" },
            { path: "photos", title: null, format: "md", content: "![p](images/photo.png)" },
          ],
          images: [{ name: "images/photo.png", data: photo }],
        }
        const saved = yield* h.call("doc.save", save)
        assert.deepStrictEqual(saved, { slug: "the-plan", version: 2, url: "/docs/p1/d/the-plan/", warnings: [] })
        const got = yield* h.ok("get_document", { slug: "the-plan" })
        assert.strictEqual(got.title, "The new plan")
        assert.deepStrictEqual(
          got.pages.map((p: { path: string }) => p.path),
          ["plan/phase-1", "index", "pics", "photos"],
          "in the editor's order, without the page it removed",
        )
        assert.strictEqual(got.pages[0].title, "Phase one")
        assert.deepStrictEqual(
          got.images.map((i: { name: string }) => i.name).toSorted(),
          ["images/chart.png", "images/photo.png"],
        )
        const v2 = got.versions.find((v: { number: number }) => v.number === 2)
        assert.strictEqual(v2.message, "By hand")
        assert.strictEqual(v2.task_id, null)
        assert.include((yield* h.page("p1/d/the-plan/pics")).html, "data:image/avif;base64,")

        // A version published since the editor opened: nothing is saved, and the editor is told which is the latest.
        const conflict = yield* h.call("doc.save", save)
        assert.deepStrictEqual(conflict, { conflict: 2, message: "Version 2 was published while you were editing." })
        const invalid = yield* Effect.flip(h.call("doc.save", { ...save, base_version: 2, pages: [{ path: "index", format: "mdx", content: "<Callout>\n\nunclosed" }] }))
        assert.strictEqual(invalid.reason, "invalid")
        const untitled = yield* Effect.flip(h.call("doc.save", { ...save, base_version: 2, title: "  " }))
        assert.strictEqual(untitled.message, "give the document a title")
        assert.strictEqual((yield* h.ok("get_document", { slug: "the-plan" })).latest_version, 2)

        // Unsaved changes are kept as a draft, which the editor gets back when the page is reloaded; saving drops it.
        const draft = { baseVersion: 2, title: "Draft title", pages: [{ path: "index", title: "", format: "md", content: "Half done" }] }
        yield* h.call("draft.keep", { ...where, draft })
        assert.deepStrictEqual(stateOf((yield* h.page("p1/d/the-plan/-/edit/")).html).draft, draft)
        assert.deepStrictEqual(stateOf((yield* h.page("p1/new")).html).draft, null, "a new document's draft is another")
        yield* h.call("doc.save", { ...save, base_version: 2 })
        assert.strictEqual(stateOf((yield* h.page("p1/d/the-plan/-/edit/")).html).draft, null)
        yield* h.call("draft.keep", { ...where, draft })
        yield* h.call("draft.keep", { ...where, draft: null })
        assert.strictEqual(stateOf((yield* h.page("p1/d/the-plan/-/edit/")).html).draft, null)
        yield* h.call("draft.keep", { ...where, draft })
        yield* h.call("doc.delete", where)
        const count = yield* h.sql<{ n: number }>`SELECT COUNT(*) AS n FROM doc_drafts`
        assert.strictEqual(count[0]?.n, 0, "deleting the document deletes its draft")
      }),
    ),
  )

  it.effect("writes a new document in a folder", () =>
    withHarness({}, (h) =>
      Effect.gen(function* () {
        assert.include((yield* h.page("p1")).html, `href="/docs/p1/new"`)
        const editor = stateOf((yield* h.page("p1/new", { folder: " notes/ideas " })).html).editor
        assert.strictEqual(editor.isNew, true)
        assert.strictEqual(editor.folder, "notes/ideas")
        assert.strictEqual(editor.cancelUrl, "/docs/p1")
        yield* h.call("draft.keep", { profile: "p1", slug: null, draft: { title: "My no" } })
        assert.deepStrictEqual(stateOf((yield* h.page("p1/new")).html).draft, { title: "My no" })
        const saved = yield* h.call("doc.save", {
          profile: "p1",
          slug: null,
          base_version: null,
          title: "My notes",
          folder: editor.folder,
          message: null,
          pages: [{ path: "index", title: null, format: "md", content: "Hello" }],
          images: [],
        })
        assert.strictEqual(saved.url, "/docs/p1/d/my-notes/")
        assert.strictEqual(stateOf((yield* h.page("p1/new")).html).draft, null, "saved, the new document's draft is gone")
        const got = yield* h.ok("get_document", { slug: "my-notes" })
        assert.strictEqual(got.title, "My notes")
        assert.strictEqual(got.folder, "notes/ideas")
      }),
    ),
  )
})

describe("mockups", () => {
  const home =
    '<!doctype html>\n<html><head><title>Home</title><style>:root { --accent: #d9480f } .hero { background: url(images/hero.png) }</style></head>\n' +
    '<body><img src="../images/logo.png" alt=""><h1>Hello</h1><a class="cta" href="/signup">Start</a><script>alert(1)</script></body></html>'

  it.effect("are html pages, which open in the design editor with their images, and are commented on by element", () =>
    withHarness({}, (h) =>
      Effect.gen(function* () {
        const logo = yield* png(16, 16)
        const published = yield* h.ok("publish_document", {
          slug: "kea",
          title: "Kea",
          pages: [
            { path: "index", content: "# Notes\n\nSee the screens." },
            { path: "screens/home.html", content: home },
            { path: "screens/sign-in", format: "html", content: "<main><h1>Sign in</h1></main>" },
          ],
          images: [
            { name: "images/logo.png", data: logo },
            { name: "screens/images/hero.png", data: logo },
          ],
        })
        assert.deepStrictEqual(
          published.warnings.map((w: { page: string }) => w.page),
          ["screens/home"],
          "its scripts don't run, which its publisher is told",
        )
        const got = yield* h.ok("get_document", { slug: "kea" })
        assert.deepStrictEqual(
          got.pages.map((p: { path: string; format: string; title: string }) => [p.path, p.format, p.title]),
          [
            ["index", "md", "Notes"],
            ["screens/home", "html", "Home"],
            ["screens/sign-in", "html", "Sign In"],
          ],
        )
        const read = yield* h.ok("read_page", { slug: "kea", path: "screens/home.html" })
        assert.strictEqual(read.content, home)
        assert.strictEqual(read.format, "html")

        // A mockup's page is the design editor: every mockup of the version, each image it names as a data: URL.
        const page = yield* h.page("p1/d/kea/screens/home")
        assert.include(page.html, '<div id="design"></div>')
        assert.strictEqual(page.title, "Home · Kea")
        const state = stateOf(page.html)
        assert.strictEqual(state.page, "design")
        assert.deepStrictEqual([state.profile, state.slug, state.version, state.draft], ["p1", "kea", 1, null])
        assert.deepStrictEqual(state.task, { id: "t1", key: "DOC-1", title: "Write the plan" })
        const d = state.design
        assert.deepStrictEqual([d.title, d.version, d.latestVersion, d.open, d.canEdit, d.canComment], ["Kea", 1, 1, "screens/home", true, true])
        assert.deepStrictEqual(
          d.pages.map((p: { path: string; title: string }) => [p.path, p.title]),
          [
            ["screens/home", "Home"],
            ["screens/sign-in", "Sign In"],
          ],
        )
        assert.strictEqual(d.pages[0].content, home)
        assert.deepStrictEqual(Object.keys(d.pages[0].images).toSorted(), ["../images/logo.png", "images/hero.png"])
        assert.match(d.pages[0].images["images/hero.png"], /^data:image\/avif;base64,/)
        assert.deepStrictEqual(d.pages[1].images, {})
        assert.deepStrictEqual(d.others, [{ title: "Notes", url: "/docs/p1/d/kea/" }])
        assert.deepStrictEqual(d.links, {
          home: "/docs/p1",
          latest: null,
          versions: null,
          source: "/docs/p1/d/kea/-/edit/screens/home",
          details: "/docs/p1/d/kea/screens/home?details=1",
        })
        assert.deepStrictEqual(d.comments, [])
        // The page script has the editor and its frames' agent in it.
        assert.include(page.html, "docs-design")

        // With ?details it is the document's own page, naming the mockup; the other pages are documents as before.
        const details = (yield* h.page("p1/d/kea/screens/home", { details: "1" })).html
        assert.include(details, 'Home is a mockup. <a href="/docs/p1/d/kea/screens/home">Open it in the design editor</a>')
        assert.include(details, 'id="delete-form"')
        assert.notInclude(details, "alert(1)")
        const index = (yield* h.page("p1/d/kea/")).html
        assert.include(index, "<article")
        assert.include(index, 'href="/docs/p1/d/kea/screens/home"')

        // A comment on an element keeps its selector: the agent gets it from get_feedback and in the message sent on.
        const where = { profile: "p1", slug: "kea" }
        const c = yield* h.call("comment.add", {
          ...where,
          version: 1,
          page: "screens/home",
          quote: '<a class="cta">Start</a>',
          prefix: "",
          suffix: "",
          anchor: " body > a:nth-child(3) ",
          comment: "Make it louder",
        })
        assert.strictEqual(c.anchor, "body > a:nth-child(3)")
        const shown = stateOf((yield* h.page("p1/d/kea/screens/sign-in")).html).design.comments
        assert.deepStrictEqual(
          shown.map((m: Record<string, unknown>) => [m.id, m.page, m.anchor, m.comment, m.mine, m.sent]),
          [[c.id, "screens/home", "body > a:nth-child(3)", "Make it louder", true, false]],
        )
        const fb = yield* h.ok("get_feedback", { slug: "kea" })
        assert.deepStrictEqual(
          fb.selections.map((s: { element: string | null; quote: string; comment: string }) => [s.element, s.quote, s.comment]),
          [["body > a:nth-child(3)", '<a class="cta">Start</a>', "Make it louder"]],
        )
        yield* h.call("feedback.send", where)
        assert.include(h.sent[0]?.text ?? "", `1. On version 1, page \`screens/home\`, element \`body > a:nth-child(3)\` (${BOARD}/docs/p1/d/kea/-/v/1/screens/home):`)
        assert.strictEqual(stateOf((yield* h.page("p1/d/kea/screens/home")).html).design.comments[0].sent, true)
      }),
    ),
  )

  it.effect("are saved from the design editor as a new version with the other pages kept, and drafted beside the document editor's", () =>
    withHarness({}, (h) =>
      Effect.gen(function* () {
        const logo = yield* png(16, 16)
        yield* h.ok("publish_document", {
          slug: "kea",
          title: "Kea",
          pages: [
            { path: "index", content: "# Notes" },
            { path: "screens/home.html", content: home },
            { path: "screens/other.html", content: "<p>Other</p>" },
          ],
          images: [
            { name: "images/logo.png", data: logo },
            { name: "screens/images/hero.png", data: logo },
          ],
        })
        const where = { profile: "p1", slug: "kea" }

        // The design editor's draft is its own: the document editor's, of the same document, is another.
        const draft = { version: 1, pages: { "screens/home": "<p>Half done</p>" }, savedAt: "2026-11-20T00:00:00Z" }
        yield* h.call("draft.keep", { ...where, draft, design: true })
        yield* h.call("draft.keep", { ...where, draft: { baseVersion: 1, title: "Text draft", pages: [] } })
        assert.deepStrictEqual(stateOf((yield* h.page("p1/d/kea/screens/home")).html).draft, draft)
        assert.strictEqual(stateOf((yield* h.page("p1/d/kea/-/edit/")).html).draft.title, "Text draft")

        // Saving gives only the mockup that changed.
        const changed = home.replace("<h1>Hello</h1>", '<h1 style="color: red">Hello there</h1>')
        const save = {
          ...where,
          base_version: 1,
          title: "Kea",
          folder: null,
          message: "Louder",
          pages: [{ path: "screens/home", title: "Home", format: "html", content: changed }],
          images: [],
          design: true,
        }
        const saved = yield* h.call("doc.save", save)
        assert.deepStrictEqual(saved, { slug: "kea", version: 2, url: "/docs/p1/d/kea/", warnings: [{ page: "screens/home", warning: saved.warnings[0]?.warning }] })
        const got = yield* h.ok("get_document", { slug: "kea" })
        assert.deepStrictEqual(
          got.pages.map((p: { path: string; format: string }) => [p.path, p.format]),
          [
            ["index", "md"],
            ["screens/home", "html"],
            ["screens/other", "html"],
          ],
          "the pages it didn't give are kept",
        )
        assert.deepStrictEqual(
          got.images.map((i: { name: string }) => i.name).toSorted(),
          ["images/logo.png", "screens/images/hero.png"],
          "and the images the mockup still names",
        )
        assert.strictEqual((yield* h.ok("read_page", { slug: "kea", path: "screens/home" })).content, changed)
        // Its draft is gone with the save; the document editor's isn't its to drop.
        const after = stateOf((yield* h.page("p1/d/kea/screens/home")).html)
        assert.strictEqual(after.draft, null)
        assert.strictEqual(after.design.version, 2)
        assert.strictEqual(after.design.pages[0].content, changed)
        assert.strictEqual(stateOf((yield* h.page("p1/d/kea/-/edit/")).html).draft.title, "Text draft")
        assert.deepStrictEqual(yield* h.call("doc.save", save), { conflict: 2, message: "Version 2 was published while you were editing." })

        // An older version can be looked at, not saved over.
        const old = stateOf((yield* h.page("p1/d/kea/-/v/1/screens/home")).html)
        assert.deepStrictEqual([old.design.version, old.design.canEdit, old.draft], [1, false, null])
        assert.strictEqual(old.design.links.latest, "/docs/p1/d/kea/screens/home")
        assert.strictEqual(old.design.pages[0].content, home)

        // The document editor keeps a mockup as the page it is, and deleting the document drops both drafts.
        const editor = stateOf((yield* h.page("p1/d/kea/-/edit/screens/home")).html).editor
        assert.deepStrictEqual(
          editor.pages.map((p: { format: string }) => p.format),
          ["md", "html", "html"],
        )
        yield* h.call("draft.keep", { ...where, draft, design: true })
        yield* h.call("doc.delete", where)
        const count = yield* h.sql<{ n: number }>`SELECT COUNT(*) AS n FROM doc_drafts`
        assert.strictEqual(count[0]?.n, 0)
      }),
    ),
  )
})
