/**
 * The design editor: a document's mockups (its HTML pages) as frames on a canvas to pan
 * and zoom, each at a device's width. Click an element to inspect it and change its text,
 * type, colours, spacing and layout; tune the CSS custom properties the mockup defines;
 * edit its HTML; comment on elements for the agent. Every change shows at once in the
 * frame, can be undone, and is saved with the others as the document's next version.
 *
 * The same editor runs on the hosted site (design-site.ts) and in the Huntaway plugin's
 * pages (huntaway/client/page.ts): each gives it a `DesignBackend` to hold the frames,
 * save and comment. A mockup's frame runs none of the mockup's scripts (see frames.ts).
 */
import { clamp, fitView, revealView, zoomAt } from "./geometry.ts";
import type { View } from "./geometry.ts";
import { createInspector } from "./inspector.ts";
import { shortText, urlSuffix } from "./markup.ts";
import type {
  Brief,
  Detail,
  FrameDriver,
  FrameEvent,
  Path,
  Rect,
  TokenGroup,
  TreeNode,
} from "./types.ts";
import { colorOf, h, messageOf, shortTime } from "./ui.ts";

export interface DesignPage {
  path: string;
  title: string;
  /** The mockup's HTML. */
  content: string;
  /** What its `src`s and `url()`s name among the document's images → where each is. */
  images: Record<string, string>;
}

export interface DesignComment {
  id: number;
  page: string;
  /** The element's tag and text. */
  quote: string;
  /** A CSS selector for the element. */
  anchor: string;
  comment: string;
  user: string;
  /** Whether the reader may delete it. */
  mine: boolean;
  created_at: number | string;
  /** On the board: whether it has been sent to the task. */
  sent?: boolean;
}

/** What the page gives the editor (as JSON in the page). */
export interface DesignData {
  title: string;
  version: number;
  latestVersion: number;
  /** The mockup to show first. */
  open: string;
  pages: DesignPage[];
  /** The document's other pages, to go to. */
  others: { title: string; url: string }[];
  comments: DesignComment[];
  /** Whether changes can be saved as a new version (the reader may edit, and this is the latest). */
  canEdit: boolean;
  canComment: boolean;
  links: {
    /** The documents list. */
    home: string;
    /** This page in the latest version, when this isn't it. */
    latest: string | null;
    versions: string | null;
    /** The document's pages as text, in the document editor. */
    source: string | null;
    /** The document's own page (its labels, versions, sharing and the like), with this mockup named in it. */
    details: string | null;
  };
}

export interface DesignDraft {
  version: number;
  /** The changed mockups' HTML, by page path. */
  pages: Record<string, string>;
  savedAt: string;
}

export interface DesignSave {
  base_version: number;
  message: string | null;
  /** Only the mockups that changed: the document's other pages stay as they are. */
  pages: { path: string; title: string; format: "html"; content: string }[];
}

export type DesignSaved =
  | { url: string; version: number }
  /** Someone published `conflict` since the editor opened. */
  | { conflict: number; message: string };

export interface DesignBackend {
  /** Takes a frame that is in the page and makes it one the editor can show a mockup in. */
  frame(iframe: HTMLIFrameElement): Promise<FrameDriver>;
  save?: ((request: DesignSave) => Promise<DesignSaved>) | undefined;
  addComment?:
    | ((comment: {
        page: string;
        quote: string;
        anchor: string;
        comment: string;
      }) => Promise<DesignComment>)
    | undefined;
  deleteComment?: ((id: number) => Promise<void>) | undefined;
  /** Where comments are sent on to once written (the board's task), if they are. */
  send?: { to: string; run(): Promise<void> } | undefined;
  /** Leave for a URL (after saving). */
  go(url: string): void;
  drafts?:
    | {
        load(): Promise<DesignDraft | null>;
        save(draft: DesignDraft): Promise<void>;
        clear(): Promise<void>;
      }
    | undefined;
}

const PRESETS = [
  { id: "desktop", label: "Desktop", width: 1440, height: 900 },
  { id: "laptop", label: "Laptop", width: 1280, height: 800 },
  { id: "tablet", label: "Tablet", width: 768, height: 1024 },
  { id: "phone", label: "Phone", width: 390, height: 844 },
] as const;
/** The space between frames, and above them for their names. */
const GAP = 120;
/** No frame grows taller than this to fit its content. */
const MAX_HEIGHT = 30000;

type Tool = "select" | "hand" | "comment" | "interact";
type Tab = "design" | "tokens" | "code" | "comments";

interface Frame {
  page: DesignPage;
  index: number;
  el: HTMLElement;
  name: HTMLElement;
  iframe: HTMLIFrameElement;
  overlay: HTMLElement;
  hover: HTMLElement;
  chosen: HTMLElement;
  chosenTag: HTMLElement;
  pins: HTMLElement;
  row: HTMLElement;
  driver: FrameDriver | null;
  x: number;
  width: number;
  /** The frame's height when its content is shorter: the device's. */
  viewport: number;
  height: number;
  preset: string;
  /** Its content's height follows the frame's (`100vh` layouts): it keeps the device's height and scrolls. */
  fixed: boolean;
  grew: number[];
  /** The mockup as it was loaded, and as it is now. */
  baseline: string;
  html: string;
  dirty: boolean;
  stale: boolean;
  /** The layers that are open in the tree. */
  open: Set<string>;
  /** Where its comments' elements are, once looked up. */
  pinned: (Path | null)[] | null;
  drawn: number;
}

interface Snapshot {
  frame: Frame;
  html: string;
  selection: Path | null;
}

const keyOf = (path: Path) => path.join(".");

/** Build the editor in `root`. Returns whether it has unsaved changes (for a page leaving). */
export function mountDesign(
  root: HTMLElement,
  data: DesignData,
  backend: DesignBackend,
): { dirty(): boolean } {
  const frames: Frame[] = [];
  const comments = [...data.comments];
  const view: View = { x: 0, y: 0, z: 1 };
  let tool: Tool = "select";
  let tab: Tab = "design";
  let active: Frame | undefined;
  let selected: { frame: Frame; path: Path; detail: Detail } | null = null;
  let editing: Frame | null = null;
  let spaceDown = false;
  let left = window.matchMedia("(min-width: 1000px)").matches;
  /** The mockup as it was before its text began to be edited in place, to undo to if the text changes. */
  let beforeText: Snapshot | null = null;
  const undo: Snapshot[] = [];
  const redo: Snapshot[] = [];
  let lastChange = { key: "", at: 0 };
  let tree: TreeNode | null = null;
  let saving = false;

  // ---- the page ---------------------------------------------------------------------------------------------------

  const button = (label: string, title: string, run: () => void, cls = "") =>
    h("button", { type: "button", title, className: cls, onclick: run }, label);
  const TOOLS: { id: Tool; label: string; title: string }[] = [
    { id: "select", label: "Select", title: "Select and change elements (V)" },
    { id: "hand", label: "Hand", title: "Drag the canvas (H, or hold Space)" },
    { id: "comment", label: "Comment", title: "Comment on an element for the agent (C)" },
    {
      id: "interact",
      label: "Interact",
      title: "Use the mockups as pages: hover, scroll, type (I)",
    },
  ];
  const toolButtons = new Map(
    TOOLS.filter((t) => t.id !== "comment" || backend.addComment !== undefined).map((t) => [
      t.id,
      button(t.label, t.title, () => setTool(t.id)),
    ]),
  );
  const undoButton = button("Undo", "Undo (Ctrl+Z)", () => void undoOnce());
  const redoButton = button("Redo", "Redo (Ctrl+Shift+Z)", () => void redoOnce());
  const zoomLabel = button("100%", "Zoom to 100% (0)", () => zoomTo(1));
  const presetSelect = h(
    "select",
    {
      title: "The width of the selected mockup's frame",
      "aria-label": "Frame width",
      onchange: () => setPreset(presetSelect.value),
    },
    ...PRESETS.map((p) => h("option", { value: p.id }, `${p.label} · ${p.width}`)),
  );
  const status = h("span", { className: "dz-status" });
  const discardButton = button(
    "Discard",
    "Put every mockup back as it was published",
    () => void discard(),
  );
  const saveButton = button(
    "Save…",
    "Save the changed mockups as a new version (Ctrl+S)",
    () => openSave(),
    "primary",
  );
  const error = h("p", { className: "dz-error", role: "alert" });
  const notice = h("p", { className: "dz-notice" });

  const bar = h(
    "header",
    { className: "dz-bar" },
    button("☰", "Show or hide the mockups and layers", () => {
      left = !left;
      app.classList.toggle("dz-no-left", !left);
    }),
    h(
      "div",
      { className: "dz-group", role: "group", "aria-label": "Tools" },
      ...toolButtons.values(),
    ),
    h("div", { className: "dz-group" }, undoButton, redoButton),
    h(
      "div",
      { className: "dz-group" },
      button("−", "Zoom out (-)", () => zoomBy(1 / 1.25)),
      zoomLabel,
      button("+", "Zoom in (+)", () => zoomBy(1.25)),
      button("Fit", "Show every mockup (1)", () => fitAll()),
    ),
    presetSelect,
    h("span", { className: "dz-grow" }),
    status,
    data.canEdit && backend.save ? discardButton : null,
    data.canEdit && backend.save ? saveButton : null,
  );

  const mockupList = h("div", { className: "dz-list" });
  const layers = h("div", { className: "dz-layers" });
  const leftPanel = h(
    "aside",
    { className: "dz-left" },
    h(
      "div",
      { className: "dz-doc" },
      h("a", { href: data.links.home, title: "All documents" }, "‹"),
      h("strong", { title: data.title }, data.title),
      data.links.versions
        ? h(
            "a",
            { className: "dz-chip", href: data.links.versions, title: "Versions" },
            `v${data.version}`,
          )
        : h("span", { className: "dz-chip" }, `v${data.version}`),
    ),
    h("h3", {}, "Mockups"),
    mockupList,
    data.others.length > 0 ? h("h3", {}, "Pages") : null,
    data.others.length > 0
      ? h(
          "div",
          { className: "dz-list" },
          ...data.others.map((o) => h("a", { className: "dz-item", href: o.url }, o.title)),
        )
      : null,
    data.links.source
      ? h(
          "a",
          {
            className: "dz-item dz-muted",
            href: data.links.source,
            title: "Edit the pages' sources as text",
          },
          "Edit as text…",
        )
      : null,
    data.links.details
      ? h(
          "a",
          {
            className: "dz-item dz-muted",
            href: data.links.details,
            title: "The document's page: its labels, versions, feedback and sharing",
          },
          "Document details…",
        )
      : null,
    h("h3", {}, "Layers"),
    layers,
  );

  const world = h("div", { className: "dz-world" });
  const popovers = h("div", { className: "dz-popovers" });
  const canvas = h(
    "div",
    { className: "dz-canvas", tabindex: "0", "aria-label": "Mockups" },
    world,
    popovers,
  );

  const tabNames: Record<Tab, string> = {
    design: "Design",
    tokens: "Tokens",
    code: "Code",
    comments: "Comments",
  };
  const showsComments = data.canComment || comments.length > 0;
  const tabButtons = new Map(
    (Object.keys(tabNames) as Tab[])
      .filter((t) => t !== "comments" || showsComments)
      .map((t) => [t, button(tabNames[t], "", () => setTab(t))]),
  );
  const tokensPanel = h("div", { className: "dz-tokens", hidden: true });
  const code = h("textarea", {
    className: "dz-code",
    spellcheck: "false",
    hidden: true,
    "aria-label": "The mockup's HTML",
  });
  const commentsPanel = h("div", { className: "dz-comments", hidden: true });
  const rightPanel = h(
    "aside",
    { className: "dz-right" },
    h("div", { className: "dz-tabs", role: "tablist" }, ...tabButtons.values()),
  );

  const app = h(
    "div",
    { className: "dz" },
    bar,
    error,
    notice,
    h("div", { className: "dz-body" }, leftPanel, canvas, rightPanel),
  );
  if (data.links.latest) {
    notice.append(
      `This is version ${data.version}. `,
      h("a", { href: data.links.latest }, `Open the latest (v${data.latestVersion})`),
      " to save changes.",
    );
  }
  app.classList.toggle("dz-no-left", !left);
  root.replaceChildren(app);

  const report = (e: unknown) => {
    error.textContent = messageOf(e);
  };

  // Everything that changes a mockup, or reads it whole, runs in turn: a frame may answer later.
  let queue: Promise<unknown> = Promise.resolve();
  function run<T>(job: () => Promise<T>): Promise<T | undefined> {
    const next = queue.then(job).catch((e: unknown) => {
      report(e);
      return undefined;
    });
    queue = next;
    return next;
  }

  // ---- the view ---------------------------------------------------------------------------------------------------

  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
    world.style.setProperty("--z", String(view.z));
    zoomLabel.textContent = `${Math.round(view.z * 100)}%`;
  }
  function setView(next: View) {
    Object.assign(view, next);
    applyView();
  }
  const centre = () => ({ x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 });
  const zoomBy = (k: number, at = centre()) => setView(zoomAt(view, at.x, at.y, view.z * k));
  const zoomTo = (z: number) => setView(zoomAt(view, centre().x, centre().y, z));
  const boxOf = (f: Frame) => ({ x: f.x, y: 0, w: f.width, h: f.height });
  function fitAll() {
    const last = frames.at(-1);
    if (!last) return;
    const h = Math.max(...frames.map((f) => f.height));
    setView(
      fitView(
        { x: 0, y: -40, w: last.x + last.width, h: h + 40 },
        canvas.clientWidth,
        canvas.clientHeight,
        48,
      ),
    );
  }
  function focusFrame(f: Frame) {
    setView(
      fitView(
        { ...boxOf(f), y: -40, h: f.height + 40 },
        canvas.clientWidth,
        canvas.clientHeight,
        48,
      ),
    );
  }
  /** A point of the canvas (from its top left corner) in a frame's own pixels. */
  function inFrame(f: Frame, clientX: number, clientY: number) {
    const r = f.overlay.getBoundingClientRect();
    return { x: (clientX - r.left) / view.z, y: (clientY - r.top) / view.z };
  }

  // ---- frames -----------------------------------------------------------------------------------------------------

  function layout() {
    let x = 0;
    for (const f of frames) {
      f.x = x;
      x += f.width + GAP;
      f.el.style.left = `${f.x}px`;
      f.el.style.width = `${f.width}px`;
      f.el.style.height = `${f.height}px`;
      f.name.textContent = `${f.page.title} · ${f.width} × ${Math.round(f.height)}${f.fixed ? " · scrolls" : ""}`;
    }
  }

  function setHeight(f: Frame, height: number) {
    f.height = height;
    layout();
  }

  /** Makes a frame as tall as its content, or the device's height if that is taller. */
  async function fit(f: Frame, again = false) {
    if (!f.driver) return;
    if (again) {
      f.fixed = false;
      f.grew = [];
      setHeight(f, f.viewport);
    }
    if (f.fixed) return;
    const m = await f.driver.measure();
    const want = clamp(Math.max(f.viewport, m.height), f.viewport, MAX_HEIGHT);
    if (Math.abs(want - f.height) < 1) return;
    if (want > f.height) {
      // Content that grows whenever its frame does is sized by the frame (`100vh`): stop following it.
      const now = Date.now();
      f.grew = [...f.grew.filter((t) => now - t < 2000), now];
      if (f.grew.length > 3) {
        f.fixed = true;
        setHeight(f, f.viewport);
        return;
      }
    }
    setHeight(f, want);
  }

  function makeFrame(page: DesignPage, index: number): Frame {
    const iframe = h("iframe", { title: page.title, tabindex: "-1" });
    const hover = h("div", { className: "dz-box dz-hover", hidden: true });
    const chosenTag = h("span", { className: "dz-tag" });
    const chosen = h("div", { className: "dz-box dz-chosen", hidden: true }, chosenTag);
    const pins = h("div", { className: "dz-pins" });
    const overlay = h("div", { className: "dz-overlay" }, hover, chosen, pins);
    const name = h("button", { type: "button", className: "dz-name", title: "Show this mockup" });
    const el = h("div", { className: "dz-frame" }, name, iframe, overlay);
    const row = h(
      "button",
      { type: "button", className: "dz-item" },
      h("span", {}, page.title),
      h("span", { className: "dz-dot", title: "Changed" }),
    );
    const preset = PRESETS[1];
    const f: Frame = {
      page,
      index,
      el,
      name,
      iframe,
      overlay,
      hover,
      chosen,
      chosenTag,
      pins,
      row,
      driver: null,
      x: 0,
      width: preset.width,
      viewport: preset.height,
      height: preset.height,
      preset: preset.id,
      fixed: false,
      grew: [],
      baseline: page.content,
      html: page.content,
      dirty: false,
      stale: false,
      open: new Set(),
      pinned: null,
      drawn: 0,
    };
    const show = () => {
      setActive(f);
      focusFrame(f);
    };
    name.addEventListener("click", show);
    row.addEventListener("click", show);
    world.append(el);
    mockupList.append(row);
    return f;
  }

  async function start(f: Frame) {
    const driver = await backend.frame(f.iframe);
    driver.onEvent((event) => onFrameEvent(f, event));
    await driver.load(f.page.content, f.page.images);
    f.driver = driver;
    f.baseline = f.html = await driver.serialize();
    await fit(f, true);
  }

  /** Shows `html` in a frame (an undo, a draft, the code as edited). */
  async function show(f: Frame, html: string) {
    if (!f.driver) return;
    await f.driver.load(html, f.page.images);
    f.stale = true;
    f.pinned = null;
    await fit(f, true);
    if (f === active) {
      void loadTree();
      if (tab === "tokens") void loadTokens();
    }
    scheduleSync();
  }

  function onFrameEvent(f: Frame, event: FrameEvent) {
    if (event.type === "resize") {
      void fit(f).then(() => refreshBoxes(f));
    } else if (event.type === "scroll") {
      f.hover.hidden = true;
      void refreshBoxes(f);
    } else if (event.type === "edited") {
      editing = null;
      f.overlay.classList.remove("dz-editing");
      if (event.changed) {
        if (beforeText) undo.push(beforeText);
        redo.length = 0;
        renderHistory();
        f.stale = true;
        scheduleSync();
        if (f === active) void loadTree();
      }
      beforeText = null;
      lastChange = { key: "", at: 0 };
      void select(f, event.path);
    } else if (event.type === "key") {
      onKey(event.key, event.ctrl, event.shift);
    } else {
      const r = f.overlay.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      setView(
        zoomAt(
          view,
          r.left - c.left + event.x * view.z,
          r.top - c.top + event.y * view.z,
          view.z * Math.exp(-event.delta * 0.01),
        ),
      );
    }
  }

  function setPreset(id: string) {
    const preset = PRESETS.find((p) => p.id === id);
    const f = active;
    if (!preset || !f) return;
    f.preset = preset.id;
    f.width = preset.width;
    f.viewport = preset.height;
    layout();
    void fit(f, true).then(() => {
      void refreshBoxes(f);
      focusFrame(f);
    });
  }

  function setActive(f: Frame) {
    if (active === f) return;
    active = f;
    for (const other of frames) {
      other.row.classList.toggle("dz-on", other === f);
      other.el.classList.toggle("dz-active", other === f);
    }
    presetSelect.value = f.preset;
    void loadTree();
    if (tab === "tokens") void loadTokens();
    if (tab === "code") code.value = f.html;
  }

  // ---- boxes: what is under the pointer, what is selected, and where the comments are -------------------------------

  function place(el: HTMLElement, rect: Rect | null | undefined) {
    el.hidden = !rect;
    if (!rect) return;
    el.style.left = `${rect.x}px`;
    el.style.top = `${rect.y}px`;
    el.style.width = `${rect.w}px`;
    el.style.height = `${rect.h}px`;
  }

  const commentsOf = (f: Frame) => comments.filter((c) => c.page === f.page.path);

  async function refreshBoxes(f: Frame) {
    const driver = f.driver;
    if (!driver) return;
    f.drawn += 1;
    const turn = f.drawn;
    const mine = commentsOf(f);
    f.pinned ??= await Promise.all(
      mine.map((c) => (c.anchor === "" ? Promise.resolve(null) : driver.resolve(c.anchor))),
    );
    const pinned = f.pinned;
    const chosen = selected?.frame === f ? selected.path : null;
    const paths = [...(chosen ? [chosen] : []), ...pinned.filter((p) => p !== null)];
    const briefs = paths.length > 0 ? await driver.briefs(paths) : [];
    if (turn !== f.drawn) return;
    const first = chosen ? briefs.shift() : null;
    place(f.chosen, first?.rect);
    if (first)
      f.chosenTag.textContent = `${first.label} · ${Math.round(first.rect.w)} × ${Math.round(first.rect.h)}`;
    f.pins.replaceChildren(
      ...mine.flatMap((c, i) => {
        const at = pinned[i] ? briefs.shift() : null;
        if (!at) return [];
        const pin = h(
          "button",
          {
            type: "button",
            className: `dz-pin${c.sent === false ? " dz-unsent" : ""}`,
            title: `${c.user}: ${c.comment || c.quote}`,
          },
          String(comments.indexOf(c) + 1),
        );
        pin.style.left = `${at.rect.x + at.rect.w}px`;
        pin.style.top = `${at.rect.y}px`;
        pin.addEventListener("pointerdown", (e) => e.stopPropagation());
        pin.addEventListener("click", () => {
          setTab("comments");
          void select(f, pinned[i] ?? null);
          commentsPanel
            .querySelector(`[data-comment="${c.id}"]`)
            ?.scrollIntoView({ block: "nearest" });
        });
        return [pin];
      }),
    );
  }

  let hovering = 0;
  async function hoverAt(f: Frame, brief: Promise<Brief | null> | null) {
    hovering += 1;
    const turn = hovering;
    for (const other of frames) if (other !== f) other.hover.hidden = true;
    const b = brief ? await brief : null;
    if (turn === hovering) place(f.hover, b?.rect);
  }

  // ---- the selection ------------------------------------------------------------------------------------------------

  const inspector = createInspector({
    setStyle: (property, value) => {
      const s = selected;
      if (s)
        void change(s.frame, `style:${keyOf(s.path)}:${property}`, (d) =>
          d.setStyle(s.path, property, value),
        );
    },
    setText: (text) => {
      const s = selected;
      if (s) void change(s.frame, `text:${keyOf(s.path)}`, (d) => d.setText(s.path, text));
    },
    setAttr: (name, value) => {
      const s = selected;
      if (s)
        void change(s.frame, `attr:${keyOf(s.path)}:${name}`, (d) =>
          d.setAttr(s.path, name, value),
        );
    },
    select: (path) => void select(selected?.frame ?? null, path),
    hover: (path) => {
      const f = selected?.frame;
      if (f?.driver)
        void hoverAt(f, path ? f.driver.briefs([path]).then((b) => b[0] ?? null) : null);
    },
    remove: () => void removeSelected(),
    duplicate: () => void restructure((d, path) => d.duplicate(path)),
    move: (by) => void restructure((d, path) => d.move(path, by)),
    editText: () => {
      if (selected) void editText(selected.frame, selected.path);
    },
    comment: backend.addComment
      ? () => {
          const s = selected;
          if (!s) return;
          const r = s.frame.overlay.getBoundingClientRect();
          const c = canvas.getBoundingClientRect();
          compose(s.frame, s.detail, {
            x: r.left - c.left + (s.detail.rect.x + s.detail.rect.w) * view.z,
            y: r.top - c.top + s.detail.rect.y * view.z,
          });
        }
      : undefined,
  });
  rightPanel.append(inspector.el, tokensPanel, code, commentsPanel);

  async function select(f: Frame | null, path: Path | null, reveal = false) {
    const detail = f?.driver && path ? await f.driver.detail(path) : null;
    const before = selected?.frame;
    if (!f || !path || !detail) {
      selected = null;
      inspector.show(null, "");
    } else {
      selected = { frame: f, path, detail };
      setActive(f);
      inspector.show(detail, `${f.index}:${keyOf(path)}`);
      if (reveal) {
        const r = detail.rect;
        setView(
          revealView(
            view,
            { x: f.x + r.x, y: r.y, w: r.w, h: r.h },
            canvas.clientWidth,
            canvas.clientHeight,
            60,
          ),
        );
      }
    }
    if (before && before !== f) void refreshBoxes(before);
    if (f) void refreshBoxes(f);
    markTree();
  }

  /** The selected element's details again, after something about it changed. */
  async function reselect() {
    const s = selected;
    if (s) await select(s.frame, s.path);
  }

  // ---- changes, and undoing them ---------------------------------------------------------------------------------------

  function renderHistory() {
    undoButton.disabled = undo.length === 0;
    redoButton.disabled = redo.length === 0;
  }

  /** Keeps the mockup as it is before a change, unless the change carries on the last one (typing, dragging a colour). */
  async function checkpoint(f: Frame, key: string) {
    const now = Date.now();
    const carriesOn =
      key !== "" &&
      key === lastChange.key &&
      now - lastChange.at < 1000 &&
      undo.at(-1)?.frame === f;
    lastChange = { key, at: now };
    if (carriesOn || !f.driver) return;
    undo.push({
      frame: f,
      html: await f.driver.serialize(),
      selection: selected?.frame === f ? selected.path : null,
    });
    if (undo.length > 100) undo.shift();
    redo.length = 0;
    renderHistory();
  }

  /** A change to a frame's mockup that keeps its elements where they are (a style, a text, a token). */
  function change(f: Frame, key: string, apply: (d: FrameDriver) => Promise<unknown>) {
    return run(async () => {
      if (!f.driver) return;
      await checkpoint(f, key);
      await apply(f.driver);
      f.stale = true;
      scheduleSync();
      await reselect();
    });
  }

  /** A change that moves elements about: the selected element's path afterwards is what `apply` gives. */
  function restructure(apply: (d: FrameDriver, path: Path) => Promise<Path | null>) {
    const s = selected;
    if (!s) return Promise.resolve(undefined);
    return run(async () => {
      if (!s.frame.driver) return;
      await checkpoint(s.frame, "");
      const path = await apply(s.frame.driver, s.path);
      s.frame.stale = true;
      s.frame.pinned = null;
      scheduleSync();
      await select(s.frame, path ?? s.path);
      await loadTree();
    });
  }

  function removeSelected() {
    if (selected?.detail.tag === "body") return Promise.resolve(undefined);
    return restructure((d, path) => d.remove(path));
  }

  function editText(f: Frame, path: Path, x?: number, y?: number) {
    return run(async () => {
      if (!f.driver) return;
      const before: Snapshot = { frame: f, html: await f.driver.serialize(), selection: path };
      if (!(await f.driver.editText(path, x, y))) return;
      beforeText = before;
      editing = f;
      // The frame takes the pointer and the keys while its text is edited.
      f.overlay.classList.add("dz-editing");
      f.hover.hidden = true;
      f.chosen.hidden = true;
    });
  }

  async function restore(from: Snapshot[], to: Snapshot[]) {
    const snap = from.pop();
    if (!snap?.frame.driver) return;
    const f = snap.frame;
    to.push({
      frame: f,
      html: await snap.frame.driver.serialize(),
      selection: selected?.frame === f ? selected.path : null,
    });
    await show(f, snap.html);
    lastChange = { key: "", at: 0 };
    renderHistory();
    await select(f, snap.selection);
  }
  const undoOnce = () => run(() => restore(undo, redo));
  const redoOnce = () => run(() => restore(redo, undo));

  // ---- what has changed: the status, the draft, saving -----------------------------------------------------------------

  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => void run(sync), 350);
  }

  function renderStatus() {
    const changed = frames.filter((f) => f.dirty);
    for (const f of frames) f.row.classList.toggle("dz-dirty", f.dirty);
    const can = data.canEdit && backend.save !== undefined;
    status.textContent =
      changed.length === 0
        ? ""
        : can
          ? `Unsaved changes to ${changed.length === 1 ? (changed[0]?.page.title ?? "") : `${changed.length} mockups`}`
          : data.links.latest
            ? "Changes to an older version aren't saved"
            : "Your changes are only here: you can't save to this document";
    saveButton.disabled = changed.length === 0 || saving;
    discardButton.disabled = changed.length === 0 || saving;
  }

  /** Reads the changed mockups, says what is unsaved and keeps it as a draft. */
  async function sync() {
    clearTimeout(syncTimer);
    for (const f of frames) {
      if (!f.stale || !f.driver) continue;
      f.html = await f.driver.serialize();
      f.stale = false;
      f.dirty = f.html !== f.baseline;
    }
    renderStatus();
    if (tab === "code" && active && document.activeElement !== code) code.value = active.html;
    if (!backend.drafts || !data.canEdit || saved) return;
    const pages = Object.fromEntries(
      frames.filter((f) => f.dirty).map((f) => [f.page.path, f.html]),
    );
    try {
      if (Object.keys(pages).length > 0)
        await backend.drafts.save({
          version: data.version,
          pages,
          savedAt: new Date().toISOString(),
        });
      else await backend.drafts.clear();
    } catch {
      // A draft that can't be kept isn't worth interrupting the work for.
    }
  }

  function discard() {
    return run(async () => {
      for (const f of frames) if (f.dirty || f.stale) await show(f, f.page.content);
      undo.length = 0;
      redo.length = 0;
      renderHistory();
      notice.textContent = "";
      await select(null, null);
      await sync();
    });
  }

  let saved = false;
  function closePopovers() {
    popovers.replaceChildren();
  }

  function openSave(base = data.version, warning = "") {
    if (!backend.save || saveButton.disabled) return;
    const message = h("input", {
      type: "text",
      placeholder: "What changed (optional)",
      maxlength: "500",
      "aria-label": "What changed",
    });
    const failed = h("p", { className: "dz-error" }, warning);
    const go = h(
      "button",
      { type: "button", className: "primary" },
      warning ? "Save over it" : `Save as version ${data.latestVersion + 1}`,
    );
    const submit = () =>
      void run(async () => {
        if (saving || !backend.save) return;
        saving = true;
        go.disabled = true;
        try {
          await sync();
          const changed = frames.filter((f) => f.dirty);
          if (changed.length === 0) return closePopovers();
          const result = await backend.save({
            base_version: base,
            message: message.value.trim() || null,
            pages: changed.map((f) => ({
              path: f.page.path,
              title: f.page.title,
              format: "html",
              content: f.html,
            })),
          });
          if ("conflict" in result) {
            closePopovers();
            return openSave(
              result.conflict,
              `${result.message} Saving puts your mockups over that version's.`,
            );
          }
          saved = true;
          await backend.drafts?.clear();
          backend.go(result.url + urlSuffix(data.open));
        } catch (e) {
          failed.textContent = messageOf(e);
        } finally {
          saving = false;
          go.disabled = false;
          renderStatus();
        }
      });
    go.addEventListener("click", submit);
    message.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    const box = h(
      "div",
      { className: "dz-popover dz-save" },
      h("strong", {}, "Save the changed mockups"),
      message,
      failed,
      h("div", { className: "dz-row" }, button("Cancel", "", closePopovers), go),
    );
    popovers.replaceChildren(box);
    message.focus();
  }

  // ---- the layers ----------------------------------------------------------------------------------------------------

  async function loadTree() {
    const f = active;
    tree = f?.driver ? await f.driver.tree() : null;
    if (f !== active) return;
    if (f && tree && f.open.size === 0) {
      f.open.add(keyOf(tree.path));
      for (const child of tree.children) f.open.add(keyOf(child.path));
    }
    renderTree();
  }

  function renderTree() {
    const f = active;
    if (!f || !tree) return layers.replaceChildren();
    const chosen = selected?.frame === f ? keyOf(selected.path) : null;
    const rows: HTMLElement[] = [];
    const add = (node: TreeNode, depth: number) => {
      const key = keyOf(node.path);
      const open = f.open.has(key);
      const toggle = h(
        "span",
        { className: "dz-toggle" },
        node.children.length === 0 ? "" : open ? "▾" : "▸",
      );
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        if (open) f.open.delete(key);
        else f.open.add(key);
        renderTree();
      });
      const row = h(
        "div",
        {
          className: `dz-layer${key === chosen ? " dz-on" : ""}`,
          "data-key": key,
          onclick: () => void select(f, node.path, true),
          onmouseenter: () =>
            void hoverAt(
              f,
              f.driver ? f.driver.briefs([node.path]).then((b) => b[0] ?? null) : null,
            ),
          onmouseleave: () => void hoverAt(f, null),
        },
        toggle,
        h("span", { className: "dz-layer-name" }, node.label),
        node.text ? h("span", { className: "dz-muted" }, node.text) : null,
      );
      row.style.paddingLeft = `${6 + depth * 12}px`;
      rows.push(row);
      if (open) for (const child of node.children) add(child, depth + 1);
    };
    add(tree, 0);
    layers.replaceChildren(...rows);
  }

  /** Shows the selected element in the tree, opening the layers it is in. */
  function markTree() {
    const s = selected;
    if (s && s.frame === active) {
      let changed = false;
      for (let i = 1; i < s.path.length; i++) {
        const key = keyOf(s.path.slice(0, i));
        if (!s.frame.open.has(key)) {
          s.frame.open.add(key);
          changed = true;
        }
      }
      if (changed) return revealRow();
    }
    for (const row of layers.children)
      row.classList.toggle(
        "dz-on",
        s !== null && s.frame === active && row.getAttribute("data-key") === keyOf(s.path),
      );
    scrollToRow();
  }
  function revealRow() {
    renderTree();
    scrollToRow();
  }
  function scrollToRow() {
    const row = layers.querySelector<HTMLElement>(".dz-on");
    if (!row) return;
    // Not scrollIntoView, which may scroll the page too.
    const top = row.offsetTop - layers.offsetTop;
    if (top < layers.scrollTop) layers.scrollTop = top;
    else if (top + row.offsetHeight > layers.scrollTop + layers.clientHeight)
      layers.scrollTop = top + row.offsetHeight - layers.clientHeight;
  }

  // ---- tokens: the custom properties a mockup defines ------------------------------------------------------------------

  async function loadTokens() {
    const f = active;
    const groups: TokenGroup[] = f?.driver ? await f.driver.tokens() : [];
    if (f !== active || !f) return;
    if (groups.length === 0) {
      return tokensPanel.replaceChildren(
        h(
          "div",
          { className: "dz-hint" },
          h("p", {}, "This mockup defines no CSS custom properties."),
          h(
            "p",
            {},
            "Colours, fonts and sizes it defines as variables (",
            h("code", {}, ":root { --accent: … }"),
            ") can be tuned here, and everything that uses them follows.",
          ),
        ),
      );
    }
    tokensPanel.replaceChildren(
      ...groups.map((g) =>
        h(
          "section",
          {},
          h("h3", { title: g.label }, shortText(g.label, 60)),
          ...g.tokens.map((t) => {
            const set = (value: string) => {
              if (value.trim() !== "")
                void change(f, `token:${g.id}:${t.name}`, (d) => d.setToken(g.id, t.name, value));
            };
            const text = h("input", {
              type: "text",
              value: t.value,
              spellcheck: "false",
              "aria-label": t.name,
            });
            const color = colorOf(t.value);
            const swatch = color
              ? h("input", { type: "color", value: color.hex, "aria-label": `${t.name} colour` })
              : null;
            swatch?.addEventListener("input", () => {
              text.value = swatch.value;
              set(swatch.value);
            });
            text.addEventListener("input", () => {
              const c = colorOf(text.value);
              if (swatch && c) swatch.value = c.hex;
              set(text.value);
            });
            return h(
              "label",
              { className: "dz-token" },
              h("code", { title: t.name }, t.name),
              h("span", { className: "dz-color" }, swatch, text),
            );
          }),
        ),
      ),
    );
  }

  // ---- the mockup's HTML ---------------------------------------------------------------------------------------------

  let codeTimer: ReturnType<typeof setTimeout> | undefined;
  code.addEventListener("input", () => {
    clearTimeout(codeTimer);
    const f = active;
    codeTimer = setTimeout(() => {
      if (!f || f !== active) return;
      void run(async () => {
        await checkpoint(f, "code");
        await show(f, code.value);
        await reselect();
      });
    }, 500);
  });

  // ---- comments ------------------------------------------------------------------------------------------------------

  function renderComments() {
    tabButtons
      .get("comments")
      ?.replaceChildren(comments.length > 0 ? `Comments (${comments.length})` : "Comments");
    const unsent = comments.filter((c) => c.sent === false).length;
    const send = backend.send;
    const sendButton =
      send && unsent > 0
        ? button(
            `Send ${unsent} to ${send.to}`,
            "Send the comments that haven't been sent to the task",
            () => void sendComments(),
            "primary",
          )
        : null;
    commentsPanel.replaceChildren(
      comments.length === 0
        ? h(
            "div",
            { className: "dz-hint" },
            h("p", {}, "No comments on these mockups yet."),
            backend.addComment
              ? h(
                  "p",
                  {},
                  "Choose Comment (C) and click an element to say something about it to the agent.",
                )
              : null,
          )
        : "",
      ...comments.map((c, i) => {
        const f = frames.find((x) => x.page.path === c.page);
        const remove =
          c.mine && backend.deleteComment
            ? button("Delete", "", () => void deleteComment(c), "dz-link")
            : null;
        return h(
          "div",
          {
            className: "dz-comment",
            "data-comment": String(c.id),
            onclick: (e) => {
              if (!f || (e.target as Element).closest("button")) return;
              const at = f.pinned?.[commentsOf(f).indexOf(c)];
              if (at) void select(f, at, true);
              else focusFrame(f);
            },
          },
          h(
            "div",
            { className: "dz-comment-head" },
            h("span", { className: "dz-pin" }, String(i + 1)),
            h("span", { className: "dz-muted" }, f?.page.title ?? c.page),
          ),
          h("code", {}, shortText(c.quote, 120)),
          c.comment ? h("p", {}, c.comment) : null,
          h(
            "div",
            { className: "dz-comment-foot dz-muted" },
            `${c.user} · ${shortTime(c.created_at)}`,
            c.sent === true ? " · sent" : "",
            h("span", { className: "dz-grow" }),
            remove,
          ),
        );
      }),
      sendButton ?? "",
    );
  }

  async function deleteComment(c: DesignComment) {
    try {
      await backend.deleteComment?.(c.id);
      comments.splice(comments.indexOf(c), 1);
      commentsChanged();
    } catch (e) {
      report(e);
    }
  }

  async function sendComments() {
    try {
      await backend.send?.run();
      for (const c of comments) if (c.sent === false) c.sent = true;
      commentsChanged();
    } catch (e) {
      report(e);
    }
  }

  function commentsChanged() {
    renderComments();
    for (const f of frames) {
      f.pinned = null;
      void refreshBoxes(f);
    }
  }

  /** The box to write a comment on an element in, beside it. */
  function compose(f: Frame, detail: Detail, at: { x: number; y: number }) {
    if (!backend.addComment) return;
    const add = backend.addComment.bind(backend);
    const text = h("textarea", {
      rows: "3",
      placeholder: "Say what should change here",
      "aria-label": "Comment",
    });
    const failed = h("p", { className: "dz-error" });
    const go = h("button", { type: "button", className: "primary" }, "Comment");
    const submit = async () => {
      if (text.value.trim() === "" || go.disabled) return;
      go.disabled = true;
      try {
        comments.push(
          await add({
            page: f.page.path,
            quote: detail.quote,
            anchor: detail.selector,
            comment: text.value.trim(),
          }),
        );
        closePopovers();
        commentsChanged();
        setTab("comments");
      } catch (e) {
        failed.textContent = messageOf(e);
        go.disabled = false;
      }
    };
    go.addEventListener("click", () => void submit());
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
    });
    const box = h(
      "div",
      { className: "dz-popover" },
      h("code", {}, shortText(detail.quote, 90)),
      text,
      f.dirty
        ? h(
            "p",
            { className: "dz-muted" },
            "Comments are on the saved version: save your changes first if this element is new.",
          )
        : null,
      failed,
      h(
        "div",
        { className: "dz-row" },
        h("span", { className: "dz-muted" }, "Ctrl+Enter"),
        h("span", { className: "dz-grow" }),
        button("Cancel", "", closePopovers),
        go,
      ),
    );
    box.style.left = `${clamp(at.x + 12, 8, Math.max(8, canvas.clientWidth - 316))}px`;
    box.style.top = `${clamp(at.y, 8, Math.max(8, canvas.clientHeight - 200))}px`;
    popovers.replaceChildren(box);
    text.focus();
  }

  // ---- tabs and tools ------------------------------------------------------------------------------------------------

  function setTab(next: Tab) {
    tab = next;
    for (const [id, b] of tabButtons) b.setAttribute("aria-selected", String(id === tab));
    inspector.el.hidden = tab !== "design";
    tokensPanel.hidden = tab !== "tokens";
    code.hidden = tab !== "code";
    commentsPanel.hidden = tab !== "comments";
    if (tab === "tokens") void loadTokens();
    if (tab === "code") void run(sync);
  }

  function setTool(next: Tool) {
    if (!toolButtons.has(next)) return;
    tool = next;
    for (const [id, b] of toolButtons) b.setAttribute("aria-pressed", String(id === tool));
    app.dataset.tool = tool;
    for (const f of frames) f.hover.hidden = true;
  }

  // ---- the pointer ---------------------------------------------------------------------------------------------------

  const frameAt = (target: EventTarget | null): Frame | undefined => {
    const overlay = target instanceof Element ? target.closest(".dz-overlay") : null;
    return overlay ? frames.find((f) => f.overlay === overlay) : undefined;
  };
  const panning = () => tool === "hand" || spaceDown;

  canvas.addEventListener("pointerdown", (e) => {
    if (e.target instanceof Element && e.target.closest(".dz-popover, .dz-name")) return;
    closePopovers();
    if (editing) void editing.driver?.stopEdit();
    const f = frameAt(e.target);
    if (e.button === 0 && f?.driver && !panning() && (tool === "select" || tool === "comment")) {
      const at = inFrame(f, e.clientX, e.clientY);
      const c = canvas.getBoundingClientRect();
      const where = { x: e.clientX - c.left, y: e.clientY - c.top };
      const driver = f.driver;
      void driver.hit(at.x, at.y).then(async (hit) => {
        if (!hit) return;
        if (tool === "select") return select(f, hit.path);
        const detail = await driver.detail(hit.path);
        if (detail) compose(f, detail, where);
      });
      return;
    }
    if (e.button !== 0 && e.button !== 1) return;
    // Anything else drags the canvas; a click on its background that doesn't move lets go of the selection.
    e.preventDefault();
    canvas.focus({ preventScroll: true });
    const from = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    let moved = false;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("dz-dragging");
    const move = (m: PointerEvent) => {
      moved ||= Math.abs(m.clientX - from.x) + Math.abs(m.clientY - from.y) > 3;
      if (moved)
        setView({ x: from.vx + m.clientX - from.x, y: from.vy + m.clientY - from.y, z: view.z });
    };
    const up = () => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.classList.remove("dz-dragging");
      if (!moved && !f && tool === "select") void select(null, null);
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
  });

  let pointer: { f: Frame; x: number; y: number } | null = null;
  let hoverFrame = 0;
  canvas.addEventListener("pointermove", (e) => {
    const f = frameAt(e.target);
    if (
      !f?.driver ||
      panning() ||
      (tool !== "select" && tool !== "comment") ||
      canvas.classList.contains("dz-dragging")
    ) {
      if (pointer) void hoverAt(pointer.f, null);
      pointer = null;
      return;
    }
    pointer = { f, ...inFrame(f, e.clientX, e.clientY) };
    hoverFrame ||= requestAnimationFrame(() => {
      hoverFrame = 0;
      const p = pointer;
      if (p?.f.driver) void hoverAt(p.f, p.f.driver.hit(p.x, p.y));
    });
  });
  canvas.addEventListener("pointerleave", () => {
    if (pointer) void hoverAt(pointer.f, null);
    pointer = null;
  });

  canvas.addEventListener("dblclick", (e) => {
    const f = frameAt(e.target);
    if (!f?.driver || tool !== "select") return;
    const at = inFrame(f, e.clientX, e.clientY);
    void f.driver.hit(at.x, at.y).then((hit) => {
      if (hit?.hasText) void editText(f, hit.path, at.x, at.y);
    });
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      if (e.target instanceof Element && e.target.closest(".dz-popover")) return;
      e.preventDefault();
      const c = canvas.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : 1;
      if (e.ctrlKey || e.metaKey) {
        return setView(
          zoomAt(
            view,
            e.clientX - c.left,
            e.clientY - c.top,
            view.z * Math.exp(-e.deltaY * unit * 0.01),
          ),
        );
      }
      const dx = (e.shiftKey ? e.deltaY : e.deltaX) * unit;
      const dy = (e.shiftKey ? 0 : e.deltaY) * unit;
      const pan = () => setView({ x: view.x - dx, y: view.y - dy, z: view.z });
      // A frame that scrolls its own content takes the wheel while it can.
      const f = frameAt(e.target);
      if (f?.fixed && f.driver)
        void f.driver.scrollBy(dx / view.z, dy / view.z).then((scrolled) => scrolled || pan());
      else pan();
    },
    { passive: false },
  );

  // ---- the keyboard --------------------------------------------------------------------------------------------------

  function onKey(key: string, ctrl: boolean, shift: boolean): boolean {
    const k = key.length === 1 ? key.toLowerCase() : key;
    if (ctrl) {
      if (k === "z") void (shift ? redoOnce() : undoOnce());
      else if (k === "y") void redoOnce();
      else if (k === "s") openSave();
      else if (k === "d" && selected) inspectorDuplicate();
      else return false;
      return true;
    }
    if (k === "Escape") {
      if (popovers.childElementCount > 0) closePopovers();
      else if (editing) void editing.driver?.stopEdit();
      else if (tool !== "select") setTool("select");
      else if (selected) {
        const up = selected.detail.crumbs.at(-1);
        void select(up ? selected.frame : null, up?.path ?? null);
      }
    } else if (k === "v") setTool("select");
    else if (k === "h") setTool("hand");
    else if (k === "c") setTool("comment");
    else if (k === "i") setTool("interact");
    else if (k === "+" || k === "=") zoomBy(1.25);
    else if (k === "-") zoomBy(1 / 1.25);
    else if (k === "0") zoomTo(1);
    else if (k === "1") fitAll();
    else if (k === "2" && active) focusFrame(active);
    else if ((k === "Delete" || k === "Backspace") && selected) void removeSelected();
    else if (k === "Enter" && selected?.detail.hasText)
      void editText(selected.frame, selected.path);
    else return false;
    return true;
  }
  const inspectorDuplicate = () => void restructure((d, path) => d.duplicate(path));

  document.addEventListener("keydown", (e) => {
    if (!app.isConnected) return;
    const typing =
      e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]");
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === " " && !typing) {
      // Space is for dragging the canvas, not for pressing the button that was clicked last.
      if (e.target instanceof HTMLButtonElement) e.target.blur();
      spaceDown = true;
      app.classList.add("dz-space");
      e.preventDefault();
      return;
    }
    // In a field, the keys are the field's (but Esc leaves a popover, and Ctrl+S saves).
    if (
      typing &&
      !(e.key === "Escape" && popovers.childElementCount > 0) &&
      !(ctrl && e.key.toLowerCase() === "s")
    )
      return;
    if (e.altKey) return;
    if (onKey(e.key, ctrl, e.shiftKey)) e.preventDefault();
  });
  document.addEventListener("keyup", (e) => {
    if (e.key !== " ") return;
    spaceDown = false;
    app.classList.remove("dz-space");
  });
  window.addEventListener("blur", () => {
    spaceDown = false;
    app.classList.remove("dz-space");
  });

  // ---- start ---------------------------------------------------------------------------------------------------------

  data.pages.forEach((page, i) => frames.push(makeFrame(page, i)));
  layout();
  setTool("select");
  setTab("design");
  renderHistory();
  renderStatus();
  renderComments();
  inspector.show(null, "");
  const first = frames.find((f) => f.page.path === data.open) ?? frames[0];
  if (first) {
    setActive(first);
    focusFrame(first);
  }
  if (frames.length === 0) notice.textContent = "This document has no mockups.";

  void run(async () => {
    const started = await Promise.allSettled(frames.map(start));
    const failure = started.find((s) => s.status === "rejected");
    if (failure) report(failure.reason);
    layout();
    if (first) focusFrame(first);
    void loadTree();
    for (const f of frames) void refreshBoxes(f);
    // What was changed and not saved the last time, if it was this version.
    const draft = data.canEdit ? await backend.drafts?.load().catch(() => null) : null;
    if (draft && draft.version === data.version) {
      let restored = 0;
      for (const f of frames) {
        const html = draft.pages[f.page.path];
        if (html === undefined || html === f.baseline) continue;
        await show(f, html);
        restored += 1;
      }
      if (restored > 0 && !data.links.latest) {
        notice.replaceChildren(
          `Your unsaved changes from ${shortTime(draft.savedAt)} are back. `,
          button("Discard them", "", () => void discard(), "dz-link"),
        );
      }
      if (first) focusFrame(first);
    }
    await sync();
  });

  return { dirty: () => !saved && data.canEdit && frames.some((f) => f.dirty || f.stale) };
}
