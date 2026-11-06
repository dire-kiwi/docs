import { api } from "./api.ts";
import { CONTEXT, findQuote, indexText, offsetOf, rangeFor } from "./quote.ts";
import { initTimes } from "./time.ts";

interface Pending {
  quote: string;
  prefix: string;
  suffix: string;
  range: Range;
}

const HIGHLIGHT = "doc-comment";

/**
 * Readers select text in a page and leave a comment on it for the agent.
 * Saved selections are listed under the page and highlighted in it.
 */
export function initSelections(): void {
  const article = document.querySelector<HTMLElement>("article.doc-content[data-version-id]");
  const list = document.querySelector<HTMLOListElement>("#selections .selection-list");
  if (!article || !list) return;
  const versionId = Number(article.dataset.versionId);
  const page = article.dataset.page ?? "";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "comment-button";
  button.textContent = "💬 Comment";
  button.hidden = true;

  const popover = document.createElement("form");
  popover.className = "comment-popover";
  popover.hidden = true;
  popover.innerHTML = `
    <blockquote></blockquote>
    <textarea rows="3" placeholder="Comment for the agent (optional)" aria-label="Comment"></textarea>
    <p class="error" role="alert"></p>
    <div class="row">
      <button type="submit" class="primary">Save</button>
      <button type="button" class="cancel">Cancel</button>
    </div>`;
  document.body.append(button, popover);
  const quoteEl = popover.querySelector("blockquote")!;
  const textarea = popover.querySelector("textarea")!;
  const errorEl = popover.querySelector<HTMLElement>(".error")!;

  let pending: Pending | null = null;
  const ranges = new Map<HTMLElement, Range>();

  // Measure when placing: the page may have scrolled since the text was selected.
  const place = (el: HTMLElement, range: Range): void => {
    const rect = range.getBoundingClientRect();
    const width = el.offsetWidth || 280;
    const left = Math.min(
      rect.left + window.scrollX,
      window.scrollX + document.documentElement.clientWidth - width - 8,
    );
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${rect.bottom + window.scrollY + 8}px`;
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

  let debounce: number | undefined;
  document.addEventListener("selectionchange", () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      if (!popover.hidden) return;
      pending = current();
      button.hidden = !pending;
      if (pending) place(button, pending.range);
    }, 120);
  });

  const close = (): void => {
    popover.hidden = true;
    pending = null;
  };

  // Keep the selection when the button is pressed.
  button.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("click", () => {
    if (!pending) return;
    button.hidden = true;
    const q = pending.quote;
    quoteEl.textContent = q.length > 300 ? `${q.slice(0, 300)}…` : q;
    textarea.value = "";
    errorEl.textContent = "";
    popover.hidden = false;
    place(popover, pending.range);
    textarea.focus();
  });
  popover.querySelector(".cancel")!.addEventListener("click", close);
  popover.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) popover.requestSubmit();
  });

  popover.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!pending) return;
    const { quote, prefix, suffix } = pending;
    const comment = textarea.value.trim();
    const submit = popover.querySelector<HTMLButtonElement>("button[type=submit]")!;
    submit.disabled = true;
    try {
      const saved = await api<{ id: number; user: string; created_at: number }>(
        "POST",
        "/api/selections",
        {
          version_id: versionId,
          page,
          quote,
          prefix,
          suffix,
          comment,
        },
      );
      list.append(
        listItem(saved.id, saved.user, saved.created_at, { quote, prefix, suffix, comment }),
      );
      window.getSelection()?.removeAllRanges();
      close();
      refresh();
    } catch (err) {
      errorEl.textContent = `Could not save: ${(err as Error).message}`;
    } finally {
      submit.disabled = false;
    }
  });

  list.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    const li = target.closest<HTMLElement>("li.selection");
    if (!li) return;
    if (target.closest(".delete-selection")) {
      try {
        await api("DELETE", `/api/selections/${li.dataset.id}`);
        li.remove();
        refresh();
      } catch (err) {
        alert(`Could not delete: ${(err as Error).message}`);
      }
      return;
    }
    const range = ranges.get(li);
    if (range) {
      const el = range.startContainer.parentElement;
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });

  const refresh = (): void => {
    ranges.clear();
    const index = indexText(article);
    for (const li of list.querySelectorAll<HTMLElement>("li.selection")) {
      const quote = li.dataset.quote ?? "";
      const at = findQuote(index.text, quote, li.dataset.prefix, li.dataset.suffix);
      const range = at >= 0 ? rangeFor(index, at, at + quote.length) : null;
      li.classList.toggle("orphaned", !range);
      if (range) ranges.set(li, range);
    }
    if ("highlights" in CSS) {
      CSS.highlights.set(HIGHLIGHT, new Highlight(...ranges.values()));
    }
  };
  refresh();
}

function listItem(
  id: number,
  user: string,
  createdAt: number,
  s: { quote: string; prefix: string; suffix: string; comment: string },
): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "selection";
  li.dataset.id = String(id);
  li.dataset.quote = s.quote;
  li.dataset.prefix = s.prefix;
  li.dataset.suffix = s.suffix;
  const quote = document.createElement("blockquote");
  quote.textContent = s.quote;
  li.append(quote);
  if (s.comment) {
    const p = document.createElement("p");
    p.textContent = s.comment;
    li.append(p);
  }
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
  li.append(footer);
  initTimes(li);
  return li;
}
