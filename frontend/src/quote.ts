/**
 * Locating a quoted piece of text again: the selection is stored as the quote
 * plus a little context either side, and re-found in the page's text content.
 */

export const CONTEXT = 64;

/** Index of the occurrence of `quote` in `text` whose surroundings best match the context, or -1. */
export function findQuote(text: string, quote: string, prefix = "", suffix = ""): number {
  if (!quote) return -1;
  let best = -1;
  let bestScore = -1;
  for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) {
    const score =
      commonSuffix(text.slice(Math.max(0, i - prefix.length), i), prefix) +
      commonPrefix(text.slice(i + quote.length, i + quote.length + suffix.length), suffix);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

export interface TextIndex {
  text: string;
  nodes: { node: Text; start: number }[];
}

/** Concatenated text of `root` and where each text node starts in it. */
export function indexText(root: Node): TextIndex {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest("textarea, select, .field-status")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: TextIndex["nodes"] = [];
  let text = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n as Text, start: text.length });
    text += (n as Text).data;
  }
  return { text, nodes };
}

/** Text offset of a DOM boundary point (as found in a Range) within the index of `root`. */
export function offsetOf(index: TextIndex, root: Node, container: Node, offset: number): number {
  const before = document.createRange();
  before.setStart(root, 0);
  before.setEnd(container, offset);
  for (const { node, start } of index.nodes) {
    if (node === container) return start + offset;
    if (!before.intersectsNode(node)) return start;
  }
  return index.text.length;
}

/** DOM range covering `[start, end)` of the index text. */
export function rangeFor(index: TextIndex, start: number, end: number): Range | null {
  const locate = (pos: number, preferNext: boolean): [Text, number] | null => {
    for (let i = 0; i < index.nodes.length; i++) {
      const { node, start: s } = index.nodes[i];
      const e = s + node.data.length;
      if (pos < e || (pos === e && !preferNext) || i === index.nodes.length - 1) {
        if (pos >= s) return [node, Math.min(pos - s, node.data.length)];
      }
    }
    return null;
  };
  const a = locate(start, true);
  const b = locate(end, false);
  if (!a || !b) return null;
  const range = document.createRange();
  range.setStart(a[0], a[1]);
  range.setEnd(b[0], b[1]);
  return range;
}
