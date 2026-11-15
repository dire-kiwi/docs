// The script of the docs plugin's pages, in the board's sandboxed frame (no network: everything goes through
// `huntaway.call` to the plugin on its host). Forms and buttons; times in the reader's zone; links to a page's own
// headings; read-only form fields; and on a document, comments on its text as the hosted site's reader has them
// (frontend/src/selection.ts): select text, comment in the popup (saved when you click away, Esc cancels), and the
// comments as bubbles beside their quotes.
import { layoutBubbles } from "../../frontend/src/bubbles.ts"
import { CONTEXT, findQuote, indexText, offsetOf, rangeFor } from "../../frontend/src/quote.ts"

interface Bridge {
  call(method: string, payload?: unknown): Promise<unknown>
  navigate(path: string): void
  openTask(id: string): void
  onEvent(listener: (event: unknown) => void): void
}
interface State {
  page?: string
  profile?: string
  slug?: string
  version?: number
  path?: string
  unsent?: number
  task?: { id: string; key: string; title: string } | null
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

document.addEventListener("submit", async (e) => {
  const form = e.target
  if (!(form instanceof HTMLFormElement) || !form.dataset.call) return
  e.preventDefault()
  const error = form.querySelector<HTMLElement>(".error")
  const result = form.querySelector<HTMLElement>(".publish-result")
  const buttons = [...form.querySelectorAll("button")]
  const payload: Record<string, unknown> = { ...JSON.parse(form.dataset.payload ?? "{}") }
  for (const [k, v] of new FormData(form)) payload[k] = String(v)
  if (form.dataset.confirmed === "yes") payload.confirmed = true
  if (error) error.textContent = ""
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
    for (const b of buttons) b.disabled = false
  }
})

// The publish form forgets the site's answer when the slug changes.
document.addEventListener("input", (e) => {
  const form = e.target instanceof Element ? e.target.closest<HTMLFormElement>("form[data-call='site.publish']") : null
  if (form && form.dataset.confirmed === "yes") {
    form.dataset.confirmed = ""
    const button = form.querySelector("button")
    if (button) button.textContent = "Publish"
  }
})

// Documents on the board collect no answers: their form fields are read-only, and say so.
for (const field of document.querySelectorAll(".docs-render .field")) {
  for (const c of field.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>("input, select, textarea, button")) c.disabled = true
  const note = document.createElement("div")
  note.className = "field-status read-only-note"
  note.textContent = "Read-only: documents on the board don't collect answers. Answer in the task's thread."
  field.append(note)
}

// ---- comments ------------------------------------------------------------------------------------------------------------

if (state.page === "doc") initComments()

function initComments(): void {
  const article = document.querySelector<HTMLElement>("article.doc-content")
  const body = document.querySelector<HTMLElement>(".doc-body")
  const rail = document.querySelector<HTMLElement>("#comments")
  const sendBar = document.querySelector<HTMLElement>("#send-bar")
  if (!article || !body || !rail || !sendBar) return
  const where = { profile: state.profile, slug: state.slug }
  const highlights = typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null
  const mark = (name: string, ranges: Range[]) => {
    if (!highlights) return
    if (ranges.length === 0) highlights.delete(name)
    else highlights.set(name, new Highlight(...ranges))
  }
  let unsent = state.unsent ?? 0

  // The bar above the page: send the comments to the agent that published the document.
  const showSend = () => {
    sendBar.replaceChildren()
    if (unsent === 0) return
    if (!state.task) {
      sendBar.append(`${unsent} unsent ${unsent === 1 ? "comment" : "comments"}: the task that published this document isn't on the board any more, so its agent can read them with get_feedback.`)
      sendBar.classList.add("muted")
      return
    }
    const button = document.createElement("button")
    button.className = "primary"
    button.textContent = `Send ${unsent} ${unsent === 1 ? "comment" : "comments"} to ${state.task.key}`
    const note = document.createElement("span")
    note.className = "muted small"
    note.textContent = state.task.title
    const err = document.createElement("span")
    err.className = "error"
    button.addEventListener("click", async () => {
      button.disabled = true
      err.textContent = ""
      try {
        await bridge.call("comments.send", where)
        unsent = 0
        for (const b of rail.querySelectorAll(".comment-bubble footer")) if (!b.querySelector(".sent")) b.insertAdjacentHTML("afterbegin", '<span class="sent">sent</span> · ')
        sendBar.replaceChildren(`Sent to ${state.task?.key ?? "the task"}.`)
      } catch (e) {
        err.textContent = messageOf(e)
        button.disabled = false
      }
    })
    sendBar.append(button, note, err)
  }
  showSend()

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
      unsent++
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
            unsent++
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
        if (!b.querySelector(".sent")) unsent = Math.max(0, unsent - 1)
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
