/**
 * A mockup's frame, from the inside: showing the mockup's HTML, finding and describing
 * its elements, changing them, and giving the HTML back. It works on the frame's window,
 * which is either another window the editor can reach (the site: a same-origin frame that
 * runs no scripts) or the window this code itself runs in (the Huntaway board: see
 * agent.ts). So it takes everything from `win`, never from the globals, and never tests a
 * node with `instanceof` (a frame's elements aren't this window's).
 *
 * A mockup's scripts never run: the frame doesn't allow them. Taking them out here (with
 * `on…` attributes and the like) keeps what is saved clean and the console quiet.
 */
import { mapCssUrls, quoteOf, selectorSteps, shortText } from "./markup.ts";
import { PROPERTIES } from "./types.ts";
import type {
  Brief,
  Detail,
  FrameCore,
  FrameEvent,
  Measure,
  Path,
  Rect,
  TokenGroup,
  TreeNode,
} from "./types.ts";

const TEXT_NODE = 3;
const XHTML = "http://www.w3.org/1999/xhtml";
/** What a mockup may not bring: things that run, load other documents or change where its URLs point. */
const DROPPED =
  "script,iframe,frame,frameset,object,embed,base,meta[http-equiv],link:not([rel~=stylesheet i])";
const URL_ATTRS = ["href", "src", "action", "formaction", "xlink:href", "poster", "data"];
const SHOWN_ATTRS = ["href", "src", "alt", "placeholder", "value", "title"];
/** Elements with no text of their own to edit. */
const NO_TEXT = new Set([
  "html",
  "head",
  "style",
  "img",
  "input",
  "br",
  "hr",
  "select",
  "textarea",
  "video",
  "audio",
  "canvas",
  "picture",
  "source",
  "meter",
  "progress",
]);
/** The most elements the layers tree lists. */
const MAX_TREE = 4000;

interface TrustedTypes {
  createPolicy(
    name: string,
    rules: { createHTML(s: string): string },
  ): { createHTML(s: string): string };
}

let policy: ReturnType<TrustedTypes["createPolicy"]> | undefined;

/**
 * HTML to parse, through a Trusted Types policy where pages must use one (the board's
 * frames). It is parsed by this window's parser, not the frame's: a parsed document runs
 * nothing either way, and a frame that may run no scripts logs an error for each one it
 * is asked to parse.
 */
function trustedHtml(html: string): string {
  const types = (globalThis as unknown as { trustedTypes?: TrustedTypes }).trustedTypes;
  if (!types) return html;
  policy ??= types.createPolicy("docs-design", { createHTML: (s) => s });
  return policy.createHTML(html);
}

interface Rule {
  cssText: string;
  selectorText?: string;
  conditionText?: string;
  style?: CSSStyleDeclaration;
  cssRules?: ArrayLike<Rule>;
}

export function createCore(win: Window, emit: (event: FrameEvent) => void): FrameCore {
  const doc = win.document;
  const css = (win as unknown as { CSS?: { escape(s: string): string } }).CSS;

  /** What the mockup's references name → where the image is, and back. */
  let images = new Map<string, string>();
  let names = new Map<string, string>();
  /** `<style>` elements whose rules were changed through the CSSOM: their text is stale. */
  const restyled = new Set<Element>();
  let editing: { el: HTMLElement; path: Path; before: string; had: string | null } | null = null;

  const tagOf = (el: Element) => el.localName;
  const isHtml = (el: Element) => el.namespaceURI === XHTML;

  function at(path: Path): Element | null {
    let el: Element | undefined = doc.documentElement;
    for (const i of path) {
      el = el.children[i];
      if (!el) return null;
    }
    return el;
  }

  function pathOf(el: Element): Path {
    const path: Path = [];
    let node = el;
    while (node !== doc.documentElement) {
      const parent = node.parentElement;
      if (!parent) return [];
      path.unshift(Array.prototype.indexOf.call(parent.children, node));
      node = parent;
    }
    return path;
  }

  function labelOf(el: Element): string {
    const id = el.getAttribute("id");
    const classes = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).slice(0, 2);
    return tagOf(el) + (id ? `#${id}` : "") + classes.map((c) => `.${c}`).join("");
  }

  function ownText(el: Element): string {
    let text = "";
    for (const n of el.childNodes) if (n.nodeType === TEXT_NODE) text += n.nodeValue ?? "";
    return text;
  }

  const hasText = (el: Element) =>
    isHtml(el) && !NO_TEXT.has(tagOf(el)) && ownText(el).trim() !== "";

  function rectOf(el: Element): Rect {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  const brief = (el: Element): Brief => ({
    path: pathOf(el),
    rect: rectOf(el),
    label: labelOf(el),
    hasText: hasText(el),
  });

  function selectorOf(el: Element): string {
    const steps: { tag: string; id: string | null; index: number }[] = [];
    for (
      let node: Element | null = el;
      node && node !== doc.documentElement;
      node = node.parentElement
    ) {
      const id = node.getAttribute("id");
      const escaped = id && css ? css.escape(id) : null;
      const unique = escaped !== null && doc.querySelectorAll(`#${escaped}`).length === 1;
      const parent = node.parentElement;
      steps.unshift({
        tag: tagOf(node),
        id: unique ? escaped : null,
        index: parent ? Array.prototype.indexOf.call(parent.children, node) + 1 : 1,
      });
      if (unique) break;
    }
    return selectorSteps(steps);
  }

  /** Runs `change` on every reference to an image in a tree: `src`, `poster`, `srcset` and CSS `url()`s. */
  function eachReference(
    root: ParentNode,
    change: (ref: string) => string | undefined,
    list: (v: string) => string,
  ) {
    for (const el of root.querySelectorAll("[src],[poster],[srcset],[style],style")) {
      for (const name of ["src", "poster"]) {
        const to = el.hasAttribute(name) ? change((el.getAttribute(name) ?? "").trim()) : undefined;
        if (to !== undefined) el.setAttribute(name, to);
      }
      if (el.hasAttribute("srcset"))
        el.setAttribute("srcset", list(el.getAttribute("srcset") ?? ""));
      const style = el.getAttribute("style");
      if (style?.includes("url(")) el.setAttribute("style", mapCssUrls(style, change));
      if (tagOf(el) === "style" && el.textContent?.includes("url(")) {
        el.textContent = mapCssUrls(el.textContent, change);
      }
    }
  }

  function clean(parsed: Document) {
    for (const el of parsed.querySelectorAll(DROPPED)) el.remove();
    for (const el of parsed.querySelectorAll("*")) {
      for (const a of Array.from(el.attributes)) {
        const name = a.name.toLowerCase();
        if (
          name.startsWith("on") ||
          name === "autofocus" ||
          name === "srcdoc" ||
          (URL_ATTRS.includes(name) && /^\s*javascript:/i.test(a.value))
        ) {
          el.removeAttribute(a.name);
        }
      }
    }
    if (!parsed.body) parsed.documentElement.append(parsed.createElement("body"));
  }

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const resized = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => emit({ type: "resize" }), 40);
  };
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resized);

  function finishEdit() {
    if (!editing) return;
    const { el, path, before, had } = editing;
    editing = null;
    if (had === null) el.removeAttribute("contenteditable");
    else el.setAttribute("contenteditable", had);
    win.getSelection()?.removeAllRanges();
    el.blur();
    emit({ type: "edited", path, changed: el.innerHTML !== before });
  }

  function scrollInto(el: Element) {
    // Not scrollIntoView, which would also scroll the page the frame is in.
    const r = el.getBoundingClientRect();
    if (r.top < 0) win.scrollBy(0, r.top - 16);
    else if (r.bottom > win.innerHeight)
      win.scrollBy(0, Math.min(r.top - 16, r.bottom - win.innerHeight + 16));
  }

  // The document stays when a mockup is loaded (only its root element changes), so these do too.
  doc.addEventListener(
    "click",
    (e) => {
      const target = e.target as Element | null;
      const a = target?.closest?.("a[href], area[href]");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href") ?? "";
      const to =
        href.startsWith("#") && href.length > 1
          ? doc.getElementById(decodeURIComponent(href.slice(1)))
          : null;
      if (to) scrollInto(to);
    },
    true,
  );
  doc.addEventListener("submit", (e) => e.preventDefault(), true);
  doc.addEventListener("focusout", (e) => {
    if (editing && e.target === editing.el) finishEdit();
  });
  doc.addEventListener("keydown", (e) => {
    if (editing) {
      if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        finishEdit();
      }
      return;
    }
    const typing = (e.target as Element | null)?.closest?.(
      "input, textarea, select, [contenteditable]",
    );
    if (e.key === "Escape" || (!typing && !e.altKey && e.key.length === 1)) {
      emit({ type: "key", key: e.key, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
    }
  });
  doc.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      emit({ type: "zoom", x: e.clientX, y: e.clientY, delta: e.deltaY });
    },
    { passive: false },
  );
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  doc.addEventListener(
    "scroll",
    () => {
      scrollTimer ??= setTimeout(() => {
        scrollTimer = undefined;
        emit({ type: "scroll" });
      }, 16);
    },
    true,
  );

  /** Every style rule that sets custom properties, in order, with the `<style>` it is in. */
  function tokenRules(): { rule: Rule; label: string; owner: Element }[] {
    const out: { rule: Rule; label: string; owner: Element }[] = [];
    const walk = (rules: ArrayLike<Rule>, context: string, owner: Element) => {
      for (const rule of Array.from(rules)) {
        const style = rule.style;
        if (rule.selectorText !== undefined && style) {
          let custom = false;
          for (let i = 0; i < style.length && !custom; i++) custom = style.item(i).startsWith("--");
          if (custom) out.push({ rule, label: rule.selectorText + context, owner });
        }
        if (rule.cssRules && rule.cssRules.length > 0) {
          const inside =
            rule.selectorText === undefined
              ? ` ${rule.cssText.slice(0, rule.cssText.indexOf("{")).trim()}`
              : "";
          walk(rule.cssRules, context + inside, owner);
        }
      }
    };
    for (const sheet of Array.from(doc.styleSheets)) {
      const owner = sheet.ownerNode as Element | null;
      if (!owner || owner.localName !== "style") continue;
      try {
        walk(sheet.cssRules as unknown as ArrayLike<Rule>, "", owner);
      } catch {
        // A sheet that can't be read has no tokens to show.
      }
    }
    return out;
  }

  const core: FrameCore = {
    load(html, map) {
      finishEdit();
      images = new Map(Object.entries(map));
      names = new Map(Object.entries(map).map(([name, url]) => [url, name]));
      const parsed = new DOMParser().parseFromString(trustedHtml(html), "text/html");
      clean(parsed);
      if (images.size > 0) {
        eachReference(
          parsed,
          (ref) => images.get(ref),
          (srcset) =>
            srcset
              .split(",")
              .map((candidate) => {
                const [url = "", ...rest] = candidate.trim().split(/\s+/);
                return [images.get(url) ?? url, ...rest].join(" ");
              })
              .join(", "),
        );
      }
      restyled.clear();
      doc.replaceChild(doc.adoptNode(parsed.documentElement), doc.documentElement);
      observer?.disconnect();
      observer?.observe(doc.documentElement);
      if (doc.body) observer?.observe(doc.body);
    },

    serialize() {
      // The copy is made in a document that shows nothing, so that putting its images'
      // names back doesn't make the browser go and fetch them.
      const inert = doc.implementation.createHTMLDocument("");
      const clone = inert.importNode(doc.documentElement, true);
      if (editing) {
        // Text being edited in place stays so; the copy is as it will be when that ends.
        let copy: Element | undefined = clone;
        for (const i of editing.path) copy = copy?.children[i];
        if (editing.had === null) copy?.removeAttribute("contenteditable");
        else copy?.setAttribute("contenteditable", editing.had);
      }
      if (restyled.size > 0) {
        const copies = clone.querySelectorAll("style");
        doc.querySelectorAll("style").forEach((style, i) => {
          const copy = copies[i];
          if (!restyled.has(style) || !style.sheet || !copy) return;
          copy.textContent = `\n${Array.from(style.sheet.cssRules, (r) => r.cssText).join("\n")}\n`;
        });
      }
      if (names.size > 0) {
        eachReference(
          clone,
          (ref) => names.get(ref),
          (srcset) => {
            // Not split at commas: where the images are `data:` URLs, they have commas too.
            let out = srcset;
            for (const [url, name] of names) out = out.split(url).join(name);
            return out;
          },
        );
      }
      for (const el of clone.querySelectorAll('[style=""]')) el.removeAttribute("style");
      // Nothing after `</html>`: it would be read back as text at the end of the body, so a
      // mockup shown from this again wouldn't give the same HTML.
      return `<!doctype html>\n${clone.outerHTML}`;
    },

    measure(): Measure {
      const html = doc.documentElement;
      const scroll = Math.max(html.scrollHeight, doc.body?.scrollHeight ?? 0);
      const scrollable = scroll > win.innerHeight + 1;
      // Content taller than the frame says how tall it is by how far it scrolls; shorter
      // content, by how tall the page's own box is.
      return {
        height: scrollable ? scroll : Math.ceil(html.getBoundingClientRect().height),
        scrollable,
      };
    },

    hit(x, y) {
      let el = doc.elementFromPoint(x, y);
      if (!el) return null;
      if (el === doc.documentElement && doc.body) el = doc.body;
      return brief(el);
    },

    briefs(paths) {
      return paths.map((p) => {
        const el = at(p);
        return el ? brief(el) : null;
      });
    },

    detail(path) {
      const el = at(path);
      if (!el) return null;
      const computed: Record<string, string> = {};
      const used = win.getComputedStyle(el);
      for (const p of PROPERTIES) computed[p] = used.getPropertyValue(p);
      const inline: Record<string, string> = {};
      const style = (el as HTMLElement).style as CSSStyleDeclaration | undefined;
      if (style) {
        for (let i = 0; i < style.length; i++) {
          const name = style.item(i);
          const priority = style.getPropertyPriority(name);
          inline[name] = style.getPropertyValue(name) + (priority ? ` !${priority}` : "");
        }
      }
      const attrs: Record<string, string> = {};
      for (const name of SHOWN_ATTRS) {
        const value = el.getAttribute(name);
        if (value === null) continue;
        const named = names.get(value) ?? value;
        attrs[name] = named.length > 2000 ? `${named.slice(0, 60)}…` : named;
      }
      const crumbs: Detail["crumbs"] = [];
      for (
        let node = el.parentElement;
        node && node !== doc.documentElement;
        node = node.parentElement
      ) {
        crumbs.unshift({ path: pathOf(node), label: labelOf(node) });
      }
      const leaf =
        el.childElementCount === 0 && isHtml(el) && !NO_TEXT.has(tagOf(el)) && tagOf(el) !== "body";
      return {
        ...brief(el),
        tag: tagOf(el),
        crumbs,
        text: leaf ? (el.textContent ?? "") : null,
        attrs,
        computed,
        inline,
        selector: selectorOf(el),
        quote: quoteOf(
          tagOf(el),
          el.getAttribute("id"),
          el.getAttribute("class"),
          el.textContent ?? "",
          {
            src: names.get(el.getAttribute("src") ?? "") ?? el.getAttribute("src"),
            alt: el.getAttribute("alt"),
            href: el.getAttribute("href"),
          },
        ),
      };
    },

    tree() {
      if (!doc.body) return null;
      let count = 0;
      const node = (el: Element): TreeNode => {
        count += 1;
        const children: TreeNode[] = [];
        // An SVG is one layer: its shapes aren't worth a row each.
        if (isHtml(el)) {
          for (const child of el.children) {
            if (count >= MAX_TREE) break;
            if (child.localName !== "style" && child.localName !== "template")
              children.push(node(child));
          }
        }
        return { path: pathOf(el), label: labelOf(el), text: shortText(ownText(el), 40), children };
      };
      return node(doc.body);
    },

    setStyle(path, property, value) {
      const el = at(path) as HTMLElement | null;
      if (!el?.style) return;
      const text = (value ?? "").trim();
      if (text === "") {
        el.style.removeProperty(property);
      } else {
        const important = /\s*!important\s*$/i;
        el.style.setProperty(
          property,
          text.replace(important, ""),
          important.test(text) ? "important" : "",
        );
      }
      if (el.getAttribute("style") === "") el.removeAttribute("style");
    },

    setText(path, text) {
      const el = at(path);
      if (el && el.childElementCount === 0) el.textContent = text;
    },

    setAttr(path, name, value) {
      const el = at(path);
      const attr = name.toLowerCase();
      if (!el || attr.startsWith("on") || attr === "srcdoc" || attr === "style") return;
      if (value === null) return el.removeAttribute(name);
      if (URL_ATTRS.includes(attr) && /^\s*javascript:/i.test(value)) return;
      el.setAttribute(
        name,
        (attr === "src" || attr === "poster" ? images.get(value.trim()) : undefined) ?? value,
      );
    },

    remove(path) {
      const el = at(path);
      const parent = el?.parentElement;
      if (!el || !parent || parent === doc.documentElement) return null;
      const up = pathOf(parent);
      el.remove();
      return up;
    },

    duplicate(path) {
      const el = at(path);
      if (!el?.parentElement || el.parentElement === doc.documentElement) return null;
      const copy = el.cloneNode(true) as Element;
      // Two elements can't share an id.
      copy.removeAttribute("id");
      el.after(copy);
      return pathOf(copy);
    },

    move(path, by) {
      const el = at(path);
      const parent = el?.parentElement;
      if (!el || !parent || parent === doc.documentElement) return null;
      const from = Array.prototype.indexOf.call(parent.children, el);
      const to = Math.max(0, Math.min(parent.children.length - 1, from + by));
      const other = parent.children[to];
      if (to === from || !other) return path;
      if (to < from) other.before(el);
      else other.after(el);
      return pathOf(el);
    },

    editText(path, x, y) {
      finishEdit();
      const el = at(path) as HTMLElement | null;
      if (!el || !hasText(el)) return false;
      editing = { el, path, before: el.innerHTML, had: el.getAttribute("contenteditable") };
      el.setAttribute("contenteditable", "plaintext-only");
      if (el.contentEditable !== "plaintext-only") el.setAttribute("contenteditable", "true");
      el.focus({ preventScroll: true });
      const selection = win.getSelection();
      const range = doc.createRange();
      const point = doc as Document & {
        caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
      };
      const caret =
        x === undefined || y === undefined ? null : (point.caretPositionFromPoint?.(x, y) ?? null);
      if (caret && el.contains(caret.offsetNode)) {
        range.setStart(caret.offsetNode, caret.offset);
        range.collapse(true);
      } else {
        range.selectNodeContents(el);
      }
      selection?.removeAllRanges();
      selection?.addRange(range);
      return true;
    },

    stopEdit: finishEdit,

    tokens() {
      return tokenRules().map(({ rule, label }, id): TokenGroup => {
        const tokens: TokenGroup["tokens"] = [];
        const style = rule.style;
        for (let i = 0; style && i < style.length; i++) {
          const name = style.item(i);
          if (name.startsWith("--"))
            tokens.push({ name, value: style.getPropertyValue(name).trim() });
        }
        return { id, label, tokens };
      });
    },

    setToken(group, name, value) {
      const found = tokenRules()[group];
      if (!found?.rule.style || !name.startsWith("--") || value.trim() === "") return;
      found.rule.style.setProperty(name, value.trim());
      restyled.add(found.owner);
    },

    resolve(selector) {
      try {
        const el = doc.querySelector(selector);
        return el ? pathOf(el) : null;
      } catch {
        return null;
      }
    },

    scrollBy(dx, dy) {
      const before = [win.scrollX, win.scrollY];
      win.scrollBy(dx, dy);
      return win.scrollX !== before[0] || win.scrollY !== before[1];
    },

    reveal(path) {
      const el = at(path);
      if (el) scrollInto(el);
    },
  };
  return core;
}
