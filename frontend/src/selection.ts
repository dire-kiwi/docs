import { api } from "./api.ts";
import { layoutBubbles } from "./bubbles.ts";
import { CONTEXT, findQuote, indexText, offsetOf, rangeFor } from "./quote.ts";
import { initTimes } from "./time.ts";

interface Pending {
  quote: string;
  prefix: string;
  suffix: string;
  range: Range;
}

const HIGHLIGHT = "doc-comment";
const ACTIVE = "doc-comment-active";
const DRAFT = "doc-comment-draft";

/**
 * Readers select text in a page and leave a comment on it for the agent.
 *
 * Selecting text shows a "Comment" button; pressing it turns the same popup into
 * the comment box. The comment is saved when focus leaves the box (clicking
 * away), and dropped on Escape or if it's empty. Saved comments are highlighted
 * in the page and shown as bubbles in the margin beside their quotes (under the
 * page on narrow screens).
 */
export function initSelections(): void {
  const article = document.querySelector<HTMLElement>("article.doc-content[data-version-id]");
  const body = document.querySelector<HTMLElement>(".doc-body");
  const rail = document.querySelector<HTMLElement>("#comments");
  if (!article || !body || !rail) return;
  const versionId = Number(article.dataset.versionId);
  const page = article.dataset.page ?? "";
  const highlights = "highlights" in CSS ? CSS.highlights : null;

  const popup = document.createElement("div");
  popup.className = "comment-popup";
  popup.hidden = true;
  popup.innerHTML = `
    <button type="button" class="comment-start">✎ Comment</button>
    <div class="comment-editor" hidden>
      <textarea rows="3" placeholder="Add a comment" aria-label="Comment"></textarea>
      <p class="error" role="alert"></p>
      <p class="comment-hint">Saved when you click away · Esc to cancel</p>
    </div>`;
  document.body.append(popup);
  const start = popup.querySelector<HTMLButtonElement>(".comment-start")!;
  const editor = popup.querySelector<HTMLElement>(".comment-editor")!;
  const textarea = popup.querySelector("textarea")!;
  const errorEl = popup.querySelector<HTMLElement>(".error")!;

  let state: "idle" | "offer" | "editing" | "saving" = "idle";
  let pending: Pending | null = null;

  // Measure when placing: the page may have scrolled since the text was selected.
  const place = (range: Range): void => {
    const rect = range.getBoundingClientRect();
    const width = popup.offsetWidth || 280;
    const left = Math.min(
      rect.left + window.scrollX,
      window.scrollX + document.documentElement.clientWidth - width - 8,
    );
    popup.style.left = `${Math.max(8, left)}px`;
    popup.style.top = `${rect.bottom + window.scrollY + 8}px`;
  };

  const current = (): Pending | null => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!article.contains(range.commonAncestorContainer)) return null;
    const index = indexText(article);
    let start = offsetOf(index, article, range.startContainer, range.startOffset);
    let end = offsetOf(index, article, range.endContainer, range.endOffset);
    while (start < end && /\s/.test(index.text[start])) start++;
    while (end > start && /\s/.test(index.text[end - 1])) end--;
    if (end <= start) return null;
    return {
      quote: index.text.slice(start, end),
      prefix: index.text.slice(Math.max(0, start - CONTEXT), start),
      suffix: index.text.slice(end, end + CONTEXT),
      range: range.cloneRange(),
    };
  };

  const close = (): void => {
    state = "idle";
    pending = null;
    popup.hidden = true;
    start.hidden = false;
    editor.hidden = true;
    textarea.value = "";
    textarea.readOnly = false;
    errorEl.textContent = "";
    highlights?.delete(DRAFT);
  };

  // Offer to comment on the selected text, unless a comment is being written.
  const offer = (): void => {
    if (state === "editing" || state === "saving") return;
    pending = current();
    if (!pending) return close();
    state = "offer";
    popup.hidden = false;
    place(pending.range);
  };
  let debounce: number | undefined;
  document.addEventListener("selectionchange", () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(offer, 120);
  });

  // Keep the selection when the button is pressed.
  start.addEventListener("mousedown", (e) => e.preventDefault());
  start.addEventListener("click", () => {
    if (!pending) return;
    state = "editing";
    start.hidden = true;
    editor.hidden = false;
    // Focusing the box hides the selection, so keep the quote marked.
    highlights?.set(DRAFT, new Highlight(pending.range));
    place(pending.range);
    textarea.focus();
  });

  const save = async (): Promise<void> => {
    if (state !== "editing" || !pending) return;
    const comment = textarea.value.trim();
    if (!comment) return close();
    const { quote, prefix, suffix } = pending;
    state = "saving";
    textarea.readOnly = true;
    errorEl.textContent = "";
    try {
      const saved = await api<{ id: number; user: string; created_at: number }>(
        "POST",
        "/api/selections",
        { version_id: versionId, page, quote, prefix, suffix, comment },
      );
      rail.append(
        bubble(saved.id, saved.user, saved.created_at, { quote, prefix, suffix, comment }),
      );
      close();
      refresh();
      offer(); // text selected while it was saving
    } catch (err) {
      // Keep the popup open with the comment, to try again or cancel.
      state = "editing";
      textarea.readOnly = false;
      errorEl.textContent = `Could not save: ${(err as Error).message}`;
    }
  };

  popup.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    }
  });
  // Clicking (or tabbing) away saves; switching to another window doesn't.
  popup.addEventListener("focusout", () => {
    window.setTimeout(() => {
      if (document.hasFocus() && !popup.contains(document.activeElement)) void save();
    });
  });

  // ---------- bubbles ----------

  const ranges = new Map<HTMLElement, Range>();
  let active: HTMLElement | null = null;
  const bubbles = (): HTMLElement[] => [...rail.querySelectorAll<HTMLElement>(".comment-bubble")];

  const layout = (): void => {
    const all = bubbles();
    const floating = all.length > 0 && getComputedStyle(all[0]).position === "absolute";
    if (!floating) {
      for (const b of all) b.style.top = "";
      rail.style.minHeight = "";
      return;
    }
    const railTop = rail.getBoundingClientRect().top;
    const anchors = all.map((b) => {
      const r = ranges.get(b);
      return r ? r.getBoundingClientRect().top - railTop : NaN;
    });
    const heights = all.map((b) => b.offsetHeight);
    const tops = layoutBubbles(anchors, heights, active ? all.indexOf(active) : -1);
    all.forEach((b, i) => (b.style.top = `${tops[i]}px`));
    const bottom = Math.max(0, ...tops.map((t, i) => t + heights[i]));
    rail.style.minHeight = `${bottom}px`;
  };

  const setActive = (b: HTMLElement | null): void => {
    if (b === active) return;
    active?.classList.remove("active");
    active = b;
    active?.classList.add("active");
    const range = active && ranges.get(active);
    if (range) highlights?.set(ACTIVE, new Highlight(range));
    else highlights?.delete(ACTIVE);
    layout();
  };

  /** Find each comment's quote in the page again, and put the bubbles in page order. */
  const refresh = (): void => {
    ranges.clear();
    const index = indexText(article);
    const order: [number, HTMLElement][] = [];
    for (const b of bubbles()) {
      const quote = b.dataset.quote ?? "";
      const at = findQuote(index.text, quote, b.dataset.prefix, b.dataset.suffix);
      const range = at >= 0 ? rangeFor(index, at, at + quote.length) : null;
      b.classList.toggle("orphaned", !range);
      if (range) ranges.set(b, range);
      order.push([range ? at : Infinity, b]);
    }
    order.sort((a, b) => a[0] - b[0]);
    rail.append(...order.map(([, b]) => b));
    body.classList.toggle("has-comments", order.length > 0);
    highlights?.set(HIGHLIGHT, new Highlight(...ranges.values()));
    if (active && !rail.contains(active)) setActive(null);
    layout();
  };

  rail.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    const b = target.closest<HTMLElement>(".comment-bubble");
    if (!b) return;
    if (target.closest(".delete-selection")) {
      try {
        await api("DELETE", `/api/selections/${b.dataset.id}`);
        b.remove();
        refresh();
      } catch (err) {
        alert(`Could not delete: ${(err as Error).message}`);
      }
      return;
    }
    setActive(b);
    // Under the page (narrow screens) the quote is out of sight.
    if (getComputedStyle(b).position !== "absolute") {
      ranges.get(b)?.startContainer.parentElement?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  });

  // Clicking highlighted text brings up its comment; clicking elsewhere lets go of it.
  document.addEventListener("click", (e) => {
    const target = e.target as Node;
    if (rail.contains(target) || popup.contains(target)) return;
    if (!window.getSelection()?.isCollapsed) return;
    let hit: HTMLElement | null = null;
    const caret = caretAt(e.clientX, e.clientY);
    if (caret && article.contains(caret.node)) {
      for (const [b, range] of ranges) {
        if (range.isPointInRange(caret.node, caret.offset)) hit = b;
      }
    }
    setActive(hit);
  });

  new ResizeObserver(() => layout()).observe(article);
  window.addEventListener("resize", layout);
  refresh();
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    return p && { node: p.offsetNode, offset: p.offset };
  }
  const r = document.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

function bubble(
  id: number,
  user: string,
  createdAt: number,
  s: { quote: string; prefix: string; suffix: string; comment: string },
): HTMLElement {
  const b = document.createElement("div");
  b.className = "comment-bubble";
  b.dataset.id = String(id);
  b.dataset.quote = s.quote;
  b.dataset.prefix = s.prefix;
  b.dataset.suffix = s.suffix;
  const quote = document.createElement("blockquote");
  quote.textContent = s.quote;
  const p = document.createElement("p");
  p.textContent = s.comment;
  const footer = document.createElement("footer");
  const who = document.createElement("span");
  const time = document.createElement("time");
  time.dateTime = new Date(createdAt * 1000).toISOString();
  who.append(`${user} · `, time);
  const del = document.createElement("button");
  del.type = "button";
  del.className = "link delete-selection";
  del.textContent = "Delete";
  footer.append(who, del);
  b.append(quote, p, footer);
  initTimes(b);
  return b;
}
