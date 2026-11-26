/**
 * Mermaid diagrams: a fenced code block whose language is `mermaid` is drawn as a diagram.
 *
 * The renderer leaves such a block as code (`<pre><code class="language-mermaid">`), so a
 * page reads the same where this doesn't run or Mermaid can't be loaded. Mermaid comes from
 * a CDN, as one file, and only when a page has a diagram. The browser checks the file
 * against MERMAID_INTEGRITY, and the site's Content-Security-Policy allows that one URL
 * (MERMAID_SCRIPT in src/web/mod.rs, which a test keeps the same as MERMAID_URL). The
 * board's frame allows the CDN's host. Shared by the site (main.ts), the editor's preview
 * (editor.ts) and the Huntaway plugin's pages (huntaway/client/page.ts).
 */

/** To change the version: change it here, and the hash to that of the new file (`openssl dgst -sha384 -binary mermaid.min.js | openssl base64 -A`). */
export const MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@12.3.0/dist/mermaid.min.js";
export const MERMAID_INTEGRITY =
  "sha384-HHW54r639fK42Ip0coGF3mz8oSiGn0eEoWNTLs75X7H63pLSDBa0Tqs0RwGmLlXE";

/** Sent on `document` once diagrams were drawn: the page's text has changed (comments find their quotes again). */
export const DIAGRAMS_EVENT = "docs:diagrams";

/** The part of Mermaid used here. */
interface Mermaid {
  initialize(config: Record<string, unknown>): void;
  render(id: string, source: string): Promise<{ svg: string }>;
}

type Theme = "neutral" | "dark";

let loading: Promise<Mermaid> | undefined;

function load(): Promise<Mermaid> {
  loading ??= new Promise<Mermaid>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = MERMAID_URL;
    script.integrity = MERMAID_INTEGRITY;
    script.crossOrigin = "anonymous";
    script.addEventListener("load", () => {
      const mermaid = (globalThis as { mermaid?: Mermaid }).mermaid;
      if (mermaid) resolve(mermaid);
      else reject(new Error("Mermaid did not start"));
    });
    script.addEventListener("error", () => {
      // Offline, or the CDN is blocked here: the next page (or the next preview) tries again.
      loading = undefined;
      script.remove();
      reject(new Error("Mermaid could not be loaded"));
    });
    document.head.append(script);
  });
  return loading;
}

/** Whether `el` is shown on the dark theme: what `light-dark()` chooses there. */
function themeOf(el: Element): Theme {
  const probe = document.createElement("span");
  probe.hidden = true;
  probe.style.color = "light-dark(rgb(0, 0, 0), rgb(255, 255, 255))";
  el.append(probe);
  const dark = getComputedStyle(probe).color === "rgb(255, 255, 255)";
  probe.remove();
  return dark ? "dark" : "neutral";
}

/** The diagram drawn for a code block, which is the element before it. */
function boxOf(pre: HTMLElement): HTMLElement | null {
  const box = pre.previousElementSibling;
  return box instanceof HTMLElement && box.classList.contains("mermaid-diagram") ? box : null;
}

function errorOf(pre: HTMLElement): HTMLElement | null {
  const note = pre.nextElementSibling;
  return note instanceof HTMLElement && note.classList.contains("mermaid-error") ? note : null;
}

/** Show a block's diagram in its place. The source stays in the page, hidden. */
function show(pre: HTMLElement, theme: Theme, svg: string): void {
  let box = boxOf(pre);
  if (!box) {
    box = document.createElement("div");
    box.className = "mermaid-diagram";
    pre.before(box);
  }
  box.dataset.theme = theme;
  box.innerHTML = svg;
  // A diagram's links (`click A href "…"`) open beside the page, as the editor's preview has them.
  for (const a of box.querySelectorAll("a")) {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  }
  pre.hidden = true;
  errorOf(pre)?.remove();
}

/** Leave a block as code, with why it couldn't be drawn under it. */
function fail(pre: HTMLElement, message: string): void {
  boxOf(pre)?.remove();
  pre.hidden = false;
  const note = errorOf(pre) ?? document.createElement("p");
  note.className = "mermaid-error";
  note.textContent = message;
  pre.after(note);
}

/** Drawn diagrams by theme and source, so a preview that is rendered again doesn't flicker. */
const drawn = new Map<string, string>();
const MAX_DRAWN = 200;
let ids = 0;
/** Mermaid keeps one configuration and measures in the page, so diagrams are drawn one at a time. */
let queue: Promise<void> = Promise.resolve();

interface Todo {
  pre: HTMLElement;
  source: string;
  theme: Theme;
}

async function draw(todo: Todo[]): Promise<boolean> {
  let mermaid: Mermaid;
  try {
    mermaid = await load();
    // Labels are measured in the page's font, so it has to be there.
    await document.fonts.ready;
  } catch (e) {
    for (const { pre } of todo) if (pre.isConnected) fail(pre, messageOf(e));
    return false;
  }
  let changed = false;
  for (const { pre, source, theme } of todo) {
    // A preview may have been replaced while Mermaid was loading.
    if (!pre.isConnected) continue;
    const key = `${theme}\n${source}`;
    try {
      let svg = drawn.get(key);
      if (svg === undefined) {
        mermaid.initialize({
          startOnLoad: false,
          // Mermaid's default, said out loud: it cleans the HTML in labels, and `click` can
          // only be a link, never a script.
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme,
          fontFamily: getComputedStyle(pre.parentElement ?? pre).fontFamily,
        });
        svg = (await mermaid.render(`docs-diagram-${++ids}`, source)).svg;
        if (drawn.size >= MAX_DRAWN) drawn.clear();
        drawn.set(key, svg);
      }
      if (pre.isConnected) show(pre, theme, svg);
    } catch (e) {
      if (pre.isConnected) fail(pre, messageOf(e));
    }
    changed = true;
  }
  return changed;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Draw the Mermaid code blocks in `root` that aren't drawn yet, or were drawn for the other
 * theme. Safe to call again whenever the page or its theme changes.
 */
export function renderDiagrams(root: ParentNode = document): Promise<void> {
  const todo: Todo[] = [];
  let changed = false;
  for (const code of root.querySelectorAll<HTMLElement>("pre > code.language-mermaid")) {
    const pre = code.parentElement as HTMLElement;
    const theme = themeOf(pre.parentElement ?? pre);
    if (pre.hidden && boxOf(pre)?.dataset.theme === theme) continue;
    const source = code.textContent ?? "";
    if (source.trim() === "") continue;
    const svg = drawn.get(`${theme}\n${source}`);
    if (svg === undefined) {
      todo.push({ pre, source, theme });
    } else {
      // Drawn before: put it back at once, before the page is painted.
      show(pre, theme, svg);
      changed = true;
    }
  }
  const tell = (): void => void document.dispatchEvent(new Event(DIAGRAMS_EVENT));
  if (changed) tell();
  if (todo.length === 0) return Promise.resolve();
  queue = queue
    .then(() => draw(todo))
    .then((drew) => {
      if (drew) tell();
    })
    .catch(() => {});
  return queue;
}

/** Draw the page's diagrams, and again in the other theme's colours when the theme changes. */
export function initDiagrams(): void {
  const again = (): void => void renderDiagrams(document);
  again();
  new MutationObserver(again).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class", "style"],
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", again);
}
