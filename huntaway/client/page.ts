// The script of the docs plugin's pages, in the board's sandboxed frame (no network: everything goes through
// `huntaway.call` to the plugin on its host). Forms and buttons; times in the reader's zone; links to a page's own
// headings; and on a document, its form fields saving the user's answers as they give them (frontend/src/fields.ts, sharing its answer.ts),
// comments on its text as the hosted site's reader has them (frontend/src/selection.ts): select text, comment in the
// popup (saved when you click away, Esc cancels), and the comments as bubbles beside their quotes; a bar that sends
// the answers and comments to the task that published the document; and the editor, where the user edits a document's
// pages and saves them as a new version (frontend/src/editor.ts, previewing and saving through the plugin's calls).
import { layoutBubbles } from "../../frontend/src/bubbles.ts"
import { fieldValue, linkOther } from "../../frontend/src/answer.ts"
import { CONTEXT, findQuote, indexText, offsetOf, rangeFor } from "../../frontend/src/quote.ts"
import { DIAGRAMS_EVENT, initDiagrams } from "../../frontend/src/diagrams.ts"
import { mountEditor } from "../../frontend/src/editor.ts"
import type { Draft, EditorData, PreviewResult, SaveResult } from "../../frontend/src/editor.ts"
import editorCss from "../../frontend/src/editor.css"
import { mountDesign } from "../../frontend/src/design/design.ts"
import type { DesignComment, DesignData, DesignDraft, DesignSaved } from "../../frontend/src/design/design.ts"
import { remoteFrame } from "../../frontend/src/design/frames.ts"
import designCss from "../../frontend/src/design/design.css"

/** The design editor's script for a mockup's frame (frontend/src/design/agent.ts, bundled: see scripts/build.mjs). */
declare const DESIGN_AGENT: string

interface Bridge {
  call(method: string, payload?: unknown): Promise<unknown>
  navigate(path: string): void
  openTask(id: string): void
  onEvent(listener: (event: unknown) => void): void
}
interface State {
  page?: string
  profile?: string
  slug?: string | null
  version?: number
  path?: string
  unsent?: number
  unsent_answers?: number
  task?: { id: string; key: string; title: string } | null
  /** The editor's page: what it opens with, and the changes it had kept and not saved. */
  editor?: EditorData
  /** The editor's draft, or on a mockup's page the design editor's. */
  draft?: Draft | DesignDraft | null
  /** A mockup's page: what the design editor opens with. */
  design?: DesignData
}
declare global {
  interface Window {
    huntaway: Bridge
    DOCS: State
  }
}

const bridge = window.huntaway
const state: State = window.DOCS ?? {}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ---- times, toggles, forms ---------------------------------------------------------------------------------------------

const showTimes = (root: ParentNode) => {
  for (const t of root.querySelectorAll<HTMLTimeElement>("time[datetime]")) {
    const d = new Date(t.dateTime)
    if (!Number.isNaN(d.getTime())) {
      t.textContent = d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
      t.title = d.toISOString()
    }
  }
}
showTimes(document)

document.addEventListener("click", (e) => {
  const target = e.target instanceof Element ? e.target : null
  const toggle = target?.closest<HTMLElement>("[data-toggle]")
  if (toggle) {
    e.preventDefault()
    const el = document.getElementById(toggle.dataset.toggle ?? "")
    if (el) {
      el.hidden = !el.hidden
      if (!el.hidden) el.querySelector<HTMLInputElement>("input:not([type=hidden]), textarea")?.focus()
    }
    return
  }
  // Links to the page's own headings scroll to them (in a srcdoc frame they'd load the board's address).
  const a = target?.closest("a[href]")
  const href = a?.getAttribute("href") ?? ""
  if (href.startsWith("#")) {
    e.preventDefault()
    let id = href.slice(1)
    try {
      id = decodeURIComponent(id)
    } catch {
      /* as it is */
    }
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" })
  }
})

// The frame is sandboxed without allow-forms, so a form never submits: its button (or Enter in one of its fields) runs it.
const submit = async (form: HTMLFormElement) => {
  if (!form.dataset.call || form.dataset.busy === "yes") return
  const error = form.querySelector<HTMLElement>(".error")
  const result = form.querySelector<HTMLElement>(".publish-result")
  const buttons = [...form.querySelectorAll("button")]
  const payload: Record<string, unknown> = { ...JSON.parse(form.dataset.payload ?? "{}") }
  for (const [k, v] of new FormData(form)) payload[k] = String(v)
  if (form.dataset.confirmed === "yes") payload.confirmed = true
  if (error) error.textContent = ""
  form.dataset.busy = "yes"
  for (const b of buttons) b.disabled = true
  try {
    const out = (await bridge.call(form.dataset.call, payload)) as Record<string, unknown> | null
    if (form.dataset.call === "site.publish" && out && result) {
      const exists = out.exists as { slug: string; title: string; latest_version: number | null; owner: string | null } | undefined
      if (exists) {
        // The site has a document of the user's at that slug: publishing adds a version to it, once they say so.
        form.dataset.confirmed = "yes"
        result.textContent = `The site has your document “${exists.title}” at ${exists.slug} already${exists.latest_version === null ? "" : ` (v${exists.latest_version})`}. Publish again to add this as a new version of it, or choose another slug.`
        const button = form.querySelector("button")
        if (button) button.textContent = "Publish as a new version"
      } else {
        form.dataset.confirmed = ""
        const published = out.published as { url: string; remote_version: number } | undefined
        const warnings = (out.warnings as { page: string; warning: string }[] | undefined) ?? []
        result.textContent = published ? `Published as version ${published.remote_version}. ` : ""
        if (published) {
          const link = document.createElement("a")
          link.href = published.url
          link.textContent = "Open it"
          result.append(link)
        }
        if (warnings.length > 0) result.append(` Warnings: ${warnings.map((w) => `${w.page}: ${w.warning}`).join("; ")}`)
      }
    }
    if (form.dataset.then) bridge.navigate(form.dataset.then)
  } catch (err) {
    if (error) error.textContent = messageOf(err)
  } finally {
    form.dataset.busy = ""
    for (const b of buttons) b.disabled = false
  }
}
document.addEventListener("click", (e) => {
  const button = e.target instanceof Element ? e.target.closest("button") : null
  const form = button?.closest<HTMLFormElement>("form[data-call]")
  if (!button || !form || button.type !== "submit") return
  e.preventDefault()
  void submit(form)
})
document.addEventListener("keydown", (e) => {
  const input = e.target instanceof HTMLInputElement ? e.target : null
  const form = input?.closest<HTMLFormElement>("form[data-call]")
  if (e.key !== "Enter" || !form) return
  e.preventDefault()
  void submit(form)
})
document.addEventListener("submit", (e) => e.preventDefault())

// The publish form forgets the site's answer when the slug changes.
document.addEventListener("input", (e) => {
  const form = e.target instanceof Element ? e.target.closest<HTMLFormElement>("form[data-call='site.publish']") : null
  if (form && form.dataset.confirmed === "yes") {
    form.dataset.confirmed = ""
    const button = form.querySelector("button")
    if (button) button.textContent = "Publish"
  }
})

// ---- sending answers and comments ---------------------------------------------------------------------------------------

const where = { profile: state.profile, slug: state.slug }
/** How many comments and answers haven't been sent to the task yet. */
const unsent = { comments: state.unsent ?? 0, answers: state.unsent_answers ?? 0 }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const unsentText = () =>
  [unsent.answers > 0 ? plural(unsent.answers, "answer", "answers") : "", unsent.comments > 0 ? plural(unsent.comments, "comment", "comments") : ""]
    .filter((s) => s !== "")
    .join(" and ")

/** The bar above the page: send the answers and comments to the agent that published the document. */
const showSend = () => {
  const sendBar = document.querySelector<HTMLElement>("#send-bar")
  if (!sendBar) return
  sendBar.replaceChildren()
  sendBar.classList.remove("muted")
  if (unsent.comments === 0 && unsent.answers === 0) return
  if (!state.task) {
    sendBar.append(`${unsentText()} not sent: the task that published this document isn't on the board any more, so its agent can read them with get_feedback.`)
    sendBar.classList.add("muted")
    return
  }
  const button = document.createElement("button")
  button.className = "primary"
  button.textContent = `Send ${unsentText()} to ${state.task.key}`
  const note = document.createElement("span")
  note.className = "muted small"
  note.textContent = state.task.title
  const err = document.createElement("span")
  err.className = "error"
  button.addEventListener("click", async () => {
    button.disabled = true
    err.textContent = ""
    try {
      await bridge.call("feedback.send", where)
      unsent.comments = 0
      unsent.answers = 0
      for (const b of document.querySelectorAll("#comments .comment-bubble footer")) if (!b.querySelector(".sent")) b.insertAdjacentHTML("afterbegin", '<span class="sent">sent</span> · ')
      for (const s of document.querySelectorAll<HTMLElement>(".docs-render .field-status[data-state='saved']")) s.textContent = "Sent"
      sendBar.replaceChildren(`Sent to ${state.task?.key ?? "the task"}.`)
    } catch (e) {
      err.textContent = messageOf(e)
      button.disabled = false
    }
  })
  sendBar.append(button, note, err)
}

// ---- answers -------------------------------------------------------------------------------------------------------------

if (state.page === "doc") initFields()

/** Answers save as the user gives them: text after a pause, choices straight away. */
function initFields(): void {
  const article = document.querySelector<HTMLElement>("article.doc-content")
  if (!article) return
  for (const field of article.querySelectorAll<HTMLElement>(".field[data-field]")) {
    linkOther(field)
    const status = field.querySelector<HTMLElement>(".field-status")
    const setStatus = (text: string, kind = "") => {
      if (!status) return
      status.textContent = text
      status.dataset.state = kind
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let inflight = Promise.resolve()
    const save = () => {
      clearTimeout(timer)
      const value = fieldValue(field)
      setStatus("Saving…", "saving")
      // One save at a time, so an older answer never overwrites a newer one.
      inflight = inflight.then(async () => {
        try {
          const out = (await bridge.call("answer.save", { ...where, version: state.version, page: state.path, field: field.dataset.field, value })) as {
            unsent_answers: number
          }
          setStatus("Saved", "saved")
          unsent.answers = out.unsent_answers
          showSend()
        } catch (e) {
          setStatus(`Not saved: ${messageOf(e)}`, "error")
        }
      })
    }
    field.addEventListener("input", (e) => {
      const target = e.target
      if (target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type === "text")) {
        setStatus("Editing…")
        clearTimeout(timer)
        timer = setTimeout(save, 700)
      }
    })
    field.addEventListener("change", save)
  }
}

// ---- comments ------------------------------------------------------------------------------------------------------------

if (state.page === "doc") {
  showSend()
  initComments()
}
// Mermaid code blocks as diagrams (frontend/src/diagrams.ts), on a document's page and in the editor's preview.
initDiagrams()

function initComments(): void {
  const article = document.querySelector<HTMLElement>("article.doc-content")
  const body = document.querySelector<HTMLElement>(".doc-body")
  const rail = document.querySelector<HTMLElement>("#comments")
  if (!article || !body || !rail) return
  const highlights = typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null
  const mark = (name: string, ranges: Range[]) => {
    if (!highlights) return
    if (ranges.length === 0) highlights.delete(name)
    else highlights.set(name, new Highlight(...ranges))
  }
  // The popup on selected text: a Comment button, then the comment box.
  const popup = document.createElement("div")
  popup.className = "comment-popup"
  popup.hidden = true
  popup.innerHTML = `<button type="button" class="comment-start">💬 Comment</button>
    <div class="comment-editor" hidden><textarea rows="3" placeholder="Add a comment" aria-label="Comment"></textarea>
    <p class="error" role="alert"></p><p class="comment-hint">Saved when you click away · Esc to cancel</p></div>`
  document.body.append(popup)
  const start = popup.querySelector<HTMLButtonElement>(".comment-start")!
  const editor = popup.querySelector<HTMLElement>(".comment-editor")!
  const textarea = popup.querySelector("textarea")!
  const errorEl = popup.querySelector<HTMLElement>(".error")!

  type Pending = { quote: string; prefix: string; suffix: string; range: Range }
  let mode: "idle" | "offer" | "editing" | "saving" = "idle"
  let pending: Pending | null = null

  const place = (range: Range) => {
    const rect = range.getBoundingClientRect()
    const width = popup.offsetWidth || 300
    const left = Math.min(rect.left + scrollX, scrollX + document.documentElement.clientWidth - width - 8)
    popup.style.left = `${Math.max(8, left)}px`
    popup.style.top = `${rect.bottom + scrollY + 8}px`
  }

  const current = (): Pending | null => {
    const sel = getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
    const range = sel.getRangeAt(0)
    if (!article.contains(range.commonAncestorContainer)) return null
    const index = indexText(article)
    let from = offsetOf(index, article, range.startContainer, range.startOffset)
    let to = offsetOf(index, article, range.endContainer, range.endOffset)
    while (from < to && /\s/.test(index.text[from] ?? "")) from++
    while (to > from && /\s/.test(index.text[to - 1] ?? "")) to--
    if (to <= from) return null
    return {
      quote: index.text.slice(from, to),
      prefix: index.text.slice(Math.max(0, from - CONTEXT), from),
      suffix: index.text.slice(to, to + CONTEXT),
      range: range.cloneRange(),
    }
  }

  const close = () => {
    mode = "idle"
    pending = null
    popup.hidden = true
    start.hidden = false
    editor.hidden = true
    textarea.value = ""
    textarea.readOnly = false
    errorEl.textContent = ""
    mark("doc-comment-draft", [])
  }

  const offer = () => {
    if (mode === "editing" || mode === "saving") return
    pending = current()
    if (!pending) return close()
    mode = "offer"
    popup.hidden = false
    place(pending.range)
  }
  let debounce: ReturnType<typeof setTimeout> | undefined
  document.addEventListener("selectionchange", () => {
    clearTimeout(debounce)
    debounce = setTimeout(offer, 120)
  })

  start.addEventListener("mousedown", (e) => e.preventDefault())
  start.addEventListener("click", () => {
    if (!pending) return
    mode = "editing"
    start.hidden = true
    editor.hidden = false
    mark("doc-comment-draft", [pending.range])
    place(pending.range)
    textarea.focus()
  })

  const save = async () => {
    if (mode !== "editing" || !pending) return
    const comment = textarea.value.trim()
    if (!comment) return close()
    const { quote, prefix, suffix } = pending
    mode = "saving"
    textarea.readOnly = true
    errorEl.textContent = ""
    try {
      const saved = (await bridge.call("comment.add", { ...where, version: state.version, page: state.path, quote, prefix, suffix, comment })) as {
        id: number
        created_at: string
      }
      rail.append(bubble(saved.id, saved.created_at, { quote, prefix, suffix, comment }))
      unsent.comments++
      showSend()
      close()
      refresh()
      offer()
    } catch (err) {
      mode = "editing"
      textarea.readOnly = false
      errorEl.textContent = `Could not save: ${messageOf(err)}`
    }
  }

  popup.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault()
      close()
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void save()
    }
  })
  popup.addEventListener("focusout", () => {
    setTimeout(() => {
      if (document.hasFocus() && !popup.contains(document.activeElement)) void save()
    })
  })

  // ---- bubbles ----

  const ranges = new Map<HTMLElement, Range>()
  let active: HTMLElement | null = null
  const bubbles = () => [...rail.querySelectorAll<HTMLElement>(".comment-bubble")]

  const layout = () => {
    const all = bubbles()
    const first = all[0]
    const floating = first !== undefined && getComputedStyle(first).position === "absolute"
    if (!floating) {
      for (const b of all) b.style.top = ""
      rail.style.minHeight = ""
      return
    }
    const railTop = rail.getBoundingClientRect().top
    const anchors = all.map((b) => {
      const r = ranges.get(b)
      return r ? r.getBoundingClientRect().top - railTop : Number.NaN
    })
    const heights = all.map((b) => b.offsetHeight)
    const tops = layoutBubbles(anchors, heights, active ? all.indexOf(active) : -1)
    all.forEach((b, i) => (b.style.top = `${tops[i] ?? 0}px`))
    rail.style.minHeight = `${Math.max(0, ...tops.map((t, i) => t + (heights[i] ?? 0)))}px`
  }

  const setActive = (b: HTMLElement | null) => {
    if (b === active) return
    active?.classList.remove("active")
    active = b
    active?.classList.add("active")
    const range = active ? ranges.get(active) : undefined
    mark("doc-comment-active", range ? [range] : [])
    layout()
  }

  const refresh = () => {
    ranges.clear()
    const index = indexText(article)
    const order: [number, HTMLElement][] = []
    for (const b of bubbles()) {
      const quote = b.dataset.quote ?? ""
      const found = findQuote(index.text, quote, b.dataset.prefix, b.dataset.suffix)
      const range = found >= 0 ? rangeFor(index, found, found + quote.length) : null
      b.classList.toggle("orphaned", !range)
      if (range) ranges.set(b, range)
      order.push([range ? found : Number.POSITIVE_INFINITY, b])
    }
    order.sort((a, b) => a[0] - b[0])
    rail.append(...order.map(([, b]) => b))
    body.classList.toggle("has-comments", order.length > 0)
    mark("doc-comment", [...ranges.values()])
    if (active && !rail.contains(active)) setActive(null)
    layout()
  }

  const editInPlace = (b: HTMLElement) => {
    const p = b.querySelector("p")
    if (!p || b.querySelector("textarea")) return
    const box = document.createElement("textarea")
    box.value = p.textContent ?? ""
    const err = document.createElement("p")
    err.className = "error"
    p.replaceWith(box)
    box.after(err)
    box.focus()
    let done = false
    const finish = async (keep: boolean) => {
      if (done) return
      done = true
      const text = box.value.trim()
      if (keep && text !== (p.textContent ?? "")) {
        try {
          await bridge.call("comment.update", { ...where, id: Number(b.dataset.id), comment: text })
          p.textContent = text
          b.classList.toggle("quote-only", text === "")
          const sent = b.querySelector(".sent")
          if (sent) {
            sent.nextSibling?.remove()
            sent.remove()
            unsent.comments++
            showSend()
          }
        } catch (e) {
          done = false
          err.textContent = `Could not save: ${messageOf(e)}`
          return
        }
      }
      box.replaceWith(p)
      err.remove()
      layout()
    }
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault()
        box.value = p.textContent ?? ""
        void finish(false)
      }
    })
    box.addEventListener("blur", () => void finish(true))
    layout()
  }

  rail.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement
    const b = target.closest<HTMLElement>(".comment-bubble")
    if (!b) return
    if (target.closest(".delete-comment")) {
      try {
        await bridge.call("comment.delete", { ...where, id: Number(b.dataset.id) })
        if (!b.querySelector(".sent")) unsent.comments = Math.max(0, unsent.comments - 1)
        b.remove()
        showSend()
        refresh()
      } catch (err) {
        b.querySelector("footer")?.append(` ${messageOf(err)}`)
      }
      return
    }
    if (target.closest(".edit-comment")) return editInPlace(b)
    setActive(b)
    if (getComputedStyle(b).position !== "absolute") ranges.get(b)?.startContainer.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" })
  })

  document.addEventListener("click", (e) => {
    const target = e.target as Node
    if (rail.contains(target) || popup.contains(target)) return
    if (!getSelection()?.isCollapsed) return
    let hit: HTMLElement | null = null
    const caret = caretAt(e.clientX, e.clientY)
    if (caret && article.contains(caret.node)) for (const [b, range] of ranges) if (range.isPointInRange(caret.node, caret.offset)) hit = b
    setActive(hit)
  })

  new ResizeObserver(() => layout()).observe(article)
  addEventListener("resize", layout)
  // A diagram that was drawn has changed the page's text: find the quotes again.
  document.addEventListener(DIAGRAMS_EVENT, refresh)
  refresh()
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y)
    return p && { node: p.offsetNode, offset: p.offset }
  }
  const r = document.caretRangeFromPoint?.(x, y)
  return r ? { node: r.startContainer, offset: r.startOffset } : null
}

function bubble(id: number, createdAt: string, s: { quote: string; prefix: string; suffix: string; comment: string }): HTMLElement {
  const b = document.createElement("div")
  b.className = "comment-bubble"
  b.dataset.id = String(id)
  b.dataset.quote = s.quote
  b.dataset.prefix = s.prefix
  b.dataset.suffix = s.suffix
  const quote = document.createElement("blockquote")
  quote.textContent = s.quote
  const p = document.createElement("p")
  p.textContent = s.comment
  const footer = document.createElement("footer")
  const time = document.createElement("time")
  time.dateTime = createdAt
  const grow = document.createElement("span")
  grow.className = "grow"
  const edit = document.createElement("button")
  edit.type = "button"
  edit.className = "link edit-comment"
  edit.textContent = "Edit"
  const del = document.createElement("button")
  del.type = "button"
  del.className = "link delete-comment"
  del.textContent = "Delete"
  footer.append(time, grow, edit, del)
  b.append(quote, p, footer)
  showTimes(b)
  return b
}

// ---- the editor ---------------------------------------------------------------------------------------------------------

if (state.page === "edit" && state.editor) {
  const style = document.createElement("style")
  style.textContent = editorCss
  document.head.append(style)
  const root = document.getElementById("editor")
  const slug = state.slug ?? null
  if (root) {
    mountEditor(root, state.editor, {
      async preview(page) {
        const out = (await bridge.call("doc.preview", { profile: state.profile, slug, ...page })) as {
          html: string | null
          has_h1: boolean
          warnings: string[]
          error: string | null
        }
        const result: PreviewResult = { html: out.html, hasH1: out.has_h1, warnings: out.warnings, error: out.error }
        return result
      },
      async save(request) {
        return (await bridge.call("doc.save", { profile: state.profile, slug, ...request })) as SaveResult
      },
      go(url) {
        bridge.navigate(url)
      },
      // Kept in the plugin: the board reloads its pages when any document changes.
      drafts: {
        load: async () => (state.draft ?? null) as Draft | null,
        save: async (draft) => void (await bridge.call("draft.keep", { profile: state.profile, slug, draft })),
        clear: async () => void (await bridge.call("draft.keep", { profile: state.profile, slug, draft: null })),
      },
    })
  }
}

// ---- the design editor ---------------------------------------------------------------------------------------------------

// A mockup's page: the hosted site's design editor (frontend/src/design/design.ts), with each mockup in a frame of its
// own that runs the editor's agent and nothing of the mockup's (frames.ts), saving and commenting through the plugin's calls.
if (state.page === "design" && state.design) {
  const style = document.createElement("style")
  style.textContent = designCss
  document.head.append(style)
  const root = document.getElementById("design")
  const slug = state.slug ?? null
  const task = state.task ?? null
  interface Made {
    id: number
    page: string
    quote: string
    anchor: string
    comment: string
    created_at: string
    sent_at: string | null
  }
  if (root) {
    mountDesign(root, state.design, {
      frame: (iframe) => remoteFrame(iframe, DESIGN_AGENT),
      async save(request) {
        return (await bridge.call("doc.save", {
          profile: state.profile,
          slug,
          title: state.design?.title ?? "",
          folder: null,
          images: [],
          design: true,
          ...request,
        })) as DesignSaved
      },
      async addComment(c) {
        const made = (await bridge.call("comment.add", { ...where, version: state.version, prefix: "", suffix: "", ...c })) as Made
        const comment: DesignComment = { id: made.id, page: made.page, quote: made.quote, anchor: made.anchor, comment: made.comment, user: "You", mine: true, created_at: made.created_at, sent: made.sent_at !== null }
        return comment
      },
      async deleteComment(id) {
        await bridge.call("comment.delete", { ...where, id })
      },
      // The comments go to the task that published the document, when the user sends them (with any unsent answers).
      send: task === null ? undefined : { to: task.key, run: async () => void (await bridge.call("feedback.send", where)) },
      go(url) {
        bridge.navigate(url)
      },
      // Kept in the plugin: the board reloads its pages when any document changes.
      drafts: {
        load: async () => (state.draft ?? null) as DesignDraft | null,
        save: async (draft) => void (await bridge.call("draft.keep", { profile: state.profile, slug, draft, design: true })),
        clear: async () => void (await bridge.call("draft.keep", { profile: state.profile, slug, draft: null, design: true })),
      },
    })
  }
}
