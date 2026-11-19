/**
 * The document editor: people edit a document's pages themselves, CMS-style, and save
 * them as a new version. A menu of the pages (add, rename, reorder, delete), a Markdown
 * toolbar, the source beside a live preview rendered by the server, and images uploaded
 * by choosing, pasting or dropping them. Saving publishes every page as the next version,
 * unless someone published one since the editor opened, which it says first.
 *
 * The same editor runs on the hosted site (editor-site.ts) and in the Huntaway plugin's
 * pages (huntaway/client/page.ts): each gives it an `EditorBackend` to preview and save.
 */
import {
  continueList,
  imageCandidates,
  imageName,
  indentLines,
  insertBlock,
  insertText,
  link,
  pagePath,
  prefixLines,
  wrap,
} from "./markdown-edit.ts";
import type { TextState } from "./markdown-edit.ts";

export type PageFormat = "md" | "mdx";

export interface EditorPage {
  path: string;
  title: string;
  format: PageFormat;
  content: string;
}

/** What the page gives the editor (as JSON in the page). */
export interface EditorData {
  /** A new document (it has no versions yet). */
  isNew: boolean;
  title: string;
  /** The folder a new document goes in. */
  folder: string;
  /** The version the editor opened, to notice one published since; null for a new document. */
  baseVersion: number | null;
  pages: EditorPage[];
  /** The page to open first. */
  open: string;
  /** The images the document has already, by name. */
  images: string[];
  /** Where Cancel (and Escape out of nothing) goes. */
  cancelUrl: string;
}

export interface PreviewResult {
  html: string | null;
  hasH1: boolean;
  warnings: string[];
  error: string | null;
}

export interface SaveRequest {
  base_version: number | null;
  title: string;
  folder: string | null;
  message: string | null;
  pages: { path: string; title: string | null; format: PageFormat; content: string }[];
  /** Images uploaded in the editor that a page uses, base64. */
  images: { name: string; data: string }[];
}

export type SaveResult =
  | { url: string; version: number; warnings: { page: string; warning: string }[] }
  /** Someone published `latest` since the editor opened. */
  | { conflict: number; message: string };

export interface EditorBackend {
  preview(page: { path: string; format: PageFormat; content: string }): Promise<PreviewResult>;
  save(request: SaveRequest): Promise<SaveResult>;
  /** Leave the editor for a URL (after saving, or on Cancel). */
  go(url: string): void;
}

/** Images the server converts (SVG and the rest are refused). */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"];
/** The most the editor uploads of one image (the server checks the AVIF it makes from it). */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

interface Upload {
  name: string;
  data: string;
  url: string;
}

type El<K extends keyof HTMLElementTagNameMap> = HTMLElementTagNameMap[K];

/** An element with attributes (`on…` functions become listeners) and children. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | number | ((e: Event) => void) | undefined> = {},
  ...children: (Node | string | null | false)[]
): El<K> {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "className") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== false) el.append(c);
  return el;
}

const COMPONENTS: { label: string; block: string; select?: string }[] = [
  {
    label: "Callout",
    block: '<Callout type="info" title="Note">\n  Text of the callout.\n</Callout>',
    select: "Text of the callout.",
  },
  {
    label: "Collapsible section",
    block: '<Details summary="More">\n\nHidden until opened.\n\n</Details>',
    select: "Hidden until opened.",
  },
  {
    label: "Approval",
    block: '<Approval name="approve" label="Approve this?" />',
    select: "Approve this?",
  },
  {
    label: "Text input",
    block: '<TextInput name="answer" label="Your question" />',
    select: "Your question",
  },
  {
    label: "Text area",
    block: '<TextArea name="notes" label="Your question" rows={3} />',
    select: "Your question",
  },
  {
    label: "Choice (radio)",
    block: '<RadioGroup name="choice" label="Which one?" options={["One", "Two"]} other />',
    select: "Which one?",
  },
  {
    label: "Checkboxes",
    block: '<CheckboxGroup name="picks" label="Which ones?" options={["One", "Two"]} />',
    select: "Which ones?",
  },
  {
    label: "Select",
    block: '<Select name="pick" label="Pick one" options={["One", "Two"]} />',
    select: "Pick one",
  },
  { label: "Checkbox", block: '<Checkbox name="agree" label="I agree" />', select: "I agree" },
  {
    label: "Scale",
    block:
      '<Scale name="confidence" label="How confident are you?" minLabel="Not at all" maxLabel="Very" />',
    select: "How confident are you?",
  },
];

const TABLE = "| Column | Column |\n| ------ | ------ |\n| Cell   | Cell   |";

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The base64 of a file, and it as a `data:` URL for the preview. */
function readFile(file: Blob): Promise<{ data: string; url: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      resolve({ url, data: url.slice(url.indexOf(",") + 1) });
    };
    reader.onerror = () => reject(reader.error ?? new Error("couldn't read the file"));
    reader.readAsDataURL(file);
  });
}

/** Build the editor in `root`. Returns whether it has unsaved changes (for a page leaving). */
export function mountEditor(
  root: HTMLElement,
  data: EditorData,
  backend: EditorBackend,
): { dirty(): boolean } {
  const pages: EditorPage[] =
    data.pages.length > 0 ? data.pages.map((p) => ({ ...p })) : [newPage("index", "")];
  let current = Math.max(
    0,
    pages.findIndex((p) => p.path === data.open),
  );
  const uploads = new Map<string, Upload>();
  const existing = new Set(data.images);
  let baseVersion = data.baseVersion;
  let saving = false;
  let saved = false;

  function newPage(path: string, title: string): EditorPage {
    return { path, title, format: "md", content: title === "" ? "" : `# ${title}\n\n` };
  }
  const snapshot = () =>
    JSON.stringify([title.value, folder?.value ?? "", pages, [...uploads.keys()]]);

  // ---- the bar: title, message, save ---------------------------------------------------------------------------------
  const title = h("input", {
    className: "editor-title",
    type: "text",
    value: data.title,
    placeholder: "Document title",
    "aria-label": "Document title",
    maxlength: 200,
  });
  const folder = data.isNew
    ? h("input", {
        type: "text",
        value: data.folder,
        placeholder: "Top level",
        "aria-label": "Folder",
        size: 18,
      })
    : null;
  const message = h("input", {
    className: "editor-message",
    type: "text",
    placeholder: data.isNew ? "Note (optional)" : "What did you change? (optional)",
    "aria-label": "What changed",
    maxlength: 500,
  });
  const status = h("span", { className: "editor-status", role: "status" });
  const saveButton = h(
    "button",
    { type: "button", className: "primary", onclick: () => void save() },
    "Save",
  );
  const cancel = h(
    "button",
    {
      type: "button",
      onclick: () => {
        if (!isDirty() || confirm("Leave without saving your changes?")) {
          saved = true;
          backend.go(data.cancelUrl);
        }
      },
    },
    "Cancel",
  );
  const errorBox = h("div", { className: "editor-error", role: "alert", hidden: true });

  // ---- the pages ----------------------------------------------------------------------------------------------------
  const pageList = h("ul", { className: "editor-page-list" });
  const addPage = h(
    "button",
    {
      type: "button",
      className: "link",
      onclick: () => {
        const taken = new Set(pages.map((p) => p.path));
        let path = "new-page";
        for (let n = 2; taken.has(path); n++) path = `new-page-${n}`;
        pages.push(newPage(path, "New page"));
        select(pages.length - 1);
        pathInput.focus();
        pathInput.select();
        changed();
      },
    },
    "+ Add a page",
  );

  // ---- the page's settings ------------------------------------------------------------------------------------------
  const pathInput = h("input", {
    type: "text",
    "aria-label": "Page path",
    title:
      "Where the page is in the document: index is the first page, plan/phase-1 is in the plan section",
    size: 20,
  });
  const pageTitle = h("input", {
    type: "text",
    placeholder: "From its first heading",
    "aria-label": "Page title",
    size: 24,
  });
  const formatSelect = h(
    "select",
    { "aria-label": "Format" },
    h("option", { value: "md" }, "Markdown"),
    h("option", { value: "mdx" }, "MDX (components)"),
  );
  const up = h(
    "button",
    { type: "button", title: "Move up in the menu", "aria-label": "Move page up" },
    "↑",
  );
  const down = h(
    "button",
    { type: "button", title: "Move down in the menu", "aria-label": "Move page down" },
    "↓",
  );
  const remove = h("button", { type: "button", className: "link danger" }, "Delete page");
  const pathError = h("span", { className: "editor-field-error" });

  // ---- the toolbar, source and preview -----------------------------------------------------------------------------
  const source = h("textarea", {
    className: "editor-source",
    spellcheck: true,
    "aria-label": "Page source (Markdown)",
  });
  const preview = h("div", {
    className: "editor-preview docs-render",
    "aria-label": "Preview",
    tabindex: 0,
  });
  const previewNotes = h("div", { className: "editor-preview-notes" });
  const fileInput = h("input", {
    type: "file",
    accept: IMAGE_TYPES.join(","),
    multiple: true,
    hidden: true,
  });
  const componentMenu = h(
    "select",
    {
      className: "editor-components",
      "aria-label": "Insert a component",
      title: "Components (MDX)",
    },
    h("option", { value: "" }, "Insert…"),
    ...COMPONENTS.map((c, i) => h("option", { value: String(i) }, c.label)),
  );

  const tool = (label: string, name: string, run: () => void, keys?: string) =>
    h(
      "button",
      {
        type: "button",
        className: "editor-tool",
        title: keys ? `${name} (${keys})` : name,
        "aria-label": name,
        onmousedown: (e) => e.preventDefault(),
        onclick: run,
      },
      label,
    );
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
  const toolbar = h(
    "div",
    { className: "editor-toolbar", role: "toolbar", "aria-label": "Formatting" },
    tool("H2", "Heading", () => edit((s) => prefixLines(s, "## "))),
    tool("H3", "Subheading", () => edit((s) => prefixLines(s, "### "))),
    tool("B", "Bold", () => edit((s) => wrap(s, "**", "**", "bold text")), `${mod}B`),
    tool("I", "Italic", () => edit((s) => wrap(s, "_", "_", "italic text")), `${mod}I`),
    tool("</>", "Code", () => edit((s) => wrap(s, "`", "`", "code"))),
    tool("🔗", "Link", () => edit((s) => link(s)), `${mod}K`),
    h("span", { className: "editor-sep" }),
    tool("•", "Bulleted list", () => edit((s) => prefixLines(s, "- "))),
    tool("1.", "Numbered list", () => edit((s) => prefixLines(s, "1. "))),
    tool("☐", "Task list", () => edit((s) => prefixLines(s, "- [ ] "))),
    tool("❝", "Quote", () => edit((s) => prefixLines(s, "> "))),
    h("span", { className: "editor-sep" }),
    tool("{ }", "Code block", () =>
      edit((s) => {
        const code = s.value.slice(s.start, s.end) || "code";
        return insertBlock({ ...s, start: s.start, end: s.end }, "```\n" + code + "\n```", code);
      }),
    ),
    tool("▦", "Table", () => edit((s) => insertBlock(s, TABLE, "Column"))),
    tool("―", "Divider", () => edit((s) => insertBlock(s, "---"))),
    tool("🖼", "Image", () => fileInput.click()),
    componentMenu,
    h("span", { className: "grow" }),
  );
  const modes = h("div", { className: "editor-modes", role: "group", "aria-label": "View" });
  for (const m of ["write", "split", "preview"] as const) {
    modes.append(
      h(
        "button",
        {
          type: "button",
          "data-mode": m,
          onclick: () => setMode(m),
        },
        m === "write" ? "Write" : m === "split" ? "Split" : "Preview",
      ),
    );
  }
  toolbar.append(modes);

  const panes = h(
    "div",
    { className: "editor-panes" },
    source,
    h("div", { className: "editor-preview-wrap" }, previewNotes, preview),
  );

  root.replaceChildren(
    h(
      "div",
      { className: "editor" },
      h(
        "header",
        { className: "editor-bar" },
        title,
        folder ? h("label", { className: "editor-folder" }, "Folder ", folder) : null,
        message,
        status,
        cancel,
        saveButton,
      ),
      errorBox,
      h(
        "nav",
        { className: "editor-pages", "aria-label": "Pages" },
        h("h2", {}, "Pages"),
        pageList,
        addPage,
        h(
          "p",
          { className: "editor-hint" },
          "Saving publishes every page as a new version. Earlier versions, with their comments and answers, stay readable.",
        ),
      ),
      h(
        "section",
        { className: "editor-main" },
        h(
          "div",
          { className: "editor-page-fields" },
          h("label", {}, "Path ", pathInput),
          h("label", {}, "Title ", pageTitle),
          formatSelect,
          up,
          down,
          h("span", { className: "grow" }),
          remove,
        ),
        pathError,
        toolbar,
        panes,
        fileInput,
      ),
    ),
  );

  // ---- state ----------------------------------------------------------------------------------------------------------
  const initial = snapshot();
  const isDirty = () => !saved && snapshot() !== initial;
  const changed = () => {
    if (!saving) status.textContent = isDirty() ? "Unsaved changes" : "";
    renderList();
  };

  function renderList(): void {
    pageList.replaceChildren(
      ...pages.map((p, i) =>
        h(
          "li",
          {},
          h(
            "button",
            {
              type: "button",
              className: i === current ? "on" : "",
              "aria-current": i === current ? "page" : undefined,
              onclick: () => select(i),
            },
            h("span", { className: "editor-page-title" }, p.title.trim() || p.path),
            h("span", { className: "editor-page-path" }, p.path),
          ),
        ),
      ),
    );
  }

  function select(i: number): void {
    current = Math.min(Math.max(i, 0), pages.length - 1);
    const p = pages[current]!;
    pathInput.value = p.path;
    pageTitle.value = p.title;
    formatSelect.value = p.format;
    source.value = p.content;
    source.setSelectionRange(0, 0);
    source.scrollTop = 0;
    up.disabled = current === 0;
    down.disabled = current === pages.length - 1;
    remove.disabled = pages.length === 1;
    checkPath();
    renderList();
    schedulePreview(0);
  }
  const page = () => pages[current]!;

  function checkPath(): boolean {
    const path = pagePath(pathInput.value);
    const clash = pages.some((p, i) => i !== current && p.path === path);
    pathError.textContent = clash ? `Another page is at “${path}” already.` : "";
    pathInput.classList.toggle("invalid", clash);
    return !clash;
  }

  pathInput.addEventListener("input", () => {
    if (checkPath()) {
      page().path = pagePath(pathInput.value);
      changed();
      schedulePreview();
    }
  });
  pathInput.addEventListener("change", () => {
    if (checkPath()) pathInput.value = page().path;
  });
  pageTitle.addEventListener("input", () => {
    page().title = pageTitle.value;
    changed();
  });
  formatSelect.addEventListener("change", () => {
    page().format = formatSelect.value === "mdx" ? "mdx" : "md";
    changed();
    schedulePreview(0);
  });
  title.addEventListener("input", changed);
  folder?.addEventListener("input", changed);
  up.addEventListener("click", () => move(-1));
  down.addEventListener("click", () => move(1));
  function move(by: number): void {
    const to = current + by;
    if (to < 0 || to >= pages.length) return;
    const [p] = pages.splice(current, 1);
    pages.splice(to, 0, p!);
    select(to);
    changed();
  }
  remove.addEventListener("click", () => {
    if (pages.length === 1) return;
    const p = page();
    if (
      p.content.trim() !== "" &&
      !confirm(`Delete the page “${p.title || p.path}”? It stays in earlier versions.`)
    )
      return;
    pages.splice(current, 1);
    select(Math.min(current, pages.length - 1));
    changed();
  });

  // ---- editing the source -------------------------------------------------------------------------------------------
  const stateOf = (): TextState => ({
    value: source.value,
    start: source.selectionStart,
    end: source.selectionEnd,
  });

  /** Apply a change to the source the way typing would, so the browser's undo can take it back. */
  function apply(next: TextState): void {
    const old = source.value;
    if (next.value !== old) {
      let a = 0;
      while (a < old.length && a < next.value.length && old[a] === next.value[a]) a++;
      let b = 0;
      while (
        b < old.length - a &&
        b < next.value.length - a &&
        old[old.length - 1 - b] === next.value[next.value.length - 1 - b]
      )
        b++;
      source.focus();
      source.setSelectionRange(a, old.length - b);
      const text = next.value.slice(a, next.value.length - b);
      // execCommand keeps the change in the undo history; where it's gone, set the text.
      const done =
        text === ""
          ? document.execCommand("delete")
          : document.execCommand("insertText", false, text);
      if (!done || source.value !== next.value) source.value = next.value;
    }
    source.focus();
    source.setSelectionRange(next.start, next.end);
    onSourceInput();
  }
  const edit = (f: (s: TextState) => TextState) => apply(f(stateOf()));

  function onSourceInput(): void {
    if (page().content === source.value) return;
    page().content = source.value;
    changed();
    schedulePreview();
  }
  source.addEventListener("input", onSourceInput);

  source.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      if (key === "b") edit((s) => wrap(s, "**", "**", "bold text"));
      else if (key === "i") edit((s) => wrap(s, "_", "_", "italic text"));
      else if (key === "k") edit((s) => link(s));
      else return;
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      const next = continueList(stateOf());
      if (next) {
        e.preventDefault();
        apply(next);
      }
      return;
    }
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Tab indents list items; elsewhere it moves on, as it does in any form.
      const s = stateOf();
      const line = s.value.slice(s.value.lastIndexOf("\n", s.start - 1) + 1);
      if (/^\s*([-*+]|\d+[.)]) /.test(line)) {
        e.preventDefault();
        apply(indentLines(s, e.shiftKey));
      }
    }
  });

  componentMenu.addEventListener("change", () => {
    const c = COMPONENTS[Number(componentMenu.value)];
    componentMenu.value = "";
    if (!c) return;
    if (page().format !== "mdx") {
      // Components need MDX; a Markdown page would show the tag as text.
      page().format = "mdx";
      formatSelect.value = "mdx";
      status.textContent = "This page is MDX now, so components work";
    }
    edit((s) => insertBlock(s, c.block, c.select));
  });

  // ---- images ---------------------------------------------------------------------------------------------------------
  async function addImages(files: File[]): Promise<void> {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    const refs: string[] = [];
    for (const f of images) {
      if (!IMAGE_TYPES.includes(f.type)) {
        showError(`${f.name || "That image"} is ${f.type}: use PNG, JPEG, WebP, GIF or AVIF.`);
        continue;
      }
      if (f.size > MAX_UPLOAD_BYTES) {
        showError(`${f.name || "That image"} is too big to upload (over 20 MB).`);
        continue;
      }
      const taken = new Set([...existing, ...uploads.keys()]);
      const name = imageName(f.name || "pasted", taken, f.type);
      const read = await readFile(f);
      uploads.set(name, { name, ...read });
      const alt = (f.name || "image").replace(/\.[^.]*$/, "").replace(/[[\]]/g, "");
      refs.push(`![${alt}](${name})`);
    }
    if (refs.length > 0) {
      edit((s) => insertText(s, refs.join("\n\n")));
      status.textContent = "Images are converted to AVIF (at most 500 KB each) when you save";
    }
  }
  fileInput.addEventListener("change", () => {
    void addImages([...(fileInput.files ?? [])]);
    fileInput.value = "";
  });
  source.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.some((f) => f.type.startsWith("image/"))) {
      e.preventDefault();
      void addImages(files);
    }
  });
  source.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
      source.classList.add("dropping");
    }
  });
  source.addEventListener("dragleave", () => source.classList.remove("dropping"));
  source.addEventListener("drop", (e) => {
    source.classList.remove("dropping");
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length > 0) {
      e.preventDefault();
      void addImages(files);
    }
  });

  // ---- preview ------------------------------------------------------------------------------------------------------
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  function schedulePreview(delay = 300): void {
    clearTimeout(timer);
    timer = setTimeout(() => void renderPreview(), delay);
  }
  async function renderPreview(): Promise<void> {
    if (mode === "write") return;
    const p = page();
    const mine = ++seq;
    let out: PreviewResult;
    try {
      out = await backend.preview({ path: p.path, format: p.format, content: p.content });
    } catch (e) {
      out = { html: null, hasH1: false, warnings: [], error: messageOf(e) };
    }
    if (mine !== seq) return;
    previewNotes.replaceChildren(
      ...(out.error === null ? [] : [h("p", { className: "render-error" }, out.error)]),
      ...out.warnings.map((w) => h("p", { className: "render-warning" }, `⚠ ${w}`)),
    );
    if (out.html === null) return;
    const t = document.createElement("template");
    t.innerHTML = out.html;
    // Images uploaded in the editor aren't on the server yet: show them from here.
    for (const img of t.content.querySelectorAll("img")) {
      const src = img.getAttribute("src") ?? "";
      const hit = imageCandidates(p.path, src).find((n) => uploads.has(n));
      if (hit) img.src = uploads.get(hit)!.url;
    }
    // Links in the preview would leave the editor.
    for (const a of t.content.querySelectorAll("a[href]")) {
      if (!a.getAttribute("href")?.startsWith("#")) a.setAttribute("target", "_blank");
    }
    const article = h("div", { className: "doc-content" });
    if (!out.hasH1 && p.title.trim() !== "") article.append(h("h1", {}, p.title));
    article.append(t.content);
    const top = preview.scrollTop;
    preview.replaceChildren(article);
    preview.scrollTop = top;
  }

  // Scrolling the source scrolls the preview to the same place, roughly.
  source.addEventListener("scroll", () => {
    if (mode !== "split") return;
    const max = source.scrollHeight - source.clientHeight;
    if (max > 0)
      preview.scrollTop = (source.scrollTop / max) * (preview.scrollHeight - preview.clientHeight);
  });

  type Mode = "write" | "split" | "preview";
  let mode: Mode = "split";
  function setMode(m: Mode): void {
    mode = m;
    panes.dataset.mode = m;
    for (const b of modes.querySelectorAll<HTMLButtonElement>("button")) {
      b.classList.toggle("on", b.dataset.mode === m);
      b.setAttribute("aria-pressed", String(b.dataset.mode === m));
    }
    try {
      localStorage.setItem("docs-editor-mode", m);
    } catch {
      // not remembered
    }
    if (m !== "write") schedulePreview(0);
  }
  let stored: string | null = null;
  try {
    stored = localStorage.getItem("docs-editor-mode");
  } catch {
    // storage off
  }
  setMode(stored === "write" || stored === "preview" ? stored : "split");

  // ---- saving ---------------------------------------------------------------------------------------------------------
  function showError(text: string): void {
    errorBox.replaceChildren(text);
    errorBox.hidden = false;
  }

  async function save(): Promise<void> {
    if (saving) return;
    errorBox.hidden = true;
    if (!checkPath()) return showError("Two pages have the same path: change one of them.");
    if (title.value.trim() === "") {
      title.focus();
      return showError("Give the document a title.");
    }
    const used = (name: string) =>
      pages.some((p) => p.content.includes(name.slice(name.lastIndexOf("/") + 1)));
    const request: SaveRequest = {
      base_version: baseVersion,
      title: title.value.trim(),
      folder: folder ? folder.value : null,
      message: message.value.trim() === "" ? null : message.value.trim(),
      pages: pages.map((p) => ({
        path: p.path,
        title: p.title.trim() === "" ? null : p.title.trim(),
        format: p.format,
        content: p.content,
      })),
      images: [...uploads.values()]
        .filter((u) => used(u.name))
        .map((u) => ({ name: u.name, data: u.data })),
    };
    saving = true;
    saveButton.disabled = true;
    status.textContent = request.images.length > 0 ? "Saving (converting images)…" : "Saving…";
    try {
      const out = await backend.save(request);
      if ("conflict" in out) {
        status.textContent = "";
        const overwrite = h(
          "button",
          {
            type: "button",
            onclick: () => {
              baseVersion = out.conflict;
              void save();
            },
          },
          `Save over version ${out.conflict}`,
        );
        errorBox.replaceChildren(
          `${out.message} Saving now replaces it with your pages (it stays in the version history). `,
          overwrite,
        );
        errorBox.hidden = false;
        return;
      }
      saved = true;
      status.textContent = `Saved as version ${out.version}`;
      backend.go(out.url);
    } catch (e) {
      status.textContent = "";
      showError(messageOf(e));
    } finally {
      saving = false;
      saveButton.disabled = false;
    }
  }

  root.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
    }
  });

  select(current);
  changed();
  if (data.isNew) title.focus();
  else source.focus();
  return { dirty: isDirty };
}
