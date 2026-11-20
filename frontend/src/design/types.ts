/**
 * What the design editor and a mockup's frame say to each other. Everything is plain
 * JSON, so the same calls work when the editor reaches the frame's document itself (the
 * site) and when they go to a script inside the frame as messages (the Huntaway board).
 */

/** An element of a mockup: the index of each child element on the way down from `<html>`. */
export type Path = number[];

/** A box in the frame's viewport, in CSS pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Brief {
  path: Path;
  rect: Rect;
  /** How lists and labels name it: `button#buy.primary`. */
  label: string;
  /** Whether it has text of its own to edit in place. */
  hasText: boolean;
}

export interface Detail extends Brief {
  tag: string;
  /** Its ancestors from `<body>` down to its parent. */
  crumbs: { path: Path; label: string }[];
  /** Its text, when text is all it holds (so it can be edited as a field). */
  text: string | null;
  /** The attributes worth showing: `href`, `src`, `alt`, `placeholder`, `value`, `title`. */
  attrs: Record<string, string>;
  /** The used value of each property in `PROPERTIES`. */
  computed: Record<string, string>;
  /** What its `style` attribute sets, as written. */
  inline: Record<string, string>;
  /** A CSS selector that finds it, for comments. */
  selector: string;
  /** How a comment quotes it: its tag and text. */
  quote: string;
}

export interface TreeNode {
  path: Path;
  label: string;
  /** The start of its own text. */
  text: string;
  children: TreeNode[];
}

/** The custom properties one style rule sets (`:root { --accent: … }`). */
export interface TokenGroup {
  id: number;
  /** The rule's selector, with the `@media` or `@supports` it is in. */
  label: string;
  tokens: { name: string; value: string }[];
}

export interface Measure {
  /** How tall the mockup's content is. */
  height: number;
  /** How far the frame's own content can still scroll (when it is shorter than its content). */
  scrollable: boolean;
}

/** What a frame tells the editor without being asked. */
export type FrameEvent =
  /** Its content changed size. */
  | { type: "resize" }
  /** Its content scrolled. */
  | { type: "scroll" }
  /** Editing text in place ended; `changed` if the text is different. */
  | { type: "edited"; path: Path; changed: boolean }
  /** A key the editor acts on, pressed while the frame had the keyboard. */
  | { type: "key"; key: string; ctrl: boolean; shift: boolean }
  /** A zoom gesture (Ctrl + wheel, or a pinch) over the frame while it took the pointer. */
  | { type: "zoom"; x: number; y: number; delta: number };

/** The used values the inspector shows and the frame reads for it. */
export const PROPERTIES = [
  "display",
  "flex-direction",
  "justify-content",
  "align-items",
  "gap",
  "width",
  "height",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-align",
  "color",
  "background-color",
  "opacity",
  "border-top-width",
  "border-top-style",
  "border-top-color",
  "border-top-left-radius",
  "box-shadow",
] as const;

/** The calls a frame answers. */
export interface FrameCore {
  /** Shows a mockup: `images` maps what its `src`s and `url()`s name to where the image is. */
  load(html: string, images: Record<string, string>): void;
  /** The mockup as it is now, as an HTML document (its images by the names it had). */
  serialize(): string;
  measure(): Measure;
  /** The element at a point of the frame's viewport. */
  hit(x: number, y: number): Brief | null;
  briefs(paths: Path[]): (Brief | null)[];
  detail(path: Path): Detail | null;
  tree(): TreeNode | null;
  /** Sets a property in the element's `style` attribute; null takes it out. */
  setStyle(path: Path, property: string, value: string | null): void;
  setText(path: Path, text: string): void;
  setAttr(path: Path, name: string, value: string | null): void;
  /** Removes the element; its parent's path, or null if it can't be removed. */
  remove(path: Path): Path | null;
  /** Copies the element after itself; the copy's path. */
  duplicate(path: Path): Path | null;
  /** Moves the element among its siblings by `by` places; its new path. */
  move(path: Path, by: number): Path | null;
  /** Starts editing the element's text in place, with the caret at a point if given. */
  editText(path: Path, x?: number, y?: number): boolean;
  stopEdit(): void;
  tokens(): TokenGroup[];
  setToken(group: number, name: string, value: string): void;
  /** The element a selector (a comment's anchor) finds. */
  resolve(selector: string): Path | null;
  /** Scrolls the frame's own content; whether it moved. */
  scrollBy(dx: number, dy: number): boolean;
  reveal(path: Path): void;
}

/** A frame as the editor uses it: every call is answered later. */
export type FrameDriver = {
  [K in keyof FrameCore]: (...args: Parameters<FrameCore[K]>) => Promise<ReturnType<FrameCore[K]>>;
} & {
  /** Called with what the frame tells the editor. */
  onEvent(listener: (event: FrameEvent) => void): void;
};

export const CORE_METHODS: (keyof FrameCore)[] = [
  "load",
  "serialize",
  "measure",
  "hit",
  "briefs",
  "detail",
  "tree",
  "setStyle",
  "setText",
  "setAttr",
  "remove",
  "duplicate",
  "move",
  "editText",
  "stopEdit",
  "tokens",
  "setToken",
  "resolve",
  "scrollBy",
  "reveal",
];
