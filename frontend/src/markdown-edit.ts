/**
 * The editor's toolbar actions, as pure functions on a text and its selection, so they
 * can be tested without a page. Each returns the new text and what to select after.
 */
export interface TextState {
  value: string;
  start: number;
  end: number;
}

/**
 * Wrap the selection in `before`/`after` (bold, italic, code), or unwrap it if it is
 * wrapped already. With nothing selected, `placeholder` is inserted and selected.
 */
export function wrap(s: TextState, before: string, after: string, placeholder: string): TextState {
  const { value, start, end } = s;
  const inner = value.slice(start, end);
  if (
    value.slice(start - before.length, start) === before &&
    value.slice(end, end + after.length) === after &&
    inner !== ""
  ) {
    return {
      value: value.slice(0, start - before.length) + inner + value.slice(end + after.length),
      start: start - before.length,
      end: end - before.length,
    };
  }
  if (
    inner.length > before.length + after.length &&
    inner.startsWith(before) &&
    inner.endsWith(after)
  ) {
    const unwrapped = inner.slice(before.length, inner.length - after.length);
    return {
      value: value.slice(0, start) + unwrapped + value.slice(end),
      start,
      end: start + unwrapped.length,
    };
  }
  const text = inner === "" ? placeholder : inner;
  return {
    value: value.slice(0, start) + before + text + after + value.slice(end),
    start: start + before.length,
    end: start + before.length + text.length,
  };
}

/** A link around the selection (or "link text"), with the URL selected to type over. */
export function link(s: TextState, url = "https://"): TextState {
  const { value, start, end } = s;
  const text = value.slice(start, end) || "link text";
  const out = `[${text}](${url})`;
  const urlStart = start + text.length + 3;
  return {
    value: value.slice(0, start) + out + value.slice(end),
    start: urlStart,
    end: urlStart + url.length,
  };
}

/** The start and end of the whole lines the selection touches. */
function lineRange(value: string, start: number, end: number): [number, number] {
  const from = value.lastIndexOf("\n", start - 1) + 1;
  // A selection ending at the start of a line doesn't take that line in.
  const last = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const nl = value.indexOf("\n", last);
  return [from, nl === -1 ? value.length : nl];
}

const HEADING = /^#{1,6} /;
const LIST = /^(\s*)([-*+] \[[ xX]\] |[-*+] |\d+[.)] )/;

/**
 * Start each selected line with `prefix` ("## ", "- ", "1. ", "> ", "- [ ] "), or take it
 * off if every line has it. Headings replace a heading of another level; list markers
 * replace another kind of list marker. Numbered lists count up.
 */
export function prefixLines(s: TextState, prefix: string): TextState {
  const [from, to] = lineRange(s.value, s.start, s.end);
  const lines = s.value.slice(from, to).split("\n");
  const numbered = /^\d+\. $/.test(prefix);
  const marker = (i: number) => (numbered ? `${i + 1}. ` : prefix);
  const has = (line: string, i: number) =>
    numbered
      ? /^\d+\. /.test(line)
      : line.startsWith(marker(i)) && !(prefix === "- " && line.startsWith("- [ ] "));
  const content = lines.filter((l) => l.trim() !== "");
  const remove = content.length > 0 && lines.every((l, i) => l.trim() === "" || has(l, i));
  let n = 0;
  const out = lines.map((line) => {
    if (line.trim() === "" && lines.length > 1) return line;
    if (remove) return numbered ? line.replace(/^\d+\. /, "") : line.slice(prefix.length);
    let rest = line;
    if (prefix.startsWith("#")) rest = rest.replace(HEADING, "");
    else if (LIST.test(prefix)) rest = rest.replace(LIST, "$1");
    return marker(n++) + rest;
  });
  const text = out.join("\n");
  if (s.start === s.end && lines.length === 1) {
    // A caret stays where it was in the line's text.
    const shift = text.length - (to - from);
    const pos = Math.max(from, s.start + shift);
    return { value: s.value.slice(0, from) + text + s.value.slice(to), start: pos, end: pos };
  }
  return {
    value: s.value.slice(0, from) + text + s.value.slice(to),
    start: from,
    end: from + text.length,
  };
}

/**
 * Insert a block (a table, a code block, a component) on lines of its own, with a blank
 * line before and after it. `select` is the part of `block` to select afterwards
 * (its first occurrence); otherwise the caret goes after the block.
 */
export function insertBlock(s: TextState, block: string, select?: string): TextState {
  const { value, start, end } = s;
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead =
    before === "" ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const trail = after.startsWith("\n\n")
    ? ""
    : after.startsWith("\n")
      ? "\n"
      : after === ""
        ? "\n"
        : "\n\n";
  const at = start + lead.length;
  const out = before + lead + block + trail + after;
  const i = select === undefined ? -1 : block.indexOf(select);
  if (select !== undefined && i >= 0)
    return { value: out, start: at + i, end: at + i + select.length };
  const caret = at + block.length;
  return { value: out, start: caret, end: caret };
}

/** Insert text at the caret (replacing the selection), the caret after it. */
export function insertText(s: TextState, text: string): TextState {
  const caret = s.start + text.length;
  return {
    value: s.value.slice(0, s.start) + text + s.value.slice(s.end),
    start: caret,
    end: caret,
  };
}

/** Indent (or with `outdent`, un-indent) the selected lines by two spaces, for Tab in a list. */
export function indentLines(s: TextState, outdent: boolean): TextState {
  const [from, to] = lineRange(s.value, s.start, s.end);
  const lines = s.value.slice(from, to).split("\n");
  let first = 0;
  const out = lines.map((l, i) => {
    if (!outdent) {
      if (i === 0) first = 2;
      return `  ${l}`;
    }
    const cut = l.startsWith("  ") ? 2 : l.startsWith(" ") || l.startsWith("\t") ? 1 : 0;
    if (i === 0) first = -cut;
    return l.slice(cut);
  });
  const text = out.join("\n");
  const value = s.value.slice(0, from) + text + s.value.slice(to);
  if (s.start === s.end) {
    const pos = Math.max(from, s.start + first);
    return { value, start: pos, end: pos };
  }
  return { value, start: from, end: from + text.length };
}

/**
 * Enter at the end of a list item starts the next item (a numbered one counting up, a
 * task unchecked); on an empty item it ends the list. `null` when the caret isn't in a
 * list item, so Enter does what it always does.
 */
export function continueList(s: TextState): TextState | null {
  if (s.start !== s.end) return null;
  const from = s.value.lastIndexOf("\n", s.start - 1) + 1;
  const line = s.value.slice(from, s.start);
  const m = /^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)([.)]) |> )/.exec(line);
  if (!m) return null;
  const [whole, indent, marker, num, punct] = m;
  if (line.length === whole.length) {
    // An empty item: end the list (or the quote).
    return { value: s.value.slice(0, from) + s.value.slice(s.start), start: from, end: from };
  }
  let next = marker;
  if (num !== undefined) next = `${Number(num) + 1}${punct} `;
  else if (/\[[ xX]\]/.test(marker)) next = `${marker.slice(0, 2)}[ ] `;
  return insertText(s, `\n${indent}${next}`);
}

/** A file's name as an image name pages can use: `images/<name>.<ext>`, lower case, safe. */
export function imageName(file: string, taken: ReadonlySet<string>, type = ""): string {
  const dot = file.lastIndexOf(".");
  const fromType = type.startsWith("image/")
    ? type.slice(6).replace("jpeg", "jpg").replace(/\+.*/, "")
    : "";
  const ext =
    (dot > 0 ? file.slice(dot + 1) : fromType || "png").toLowerCase().replace(/[^a-z0-9]/g, "") ||
    "png";
  const stem =
    (dot > 0 ? file.slice(0, dot) : file)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 60) || "image";
  let name = `images/${stem}.${ext}`;
  for (let n = 2; taken.has(name); n++) name = `images/${stem}-${n}.${ext}`;
  return name;
}

/** Whether path segments make an image name (letters, digits, `.`, `_`, `-`; no `..`). */
const validName = (segs: string[]) =>
  segs.length > 0 && segs.every((s) => s !== "." && s !== ".." && /^[A-Za-z0-9._-]+$/.test(s));

/**
 * The image names an `<img src>` in page `pagePath` may refer to (relative to the page's
 * folder, then to the document's root), as the renderer resolves them.
 */
export function imageCandidates(pagePath: string, src: string): string[] {
  if (src === "" || src.startsWith("//") || src.startsWith("#") || /^[^/]*:/.test(src)) return [];
  const path = src.split(/[?#]/)[0] ?? "";
  const out: string[] = [];
  if (!path.startsWith("/")) {
    const parts = pagePath.split("/");
    parts.pop();
    let ok = true;
    for (const seg of path.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") ok = parts.pop() !== undefined && ok;
      else parts.push(seg);
    }
    if (ok && validName(parts)) out.push(parts.join("/"));
  }
  const root = path.split("/").filter((p) => p !== "" && p !== ".");
  if (validName(root) && !out.includes(root.join("/"))) out.push(root.join("/"));
  return out;
}

/** A page path as typed, as the server normalises it (`Plan/Phase 1.md` → `plan/phase-1`, nothing → `index`). */
export function pagePath(raw: string): string {
  const path = raw
    .trim()
    .toLowerCase()
    .replace(/\.(mdx?|markdown)$/, "")
    .split("/")
    .map((s) =>
      s
        .trim()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9._-]/g, ""),
    )
    .filter((s) => s !== "" && s !== "." && s !== "..")
    .join("/");
  return path === "" ? "index" : path;
}
